-- FireFly Lua State: Vector
-- Returns { x, y }: the character's position in map coordinates (its feet), the coordinates of the Map States
-- (map-objects.lua, platforms.lua, ropes.lua), so formulas such as below(platforms, p) or nearest(monsters, p)
-- measure from it. It's Mem Char Position without the camera taken off, read straight from memory, so it doesn't
-- depend on the camera at all.

local CHARACTER_BASE = 0xBEBF98
local OFS_CHARACTER_X = 0x116C
local OFS_CHARACTER_Y = 0x1170

-- Reject the Windows null-pointer range and validate the entire field span.
local function validRange(address, size)
    return address >= 0x10000 and size > 0 and address <= 0x100000000 - size
end

local character = read_u32(CHARACTER_BASE)
if not validRange(character, OFS_CHARACTER_Y + 4) then return nil end
return { x = read_i32(character + OFS_CHARACTER_X), y = read_i32(character + OFS_CHARACTER_Y) }
