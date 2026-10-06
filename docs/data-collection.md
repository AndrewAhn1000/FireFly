# Graph directory and data collection

Open **Graphs** beside Game View. Each game has a directory of named Policy and Data Collection graphs. The previous Policy Graph is migrated automatically without changing its node identifiers, so its trained versions remain associated with it. The original saved graph is retained.

Use **+ Policy**, **+ Collection**, or the folder button to create an item. Click a graph to open it. Right-click to rename, duplicate, move, export, or delete. Folders may contain either kind of graph. Drag items into folders or onto the directory background to move them to the game root. Search includes matching items inside collapsed folders. Graphs save automatically and retain their canvas position and zoom. Duplicated and newly created policies have independent policy identifiers.

Switching graphs or tabs leaves active collection running. A floating activity indicator shows active collection graphs and policy play, with Stop buttons. Running collection graphs use an immutable configuration; stop before editing. Stopping the game capture stops collection. Graphs do not automatically resume after restarting FireFly. Removing a graph does not delete its collected images, recordings, or trained models.

## Build a collection graph

Start a capture session, then add States to the graph by dragging from the States list or adding a State node. The initial collection graph already connects Trigger → Capture image → Dataset Output.

- **Condition:** Boolean checks, numeric comparisons/ranges, equality (including text), or changes in value.
- **Logic:** All, Any, or Not, over the conditions wired into it: drop a wire on its new-input connection point or use **+ input from…** (only true/false sources: Conditions, Logic, Formulas, Tables and Boolean States), and each row names what's wired into it. All and Any take any number of inputs; Not takes one, and switching to Not keeps the first. Unknown inputs remain unknown.
- **Formula:** Uses FireFly's existing formula language with named inputs, for example `count_within(enemies, player, 150) >= 3`, or `count(monsters) >= 1` (`count(list)` counts every item of a list: boxes, points or plain numbers such as animation lists). Drop a wire on the new-input connection point or use **+ input from…** to add a connected input named after its source. Edit an input name in place and press Enter or click away; its wire and references in the expression update together. Remove an input with its × button. New formulas start with `true` and no inputs. Collection formulas use the current observation snapshot; use Trigger timing instead of historical `[-k]` indices.
- **Trigger:** Fire when a condition becomes true or false, or repeat while true. Hold time requires consecutive known observations of the condition. Cooldown limits firing; repeat interval is at least 100 ms. The startup checkbox controls whether an already-satisfied condition may fire. An unknown value interrupts a hold but does not rearm an edge trigger.
- **Capture image:** Full captured window or a fixed saved region rectangle, PNG or JPEG, optional resizing. Set both resize dimensions to zero to retain the original size. A region crop is a snapshot of its saved rectangle, not a moving object crop.
- **Format Dataset:** Formats training and validation images and labels using State connections. Takes the captured image from `Capture image` (via the `Image` input handle) and dynamic connections from State nodes (`+ state input…` or drop a wire) to map observed states containing bounding boxes to object classes (e.g. `monsters` → `monster`, `npcs` → `npc`). Configures the dataset format (YOLO) and validation split percentage. Wires directly into `Dataset Output`.
- **Dataset Output:** Destination folder and relative filename pattern. When connected to a `Format Dataset` node, it saves the partitioned `images/train`, `images/val`, `labels/train`, `labels/val` directories and the `data.yaml` configuration. When connected directly to `Capture image`, it outputs raw screenshots with optional manifest/JSON metadata. One capture or format node can feed multiple outputs. **Preview images** opens its folder's saved images in the order they were saved, with their YOLO label boxes drawn on top in each class's colour and name: step with Prev/Next, the arrow keys, Home/End or the slider, show only one split, hide the labels, and see each image's path, split, trigger, save time and boxes per class ("No boxes (background)" for an empty label, "No label file" when there is none). It opens while the graph runs. **Delete image** (or the Delete key) moves the image on screen and its label and metadata files to the Recycle Bin, after asking, and deletes the table rows that screenshot added, so the moment it showed counts as new again; the next image takes its place.

- **Table:** Decides whether to take a screenshot: it's true while the values wired into it are new, and stores them once a screenshot is saved. Wire it into a Trigger (Repeat while true, e.g. every 200–500 ms, with Fire if already satisfied at start), directly or through Logic with other conditions. Wire States or Formulas into it as columns (drop a wire on the new-column connection point or use **+ column from…**), named after their source and renamable in place. Each column's **Match** says how it's compared with the rows kept so far: **Same value** compares only with rows holding this value (e.g. Map ID, Map Region), **Any new item** is new while it holds an item none of those rows held (for lists, such as the unique animation numbers on screen; a single value counts as one item), and **Any value** is kept with the row but not compared. With no rows holding the Same value columns, the values are new; otherwise they're new only if an Any new item column brings something new. With every column Any value, the table is always true. When a screenshot fired by a Trigger that depends on the table is saved while the table is true, the frame's values become a row, and stop being new: Test runs, skipped frames and failed saves store nothing (the table stays true and the Trigger tries again), and two outputs after one Trigger store one row. Table nodes with the same name share one table across every graph for the game, and tables persist across sessions (`<userData>/data/tables.sqlite`). Its footer says why (`New: mobs [3]`, `Kept already (2 rows like it)`). **Open table** lists the rows and when each was saved, 100 to a page (first, previous, next and last page buttons); filter with words that must all appear (`100000000 [2,-1]`), sort by a column (the filter and sort cover the whole table, not just the page shown), show a row's image, or delete a row or all of them (their values count as new again; images stay). It opens while the graph runs.

