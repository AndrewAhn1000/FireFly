-- FireFly Lua State: Collection
-- Returns { { points = { { x, y }, ... } }, ... }: every platform as one line, its footholds joined end to end,
-- so below_ends gives where the platform itself ends, not one foothold of it. Walls (vertical footholds) aren't
-- platforms and are left out. Client pixels, like the other States (map position minus the camera).
-- Assumes GetValue(p, offset) means *(uint32_t*)(p + offset), and
-- ReadPointer(base, offset) means *(uint32_t*)(*(uint32_t*)base + offset).
-- Pointers are 32-bit; do not use FireFly's 64-bit read_ptr here. FireFly's Lua has no base library
-- (no ipairs or pairs): lists are walked by index.
-- A map's footholds don't move: they're read once per map and kept (a State's script keeps its globals between
-- runs), and each run only moves them by the camera and leaves out the platforms far off screen.

local PHYSICAL_SPACE_BASE = 0xBEBFA0 -- CWvsPhysicalSpace2DBase
local CAMERA_BASE = 0xBF14EC
local UI_MINIMAP_BASE = 0xBED788
local OFS_MAP_ID = 0x668

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

local MARGIN = 200 -- px off screen a platform may be and still be returned
local MAX_FOOTHOLDS = 1300 -- three reads each, under FireFly's 4096 a run

-- Reject the Windows null-pointer range and validate the entire field span.
local function validRange(address, size)
    return address >= 0x10000 and size > 0 and address <= 0x100000000 - size
end

local function pointer(base, offset)
    if base == 0 then return 0 end
    return read_u32(base + offset)
end

-- One camera sample for every platform
local camera = read_u32(CAMERA_BASE)
if not validRange(camera, 0x100) then return nil end
local cameraX = read_i32(camera + 0xF8)
local cameraY = read_i32(camera + 0xFC)

local space = read_u32(PHYSICAL_SPACE_BASE)
if not validRange(space, OFS_PLATFORM1 + 4) then return nil end
local count = read_i32(space + OFS_PLATFORM_COUNT)
if count < 0 or count > MAX_FOOTHOLDS then return nil end
local first = read_u32(space + OFS_PLATFORM1)
if count > 0 and not validRange(first + OFS_NEXT_PLATFORM, 0x10) then return nil end
local minimap = read_u32(UI_MINIMAP_BASE)
local mapId = validRange(minimap, OFS_MAP_ID + 4) and read_i32(minimap + OFS_MAP_ID) or -1
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
        local left, top, right, bottom = math.min(start.x1, start.x2), math.min(start.y1, start.y2), math.max(start.x1, start.x2), math.max(start.y1, start.y2)
        while f and not used[f] do
            used[f] = true
            points[#points + 1] = { f.x2, f.y2 }
            left, right = math.min(left, f.x2), math.max(right, f.x2)
            top, bottom = math.min(top, f.y2), math.max(bottom, f.y2)
            local nextF = byAddress[f.right]
            if not walkable(nextF) or nextF.x1 ~= f.x2 or nextF.y1 ~= f.y2 then break end
            f = nextF
        end
        platforms[#platforms + 1] = { points = points, left = left, top = top, right = right, bottom = bottom }
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

-- Read again only for a new map. The game keeps running while it's read: the list must be the same afterwards.
if not FIREFLY_PLATFORMS or FIREFLY_PLATFORMS.key ~= key then
    local footholds, byAddress = readFootholds()
    if not footholds then return nil end
    if read_u32(PHYSICAL_SPACE_BASE) ~= space or read_i32(space + OFS_PLATFORM_COUNT) ~= count
        or read_u32(space + OFS_PLATFORM1) ~= first then return nil end
    FIREFLY_PLATFORMS = { key = key, platforms = joinPlatforms(footholds, byAddress) }
end

-- On screen (with a margin), moved by the camera; a platform is kept whole, so its ends are its own
local view = get_window_size()
local result = {}
local platforms = FIREFLY_PLATFORMS.platforms
for n = 1, #platforms do
    local p = platforms[n]
    if p.right - cameraX >= -MARGIN and p.left - cameraX <= view.w + MARGIN
        and p.bottom - cameraY >= -MARGIN and p.top - cameraY <= view.h + MARGIN then
        local points = {}
        for i = 1, #p.points do points[i] = { p.points[i][1] - cameraX, p.points[i][2] - cameraY } end
        result[#result + 1] = { points = points }
    end
end
return result
