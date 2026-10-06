-- FireFly Lua State: Collection
-- Returns { { x = left, y = top, w = width, h = height }, ... }.
-- Assumes GetValue(p, offset) means *(uint32_t*)(p + offset), and
-- ReadPointer(base, offset) means *(uint32_t*)(*(uint32_t*)base + offset).
-- Pointers are 32-bit; do not use FireFly's 64-bit read_ptr here.

local CAMERA_BASE = 0xBF14EC
local MOB_POOL_BASE = 0xBEBFA4

local function pointer(base, offset)
    if base == 0 then return 0 end
    return read_u32(base + offset)
end

local bounds = {}

-- Share one camera sample across every box. Camera movement must not change sizes.
local camera = read_u32(CAMERA_BASE)
if camera == 0 then return nil end
local cameraX = read_i32(camera + 0xF8)
local cameraY = read_i32(camera + 0xFC)

local function rectangle(mob)
    local rect = pointer(mob, 0x4C0)
    rect = pointer(rect, 0x40)
    return pointer(rect, 0x24)
end

local function corners(rect)
    return read_i32(rect + 0x60), read_i32(rect + 0x64),
        read_i32(rect + 0x70), read_i32(rect + 0x74)
end

local function append_bounds(mob)
    if mob == 0 then return true end -- the optional original i == 0 entry may be absent
    -- Best-effort consistency check: the game keeps running during memory reads.
    -- Retry changing rectangles; report failure instead of publishing a partial list.
    -- Matching reads reduce tearing but do not make the game's updates atomic.
    for attempt = 1, 3 do
        local rect = rectangle(mob)
        if rect == 0 then return false end
        local x1, y1, x2, y2 = corners(rect)
        local checkX1, checkY1, checkX2, checkY2 = corners(rect)
        if x1 == checkX1 and y1 == checkY1 and x2 == checkX2 and y2 == checkY2
            and rectangle(mob) == rect then
            local w, h = math.abs(x2 - x1), math.abs(y2 - y1)
            if w > 0 and h > 0 then
                bounds[#bounds + 1] = {
                    x = math.min(x1, x2) - cameraX,
                    y = math.min(y1, y2) - cameraY,
                    w = w,
                    h = h
                }
            end
            return true
        end
    end
    return false
end

local pool = read_u32(MOB_POOL_BASE)
if pool == 0 then return nil end

local count = read_i32(pool + 0x24)
if count < 0 then return nil end
local list = pointer(pool, 0x28)
if list == 0 and count > 0 then return nil end

-- Walk once, then visit in the original function's descending order.
local mobs = {}
if count > 0 then
    local node = pointer(list, -0x0C)
    for i = 1, count do
        if node == 0 then return nil end
        local mob = pointer(node, 0x14)
        if mob == 0 then return nil end
        mobs[#mobs + 1] = mob
        if i < count then node = pointer(node, 0x04) end
    end
end

for i = #mobs, 1, -1 do
    if not append_bounds(mobs[i]) then return nil end
end

-- Preserve the original i == 0 case, in addition to the count list entries.
if not append_bounds(pointer(list, 0x04)) then return nil end

if read_u32(MOB_POOL_BASE) ~= pool or read_i32(pool + 0x24) ~= count
    or pointer(pool, 0x28) ~= list then return nil end

return bounds
