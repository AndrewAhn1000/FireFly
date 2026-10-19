-- FireFly Lua State: Collection
-- Returns { { points = { { x, top }, { x, bottom } } }, ... }: every rope and ladder of the map as a vertical line,
-- in map coordinates: measure from the character's map position (map-position.lua).
-- Assumes GetValue(p, offset) means *(uint32_t*)(p + offset), and
-- ReadPointer(base, offset) means *(uint32_t*)(*(uint32_t*)base + offset).
-- Pointers are 32-bit; do not use FireFly's 64-bit read_ptr here.
-- The ropes are an array: rope n (from 1) has its number, x and ends ROPE_STRIDE * (n - 1) after the first's,
-- and the array ends at the first entry whose number isn't the next one (a map with none reads 32 there).
-- A map's ropes don't move: they're read once per map and kept (a State's script keeps its globals between runs),
-- and every run on that map returns the same lines. Reads the Map Id State, which must be on.

local PHYSICAL_SPACE_BASE = 0xBEBFA0 -- CWvsPhysicalSpace2DBase
local MAP_ID_STATE = "Map Id"

local OFS_ROPE1 = 0xA8
local OFS_ROPE_NUMBER = 0x1C -- then x 0x28, y1 0x2C, y2 0x30
local OFS_ROPE_X = 0x28
local OFS_ROPE_Y1 = 0x2C
local OFS_ROPE_Y2 = 0x30
local ROPE_STRIDE = 0x1C
-- A rope in one read: its number up to and including its second end
local ROPE_BYTES = OFS_ROPE_Y2 + 4 - OFS_ROPE_NUMBER

local MAX_ROPES = 500

-- Reject the Windows null-pointer range and validate the entire field span.
local function validRange(address, size)
    return address >= 0x10000 and size > 0 and address <= 0x100000000 - size
end

local mapId = states[MAP_ID_STATE]
if mapId == nil then return nil end

local space = read_u32(PHYSICAL_SPACE_BASE)
if not validRange(space, OFS_ROPE1 + 4) then return nil end
local ropes = read_u32(space + OFS_ROPE1)
if not validRange(ropes, OFS_ROPE_Y2 + 4) then return nil end
local key = string.format("%d:%X:%X", mapId, space, ropes)

-- Every rope of the map, one read each
local function readRopes()
    local lines = {}
    for number = 1, MAX_ROPES do
        local at = ropes + ROPE_STRIDE * (number - 1)
        if not validRange(at + OFS_ROPE_NUMBER, ROPE_BYTES) then return nil end
        local bytes = read_bytes(at + OFS_ROPE_NUMBER, ROPE_BYTES)
        if string.unpack("<i4", bytes) ~= number then break end
        local x = string.unpack("<i4", bytes, OFS_ROPE_X - OFS_ROPE_NUMBER + 1)
        local y1 = string.unpack("<i4", bytes, OFS_ROPE_Y1 - OFS_ROPE_NUMBER + 1)
        local y2 = string.unpack("<i4", bytes, OFS_ROPE_Y2 - OFS_ROPE_NUMBER + 1)
        lines[#lines + 1] = { points = { { x, math.min(y1, y2) }, { x, math.max(y1, y2) } } }
    end
    return lines
end

-- Read again only for a new map, once it's settled: while a map changes, its id and rope array can disagree for
-- a moment, so a new map is read only when the same one was seen on the run before. The game keeps running while
-- it's read: the array must be the same afterwards.
if not FIREFLY_ROPES or FIREFLY_ROPES.key ~= key then
    local settled = FIREFLY_ROPES_SEEN == key
    FIREFLY_ROPES_SEEN = key
    if not settled then return nil end
    local lines = readRopes()
    if not lines then return nil end
    if read_u32(PHYSICAL_SPACE_BASE) ~= space or read_u32(space + OFS_ROPE1) ~= ropes then return nil end
    FIREFLY_ROPES = { key = key, lines = lines }
end

return FIREFLY_ROPES.lines
