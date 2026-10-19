-- FireFly Lua Region: draws a Map State (map-objects.lua, platforms.lua or ropes.lua) on the Game View: lines through
-- their points, so platforms and ropes as lines and objects as their outlines. The State is in map coordinates; the
-- Region takes the camera off (the Camera Position State) to put it on screen, so it's only as right as Camera
-- Position is, while the State itself doesn't depend on it. Set the Region's script size to 0 × 0 (the game's
-- client area). Make one per Map State, changing STATE.
-- FireFly's Lua has no base library (no ipairs or pairs): lists are walked by index.

local STATE = "Map Platforms" -- the Map State to draw
local CAMERA_STATE = "Camera Position"

local shapes, camera = states[STATE], states[CAMERA_STATE]
if shapes == nil or camera == nil or camera.x == nil or camera.y == nil then return {} end

local lines = {}
for i = 1, #shapes do
    local from, points = shapes[i].points, {}
    for j = 1, #from do points[j] = { from[j][1] - camera.x, from[j][2] - camera.y } end
    if #points >= 2 then lines[#lines + 1] = { points = points } end
end
return lines
