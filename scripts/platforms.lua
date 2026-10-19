-- FireFly Lua State: Collection
-- Returns { { points = { { x, y }, ... } }, ... }: every platform as one line, its footholds joined end to end,
-- so below_ends gives where the platform itself ends, not one foothold of it. Walls (vertical footholds) aren't
-- platforms and are left out. Every platform of the map, in map coordinates: measure from the character's map
-- position (map-position.lua).
-- Assumes GetValue(p, offset) means *(uint32_t*)(p + offset), and
-- ReadPointer(base, offset) means *(uint32_t*)(*(uint32_t*)base + offset).
-- Pointers are 32-bit; do not use FireFly's 64-bit read_ptr here. FireFly's Lua has no base library
-- (no ipairs or pairs): lists are walked by index.
-- A map's footholds don't move: they're read once per map and kept (a State's script keeps its globals between
-- runs), and every run on that map returns the same lines. Reads the Map Id State, which must be on.

local PHYSICAL_SPACE_BASE = 0xBEBFA0 -- CWvsPhysicalSpace2DBase
local MAP_ID_STATE = "Map Id"

local OFS_PLATFORM_COUNT = 0x70
local OFS_PLATFORM1 = 0x88
local OFS_PLATFORM2 = 0x04
local OFS_NEXT_PLATFORM = -0x0C
local OFS_PUSH_PLATFORM = 0x04
local OFS_PLATFORM_CYCLE = 0x14
local OFS_PLATFORM_LEFT = 0x0C -- then top 0x10, right 0x14, bottom 0x18
local OFS_NEXT_LEFT_PLAT = 0x4C
local OFS_NEXT_RIGHT_PLAT = 0x50
-- A foothold in one read: its left x up to and including its right neighbour
local FOOTHOLD_BYTES = OFS_NEXT_RIGHT_PLAT + 4 - OFS_PLATFORM_LEFT

local MAX_FOOTHOLDS = 1300 -- three reads each, under FireFly's 4096 a run

-- Reject the Windows null-pointer range and validate the entire field span.
local function validRange(address, size)
    return address >= 0x10000 and size > 0 and address <= 0x100000000 - size
end

local function pointer(base, offset)
    if base == 0 then return 0 end
    return read_u32(base + offset)
end

local mapId = states[MAP_ID_STATE]
if mapId == nil then return nil end

local space = read_u32(PHYSICAL_SPACE_BASE)
if not validRange(space, OFS_PLATFORM1 + 4) then return nil end
local count = read_i32(space + OFS_PLATFORM_COUNT)
if count < 0 or count > MAX_FOOTHOLDS then return nil end
local first = read_u32(space + OFS_PLATFORM1)
if count > 0 and not validRange(first + OFS_NEXT_PLATFORM, 0x10) then return nil end
local key = string.format("%d:%X:%X:%d", mapId, space, first, count)

-- Every foothold of the map, walked once (keeping the node it's at), each read in one read_bytes
local function readFootholds()
    local footholds, byAddress = {}, {}
    local function add(address)
        if not validRange(address, OFS_NEXT_RIGHT_PLAT + 4) then return false end
        local bytes = read_bytes(address + OFS_PLATFORM_LEFT, FOOTHOLD_BYTES)
        local x1, y1, x2, y2 = string.unpack("<i4i4i4i4", bytes)
        local f = {
            address = address, x1 = x1, y1 = y1, x2 = x2, y2 = y2,
            left = string.unpack("<I4", bytes, OFS_NEXT_LEFT_PLAT - OFS_PLATFORM_LEFT + 1),
            right = string.unpack("<I4", bytes, OFS_NEXT_RIGHT_PLAT - OFS_PLATFORM_LEFT + 1),
        }
        footholds[#footholds + 1] = f
        byAddress[address] = f
        return true
    end
    if count == 0 then return footholds, byAddress end
    -- The first foothold, then the rest from the list
    if not add(pointer(first, OFS_PLATFORM2)) then return nil end
    local node = pointer(first, OFS_NEXT_PLATFORM)
    for i = 1, count - 1 do
        if i > 1 then node = pointer(node, OFS_PUSH_PLATFORM) end
        if not validRange(node, OFS_PLATFORM_CYCLE + 4) then return nil end
        if not add(pointer(node, OFS_PLATFORM_CYCLE)) then return nil end
    end
    return footholds, byAddress
end

-- Footholds joined into platforms: a platform runs from a left edge (no neighbour, or a wall) through each right
-- neighbour that carries on from where it ended, to a right edge
local function joinPlatforms(footholds, byAddress)
    local function walkable(f) return f ~= nil and f.x1 ~= f.x2 end
    local platforms, used = {}, {}
    local function from(start)
        local f, points = start, { { start.x1, start.y1 } }
        while f and not used[f] do
            used[f] = true
            points[#points + 1] = { f.x2, f.y2 }
            local nextF = byAddress[f.right]
            if not walkable(nextF) or nextF.x1 ~= f.x2 or nextF.y1 ~= f.y2 then break end
            f = nextF
        end
        platforms[#platforms + 1] = { points = points }
    end
    for i = 1, #footholds do -- from every left edge first
        local f = footholds[i]
        local before = byAddress[f.left]
        if walkable(f) and not used[f] and (not walkable(before) or before.x2 ~= f.x1 or before.y2 ~= f.y1) then from(f) end
    end
    for i = 1, #footholds do -- then whatever is left (a loop with no edge)
        local f = footholds[i]
        if walkable(f) and not used[f] then from(f) end
    end
    return platforms
end

-- Read again only for a new map, once it's settled: while a map changes, its id, foothold count and list can
-- disagree for a moment, so a new map is read only when the same one was seen on the run before. The game keeps
-- running while it's read: the list must be the same afterwards.
if not FIREFLY_PLATFORMS or FIREFLY_PLATFORMS.key ~= key then
    local settled = FIREFLY_PLATFORMS_SEEN == key
    FIREFLY_PLATFORMS_SEEN = key
    if not settled then return nil end
    local footholds, byAddress = readFootholds()
    if not footholds then return nil end
    if read_u32(PHYSICAL_SPACE_BASE) ~= space or read_i32(space + OFS_PLATFORM_COUNT) ~= count
        or read_u32(space + OFS_PLATFORM1) ~= first then return nil end
    FIREFLY_PLATFORMS = { key = key, lines = joinPlatforms(footholds, byAddress) }
end

return FIREFLY_PLATFORMS.lines
