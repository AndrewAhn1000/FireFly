# Lua Region coordinates and editing

Lua Regions return one box or a list of `{x, y, w, h}` boxes, with signed top-left coordinates. Corner boxes `{x1, y1, x2, y2}` are also accepted.

Click **Edit** beside a Lua Region to change its script, label, and **Script coordinate size**. Run the script, then save. The Region keeps its identity and references; Cancel leaves it unchanged. Stop recording before editing.

For coordinates from an 800×600 game, set the coordinate size to **800 × 600**. FireFly maps position and dimensions into the current game client area automatically, then into the preview. The Windows title bar and borders are accounted for separately. Scripts do not need to scale their returned boxes when the game window or preview changes size.

New Lua Regions default to 800×600. Existing Regions retain current-window units until their coordinate size is set. Zero for a dimension uses the current client dimension. The chosen size is saved with the Region. This mapping assumes the game fills its client area; internal letterboxing and camera/world-coordinate conversion are separate concerns.

Negative coordinates remain signed so off-screen objects are not reflected or shifted into view. Empty lists and empty Lua tables produce no boxes. The Region stays in the list and shows “No boxes returned”; it does not fall back to saved bounds or template-match geometry. Template capture is unavailable until a returned box exists. Lua bounds come from the script and cannot be dragged, resized, or nudged on the canvas.

This setting transforms Region overlays only. Lua State values and collection metadata retain the coordinates returned by their scripts; exporting training labels requires the corresponding coordinate transform.

## Reading Regions from Lua

Every Lua State and Region script automatically has a `regions` object. Type `regions.` for name suggestions; use Up/Down to select and Enter or Tab to insert. Escape dismisses suggestions. No picker or setup is needed.

Use `regions.Minimap`, or `regions["Mini Map"]` for names containing spaces or punctuation. Names are case-sensitive and must be unique; duplicate names produce an error and are omitted from suggestions. Lua keywords and non-ASCII names use bracket syntax too. The editor inserts valid Lua syntax; `#` is the length operator, as in `#regions.Monsters`, not a prefix for a Region name. Update name references if a Region is renamed. Existing `get_region_boxes("stable-region-id")` scripts still work and keep their identity across renames.

For example, `local boxes = regions.Monsters` reads the list and `boxes[1].x` reads the first box's x-coordinate. Check `#boxes > 0` before accessing its first entry. The namespace is refreshed on every run and is read-only; returned boxes are independent copies.

The result is always a list of `{x, y, w, h}` top-left rectangles:

- A manual Region returns its one rectangle.
- A Region following one template returns its current match, or an empty list when there is no match.
- Multi-match returns every detected box.
- A Lua Region returns all boxes from its latest successful run, including an empty list when it found none.

The boxes are converted into the caller's coordinate size, accounting for the client-area offset. For Lua Regions this uses **Script coordinate size**. Lua States use **Region reference coordinate size**; set it to 800×600 when comparing against original game coordinates. Zero uses the current client dimension. Returned tables are copies; editing them does not edit the source Region. Visibility toggles do not remove boxes from lookups.

```lua
local exclusions = regions.Minimap

local function excluded(x, y, w, h)
    for i = 1, #exclusions do
        local r = exclusions[i]
        if x < r.x + r.w and x + w > r.x
            and y < r.y + r.h and y + h > r.y then
            return true
        end
    end
    return false
end
```

Use `not excluded(x, y, w, h)` before appending a result box. The lookup uses the latest completed live snapshot, not recursive script evaluation or a guarantee of the same capture frame. Missing/deleted Regions, ambiguous names, unavailable results, dynamic results older than 250 ms, and a Lua Region referring to itself produce errors rather than silently omitting exclusions. References between Lua Regions should flow from independent sources; circular dependencies have no usable initial snapshot. These lookups also work in the runtime's recorded Lua States. They filter geometry, not screenshot pixels.

## Editing keys

When suggestions are open, Enter or Tab inserts the selected Region reference. Otherwise Tab inserts four spaces; Shift+Tab removes indentation. Selecting multiple lines indents/unindents the selected lines together. Editing or inserting a Region reference invalidates the previous Run Script result, so test again before saving.

## Holding the last displayed value

Lua and memory State displays keep their previous value while a read is pending, fails, or returns nil. A failed/nil read displays “Last value” with the reason in its tooltip; a later successful value clears that marker. Lua Region overlays also remain visible during failed/nil reads. Explicit successful `0`, `false`, and empty lists remain real updates. To signal a temporarily unavailable result, return nil rather than an empty table. Holding the display does not turn a failed result into a valid observation for recording or Region lookups.

The supplied `scripts/monsters.lua` and `scripts/npcs.lua` return nil for an incomplete snapshot: unavailable camera/pool, missing expected entries, unstable rectangle reads, or a changed pool/list/count. They publish the whole list only after these checks pass; they do not publish a partial list when one object could not be read. A completed scan with no accepted boxes still returns an empty list. Copy updated example scripts into each saved State/Region editor to apply script changes; saved scripts are not linked to files on disk.

## Inspecting values with rewind

Pause, step, or scrub back in Game View to inspect the State values and Region bounds saved with that buffered frame. Lua arrays, empty results, the State's “Last value” marker, template matches/confidence, and Region output values rewind together. The expanded Region list, bounds inspector, and box overlays use historical geometry. LIVE restores current readings; live polling, Lua Region references, and recording continue independently while the view is paused.

History holds the readings available when each buffered frame arrived. Capture and Lua/memory polling are asynchronous, so these are not guaranteed to describe the exact same instant in the game. Rewind does not re-run scripts against old memory or change saved State/Region definitions. New capture sessions start fresh history.

To investigate a position jump, select the Lua Region's affected box and expand **Lua reading · before scaling** in the Region tab. It shows that entry from the exact Region invocation that produced the displayed bounds, including extra fields such as `id`, and the script size, capture size, scale, and offset used for display. This reading rewinds with the box and is retained with it if a refresh fails. A State using identical Lua runs separately; its values are not the raw input used to draw the Region. Negative raw coordinates point upstream of scaling; a normal raw position with an unexpected display offset points to the Region conversion instead.
