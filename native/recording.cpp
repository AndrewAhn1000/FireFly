#include "recording.hpp"
#include <algorithm>
#include <chrono>
#include <fstream>
#include <sqlite3.h>
namespace firefly {
namespace {
struct Db {
  sqlite3 *db = nullptr;
  explicit Db(const std::filesystem::path &root) {
    auto s = (root / "catalog.sqlite").u8string();
    int code = sqlite3_open_v2(reinterpret_cast<const char *>(s.c_str()), &db,
                               SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE |
                                   SQLITE_OPEN_FULLMUTEX,
                               nullptr);
    if (code != SQLITE_OK) {
      std::string message = db ? sqlite3_errmsg(db) : "open failed";
      if (db)
        sqlite3_close(db);
      db = nullptr;
      throw std::runtime_error(message);
    }
    sqlite3_busy_timeout(db, 2000);
  }
  ~Db() { sqlite3_close(db); }
  void exec(const char *sql) {
    char *error = nullptr;
    if (sqlite3_exec(db, sql, nullptr, nullptr, &error) != SQLITE_OK) {
      std::string message = error ? error : "SQL failed";
      sqlite3_free(error);
      throw std::runtime_error(message);
    }
  }
};
struct Statement {
  sqlite3_stmt *stmt = nullptr;
  sqlite3 *db;
  Statement(Db &connection, const char *sql) : db(connection.db) {
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
      throw std::runtime_error(sqlite3_errmsg(db));
  }
  ~Statement() { sqlite3_finalize(stmt); }
  void bind(int index, const std::string &value) {
    if (sqlite3_bind_text(stmt, index, value.c_str(),
                          static_cast<int>(value.size()),
                          SQLITE_TRANSIENT) != SQLITE_OK)
      throw std::runtime_error(sqlite3_errmsg(db));
  }
  void bind(int index, double value) {
    sqlite3_bind_double(stmt, index, value);
  }
  bool next() {
    int result = sqlite3_step(stmt);
    if (result == SQLITE_ROW)
      return true;
    if (result == SQLITE_DONE)
      return false;
    throw std::runtime_error(sqlite3_errmsg(db));
  }
  std::string text(int index) {
    auto value = sqlite3_column_text(stmt, index);
    return value ? reinterpret_cast<const char *>(value) : "";
  }
};
void identifier(const std::string &id) {
  if (id.empty() || id.size() > 80 ||
      id.find_first_not_of(
          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") !=
          std::string::npos)
    throw std::runtime_error("Invalid recording ID");
}
Json summary(Statement &s) {
  return {{"id", s.text(0)},
          {"name", s.text(1)},
          {"status", s.text(2)},
          {"durationMs", sqlite3_column_double(s.stmt, 3)},
          {"samples", sqlite3_column_int(s.stmt, 4)},
          {"invalidSamples", sqlite3_column_int(s.stmt, 5)},
          {"inputEvents", sqlite3_column_int(s.stmt, 6)},
          {"metadata", Json::parse(s.text(7))}};
}
} // namespace
Catalog::Catalog(std::filesystem::path root) : root_(std::move(root)) {
  std::filesystem::create_directories(root_ / "recordings");
  Db db(root_);
  db.exec("PRAGMA journal_mode=WAL;");
  Statement version(db, "PRAGMA user_version");
  version.next();
  if (sqlite3_column_int(version.stmt, 0) > 1)
    throw std::runtime_error(
        "Dataset database version is newer than this runtime");
  db.exec(
      "CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY,name TEXT NOT "
      "NULL,status TEXT NOT NULL,duration REAL DEFAULT 0,samples INTEGER "
      "DEFAULT 0,invalid INTEGER DEFAULT 0,inputs INTEGER DEFAULT 0,metadata "
      "TEXT NOT NULL,created REAL NOT NULL); CREATE TABLE IF NOT EXISTS "
      "samples(recording TEXT NOT NULL,seq INTEGER NOT NULL,timestamp REAL NOT "
      "NULL,data TEXT NOT NULL,PRIMARY KEY(recording,seq)); CREATE TABLE IF "
      "NOT EXISTS inputs(recording TEXT NOT NULL,seq INTEGER NOT NULL,data "
      "TEXT NOT NULL,PRIMARY KEY(recording,seq)); PRAGMA user_version=1;");
  db.exec("UPDATE recordings SET status='interrupted',samples=(SELECT count(*) "
          "FROM samples WHERE recording=recordings.id),invalid=(SELECT "
          "count(*) FROM samples WHERE recording=recordings.id AND "
          "json_extract(data,'$.valid')=0),inputs=(SELECT count(*) FROM inputs "
          "WHERE recording=recordings.id) WHERE status='recording';");
}
Json Catalog::list() const {
  Db db(root_);
  Statement query(
      db, "SELECT id,name,status,duration,samples,invalid,inputs,metadata FROM "
          "recordings ORDER BY created DESC LIMIT 200");
  Json rows = Json::array();
  while (query.next())
    rows.push_back(summary(query));
  return rows;
}
void Catalog::remove(const std::string &id) const {
  identifier(id); // also keeps the path below inside the recordings folder
  {
    Db db(root_);
    db.exec("BEGIN");
    try {
      for (const char *sql : {"DELETE FROM samples WHERE recording=?", "DELETE FROM inputs WHERE recording=?",
                              "DELETE FROM recordings WHERE id=?"}) {
        Statement statement(db, sql);
        statement.bind(1, id);
        statement.next();
      }
      db.exec("COMMIT");
    } catch (...) {
      db.exec("ROLLBACK");
      throw;
    }
  }
  std::error_code ignored;
  std::filesystem::remove_all(root_ / "recordings" / id, ignored);
}
Json Catalog::read(const std::string &id, int offset, int limit,
                   bool tail, const std::string &stream) const {
  identifier(id);
  if (offset < 0 || limit < 1 || limit > 100)
    throw std::runtime_error("Dataset page limit must be 1..100");
  if (stream != "samples" && stream != "inputs")
    throw std::runtime_error("Dataset stream must be samples or inputs");
  Db db(root_);
  // Metadata, tail offset and rows must describe the same committed batch.
  db.exec("BEGIN");
  Statement info(
      db, "SELECT id,name,status,duration,samples,invalid,inputs,metadata FROM "
          "recordings WHERE id=?");
  info.bind(1, id);
  if (!info.next())
    throw std::runtime_error("Recording not found");
  auto result = summary(info);
  const int total = result[stream == "samples" ? "samples" : "inputEvents"];
  if (tail) offset = std::max(0, total - limit);
  Statement samples(db, stream == "samples"
      ? "SELECT data,seq FROM samples WHERE recording=? ORDER BY seq LIMIT ? OFFSET ?"
      : "SELECT data,seq FROM inputs WHERE recording=? ORDER BY seq LIMIT ? OFFSET ?");
  samples.bind(1, id);
  samples.bind(2, limit);
  samples.bind(3, offset);
  result["rows"] = Json::array();
  while (samples.next()) {
    auto row = Json::parse(samples.text(0));
    row["seq"] = sqlite3_column_int(samples.stmt, 1);
    result["rows"].push_back(std::move(row));
  }
  result["offset"] = offset;
  result["total"] = total;
  result["stream"] = stream;
  db.exec("COMMIT");
  return result;
}
void Recorder::start(const std::filesystem::path &root, Json metadata) {
  if (active_)
    throw std::runtime_error("Recording is already active");
  if (thread_.joinable())
    thread_.join();
  identifier(metadata.at("id"));
  if (metadata.at("name").get<std::string>().size() > 100)
    throw std::runtime_error("Recording name too long");
  root_ = root;
  metadata_ = std::move(metadata);
  id_ = metadata_["id"];
  started_ = metadata_["started"];
  ended_ = started_;
  samples_ = 0;
  inputs_ = 0;
  invalid_ = 0;
  failed_ = false;
  error_.clear();
  queue_.clear();
  queuedBytes_ = 0;
  stopping_ = false;
  initialized_ = false;
  ending_ = "complete";
  active_ = true;
  thread_ = std::thread(&Recorder::writer, this);
  std::unique_lock lock(mutex_);
  ready_.wait(lock, [&] { return initialized_; });
  if (failed_) {
    auto message = error_;
    lock.unlock();
    stop("failed");
    throw std::runtime_error(message);
  }
}
bool Recorder::enqueue(Json item) {
  auto line = item.dump(-1, ' ', false, Json::error_handler_t::replace); // observed text may not be UTF-8
  std::lock_guard lock(mutex_);
  if (!active_ || stopping_ || failed_)
    return false;
  if (queue_.size() >= 4096 || queuedBytes_ + line.size() > 16 * 1024 * 1024) {
    failed_ = true;
    error_ = "Recording queue overflow; no silent sample dropping";
    changed_.notify_one();
    return false;
  }
  queuedBytes_ += line.size();
  queue_.push_back(std::move(line));
  changed_.notify_one();
  return true;
}
void Recorder::stop(const std::string &status) {
  {
    std::lock_guard lock(mutex_);
    stopping_ = true;
    ending_ = status;
  }
  changed_.notify_one();
  if (thread_.joinable())
    thread_.join();
  active_ = false;
}
Json Recorder::status() const {
  std::lock_guard lock(mutex_);
  return {
      {"active", active_.load()},
      {"id", id_},
      {"samples", samples_.load()},
      {"invalidSamples", invalid_.load()},
      {"inputEvents", inputs_.load()},
      {"queued", queue_.size()},
      {"durationMs", active_ ? monotonicMs() - started_ : ended_ - started_},
      {"error", error_}};
}
void Recorder::writer() {
  try {
    Db db(root_);
    auto directory = root_ / "recordings" / id_;
    if (!std::filesystem::create_directory(directory))
      throw std::runtime_error("Recording directory already exists");
    std::ofstream manifest(directory / "manifest.json", std::ios::binary),
        stream(directory / "sequence.jsonl", std::ios::binary);
    manifest << metadata_.dump(2);
    manifest.close();
    if (!manifest || !stream)
      throw std::runtime_error("Cannot create recording files");
    Statement create(db,
                     "INSERT INTO recordings(id,name,status,metadata,created) "
                     "VALUES(?,?,'recording',?,?)");
    create.bind(1, id_);
    create.bind(2, metadata_["name"].get<std::string>());
    create.bind(3, metadata_.dump());
    create.bind(4, std::chrono::duration<double, std::milli>(
                       std::chrono::system_clock::now().time_since_epoch())
                       .count());
    create.next();
    {
      std::lock_guard lock(mutex_);
      initialized_ = true;
    }
    ready_.notify_one();
    while (true) {
      std::vector<std::string> batch;
      bool finish = false;
      {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, std::chrono::milliseconds(50), [&] {
          return stopping_ || failed_ || !queue_.empty();
        });
        while (!queue_.empty() && batch.size() < 64) {
          queuedBytes_ -= queue_.front().size();
          batch.push_back(std::move(queue_.front()));
          queue_.pop_front();
        }
        finish = (stopping_ || failed_) && queue_.empty();
      }
      if (!batch.empty()) {
        db.exec("BEGIN IMMEDIATE");
        for (auto &line : batch) {
          auto row = Json::parse(line);
          bool sample = row["kind"] == "sample";
          Statement insert(
              db, sample
                      ? "INSERT INTO samples(recording,seq,timestamp,data) "
                        "VALUES(?,?,?,?)"
                      : "INSERT INTO inputs(recording,seq,data) VALUES(?,?,?)");
          insert.bind(1, id_);
          insert.bind(2, sample ? samples_ + 1 : inputs_ + 1);
          if (sample) {
            insert.bind(3, row["timestamp"].get<double>());
            insert.bind(4, line);
          } else
            insert.bind(3, line);
          insert.next();
          stream << line << '\n';
          if (sample) {
            ++samples_;
            if (!row["valid"].get<bool>())
              ++invalid_;
          } else
            ++inputs_;
        }
        stream.flush();
        if (!stream)
          throw std::runtime_error("Recording disk write failed");
        // Readers see totals and sample/input rows atomically, even while active.
        Statement progress(db, "UPDATE recordings SET duration=?,samples=?,invalid=?,inputs=? WHERE id=?");
        progress.bind(1, monotonicMs() - started_);
        progress.bind(2, samples_);
        progress.bind(3, invalid_);
        progress.bind(4, inputs_);
        progress.bind(5, id_);
        progress.next();
        db.exec("COMMIT");
      }
      if (finish)
        break;
    }
    double ended = monotonicMs();
    std::string ending;
    {
      std::lock_guard lock(mutex_);
      ended_ = ended;
      ending = failed_ ? "failed" : ending_;
    }
    Statement update(
        db, "UPDATE recordings SET "
            "status=?,duration=?,samples=?,invalid=?,inputs=? WHERE id=?");
    update.bind(1, ending);
    update.bind(2, ended - started_);
    update.bind(3, samples_);
    update.bind(4, invalid_);
    update.bind(5, inputs_);
    update.bind(6, id_);
    update.next();
  } catch (const std::exception &e) {
    std::lock_guard lock(mutex_);
    error_ = e.what();
    failed_ = true;
    ended_ = monotonicMs();
  }
  {
    std::lock_guard lock(mutex_);
    initialized_ = true;
  }
  ready_.notify_one();
  active_ = false;
}
} // namespace firefly
