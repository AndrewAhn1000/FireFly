// The last minute of the live view, kept as compressed frames so the stream can
// be paused and rewound. Frames are indexed by the time the runtime captured
// them, and each carries whatever the caller wants to show with it (T).

export interface BufferedFrame<T> { t: number; blob: Blob; extra: T }

// A clock that jumps back further than this starts a new stream
const RESET_MS = 1000;

export class FrameBuffer<T> {
  private frames: BufferedFrame<T>[] = [];
  private bytes = 0;

  constructor(private readonly maxMs = 60_000, private readonly maxBytes = 384 * 1024 * 1024) {}

  get length() { return this.frames.length; }
  get size() { return this.bytes; }
  get oldest(): number | null { return this.frames.length ? this.frames[0].t : null; }
  get newest(): number | null { return this.frames.length ? this.frames[this.frames.length - 1].t : null; }

  clear() { this.frames = []; this.bytes = 0; }

  // Frames that aren't newer than the last one are dropped. The oldest frames
  // go once the history is too long or too large, whichever comes first.
  push(t: number, blob: Blob, extra: T): boolean {
    const last = this.frames[this.frames.length - 1];
    if (last && t <= last.t) {
      if (last.t - t < RESET_MS) return false;
      this.clear();
    }
    this.frames.push({ t, blob, extra });
    this.bytes += blob.size;
    while (this.frames.length > 1 && (t - this.frames[0].t > this.maxMs || this.bytes > this.maxBytes))
      this.bytes -= this.frames.shift()!.blob.size;
    return true;
  }

  // First index whose frame is at or after t
  private lower(t: number) {
    let lo = 0, hi = this.frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // First index whose frame is after t
  private upper(t: number) {
    let lo = 0, hi = this.frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid].t <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // The frame closest to t in time
  nearest(t: number): BufferedFrame<T> | null {
    if (!this.frames.length) return null;
    const after = this.lower(t);
    if (after === 0) return this.frames[0];
    if (after === this.frames.length) return this.frames[after - 1];
    const before = this.frames[after - 1], next = this.frames[after];
    return t - before.t <= next.t - t ? before : next;
  }

  // The last frame strictly before t
  before(t: number): BufferedFrame<T> | null {
    return this.frames[this.lower(t) - 1] ?? null;
  }

  // The first frame strictly after t
  after(t: number): BufferedFrame<T> | null {
    return this.frames[this.upper(t)] ?? null;
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
