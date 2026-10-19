-- FireFly Lua State: Collection
-- Returns { { points = { {left, top}, {right, top}, {right, bottom}, {left, bottom}, {left, top} }, x, y, w, h }, ... }:
-- the boxes of another State (SOURCE) in map coordinates, each as its outline, as the detector's boxes are, so
-- formulas such as nearest(monsters, p) and count_within measure to the box itself and grids cover it.
-- Make one of these per kind of object: Map Monsters (SOURCE "monsters"), Map Npcs ("npcs"), Map Portals
-- ("portals"), Map Items ("items") and Map Players ("players").
-- SOURCE gives screen positions: map position minus the Camera Position State. Adding the camera back gives the map
-- position exactly, whatever the camera reads, even (0, 0) or a value that doesn't follow the screen: FireFly works
-- out Camera Position once for everything that reads it in one evaluation, so SOURCE took off the same camera that
-- is added back here. The State that reads SOURCE stays as it is (the Screen States and dataset labels use it).
-- FireFly's Lua has no base library (no ipairs or pairs): lists are walked by index.

local SOURCE = "monsters" -- the State whose boxes these are
local CAMERA_STATE = "Camera Position"

local boxes, camera = states[SOURCE], states[CAMERA_STATE]
if boxes == nil or camera == nil or camera.x == nil or camera.y == nil then return nil end

local result = {}
for i = 1, #boxes do
    local b = boxes[i]
    if b.x and b.y and b.w and b.h then
        local left, top = b.x + camera.x, b.y + camera.y
        local right, bottom = left + b.w, top + b.h
        result[#result + 1] = {
            points = { { left, top }, { right, top }, { right, bottom }, { left, bottom }, { left, top } },
            x = left, y = top, w = b.w, h = b.h,
        }
    end
end
return result