**Test** runs the graph on live observations without writing images. Node footers show values or the reason a value is unavailable. Recent captures list the triggers that fired. **Start Collection** writes files using the same rules. Up to eight collection graphs can run together. **Skipped** includes observations replaced while the worker was busy and screenshot requests whose source frame expired; it is not a count of game capture failures.

## Output

Supported filename tokens: `{session}`, `{sequence}`, `{timestamp}`, `{trigger}`, `{graph}`, and `{state:observation name}`. For example:

```
{session}/{state:pose}/{sequence}
```

The image extension is added automatically. State values are sanitized as single filename components. Patterns are relative to the selected dataset folder; traversal outside that folder is rejected. Name collisions get a unique suffix rather than overwriting images. Missing filename State values become `unknown`.

Metadata can be a YOLO dataset (with train/val split and `data.yaml`), JSON beside each image, a JSONL manifest per session, CSV per output/session, or images only. It includes image path, source capture timestamp, save time, trigger reasons, graph revision, original and saved dimensions, crop rectangle, selected observed State values (including validity, held age and source timestamp), and user-assigned labels. Structured values occupy JSON cells in CSV. A copy of the collection graph is saved with sessions that emit metadata. Outputs with identical image/output settings triggered by the same snapshot are combined and retain their trigger reasons.

When selecting **YOLO dataset**:
- Images are partitioned into `images/train` and `images/val` based on the configurable **Validation split (%)** (default 20%).
- Annotations are written to corresponding `labels/train` and `labels/val` text files formatted as `<class_id> <x_center> <y_center> <width> <height>`.
- Any selected State fields returning bounding boxes (either `[{x, y, w, h}, ...]` or `[{x1, y1, x2, y2}, ...]`) are automatically translated relative to any crop area and normalized into `[0, 1]`. A Lua State's boxes are in the game's client area (or its script coordinate size), while the screenshot is the whole window, title bar and borders included: the runtime saves each Lua State's `toFrame` mapping (`frame x = x + value × sx`) with its value, and labels are placed through it, so they line up with the image however the window is decorated.
- Empty label text files are written for frames with no detected objects to serve as negative background samples.
- A ready-to-train `data.yaml` is written and maintained at the dataset root pointing to `images/train`, `images/val`, and listing class names. Custom class mappings can be configured in custom labels JSON (e.g. `{"states": {"monsters": 0, "npcs": 1}}`).
- Full sidecar JSON metadata is also retained beside each label for provenance.

## Frame timing and performance

Collection uses completed observation snapshots and saves their exact raw source frames, without preview overlays. A delayed result does not cause a screenshot of the newer scene on screen. Template values held from earlier frames carry their own age. **Input age limit** controls how old a held State may be relative to the screenshot frame (default 250 ms); it does not impose the agent-play 250 ms action deadline on screenshot encoding.

The native runtime retains completed source frames while collection is enabled, bounded by 128 MiB and five seconds. Frames may expire sooner at high resolution/rates. An expired source is skipped with a visible error; the latest frame is never silently substituted. Retention works without preview polling.

Collection evaluation and image encoding/file writes run in a dedicated Python process using the existing formula evaluator and Pillow, separate from policy training. Electron keeps one executing observation and one replaceable pending observation. Encoding cannot build an unbounded backlog. Disk/encoding failures stop the affected graph and appear in its status. A write already in progress may finish after Stop; no new screenshots are started afterwards.

## Verification

- `npm run build` — TypeScript and production renderer.
- `npm run test:collection` — orchestration, source timestamps, test mode, overload and stopping.
- `.venv\Scripts\python.exe -m unittest discover -s worker -p test_collection.py` — trigger timing, unknown/stale inputs, formulas, safe paths, resizing and metadata outputs.
- `npm run test:graph-library-ui` — isolated production Electron renderer: migration, folders, navigation, autosave, and persistent activity.
- `npm run test:dataset-preview` and `npm run test:dataset-viewer-ui`: reading a dataset folder (layouts, order, paths kept inside it) and the preview in the production renderer.
- `npm run test:table-node-ui` — isolated production Electron renderer: Table → Trigger wiring, columns and their Match, the table viewer, and rewiring graphs saved with the earlier Table layout.
- `npm run test:collection-runtime` — real Windows capture of a temporary animated lab window; compares saved PNG RGB pixels against the exact original frame after delayed evaluation, without preview polling.
