-- FireFly Lua State: Collection
-- Returns { { points = { { x, top }, { x, bottom } } }, ... }: every rope and ladder as a vertical line, in client
-- pixels, like the other States (map position minus the camera).
-- Assumes GetValue(p, offset) means *(uint32_t*)(p + offset), and
-- ReadPointer(base, offset) means *(uint32_t*)(*(uint32_t*)base + offset).
-- Pointers are 32-bit; do not use FireFly's 64-bit read_ptr here.
-- The ropes are an array: rope n (from 1) has its number, x and ends ROPE_STRIDE * (n - 1) after the first's,
-- and the array ends at the first entry whose number isn't the next one (a map with none reads 32 there).

local PHYSICAL_SPACE_BASE = 0xBEBFA0 -- CWvsPhysicalSpace2DBase
local CAMERA_BASE = 0xBF14EC

local OFS_ROPE1 = 0xA8
local OFS_ROPE_NUMBER = 0x1C -- then x 0x28, y1 0x2C, y2 0x30
local OFS_ROPE_X = 0x28
local OFS_ROPE_Y1 = 0x2C
local OFS_ROPE_Y2 = 0x30
local ROPE_STRIDE = 0x1C
-- A rope in one read: its number up to and including its second end
local ROPE_BYTES = OFS_ROPE_Y2 + 4 - OFS_ROPE_NUMBER

local MARGIN = 200 -- px off screen a rope may be and still be returned
local MAX_ROPES = 500

-- Reject the Windows null-pointer range and validate the entire field span.
local function validRange(address, size)
    return address >= 0x10000 and size > 0 and address <= 0x100000000 - size
end

-- One camera sample for every rope
local camera = read_u32(CAMERA_BASE)
if not validRange(camera, 0x100) then return nil end
local cameraX = read_i32(camera + 0xF8)
local cameraY = read_i32(camera + 0xFC)

local space = read_u32(PHYSICAL_SPACE_BASE)
if not validRange(space, OFS_ROPE1 + 4) then return nil end
local ropes = read_u32(space + OFS_ROPE1)
if not validRange(ropes, OFS_ROPE_Y2 + 4) then return nil end

local view = get_window_size()
local result = {}
for number = 1, MAX_ROPES do
    local at = ropes + ROPE_STRIDE * (number - 1)
    if not validRange(at + OFS_ROPE_NUMBER, ROPE_BYTES) then return nil end
    local bytes = read_bytes(at + OFS_ROPE_NUMBER, ROPE_BYTES)
    if string.unpack("<i4", bytes) ~= number then break end
    local x = string.unpack("<i4", bytes, OFS_ROPE_X - OFS_ROPE_NUMBER + 1)
    local y1 = string.unpack("<i4", bytes, OFS_ROPE_Y1 - OFS_ROPE_NUMBER + 1)
    local y2 = string.unpack("<i4", bytes, OFS_ROPE_Y2 - OFS_ROPE_NUMBER + 1)
    local top, bottom = math.min(y1, y2) - cameraY, math.max(y1, y2) - cameraY
    x = x - cameraX
    -- On screen, with a margin; kept whole, so its ends are its own
    if x >= -MARGIN and x <= view.w + MARGIN and bottom >= -MARGIN and top <= view.h + MARGIN then
        result[#result + 1] = { points = { { x, top }, { x, bottom } } }
    end
end

-- The game keeps running while it's read: the array must be the same afterwards
if read_u32(PHYSICAL_SPACE_BASE) ~= space or read_u32(space + OFS_ROPE1) ~= ropes then return nil end
return result
