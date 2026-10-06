-- FireFly Lua State: Collection
-- Returns { { x = left, y = top, w = width, h = height }, ... }.
-- Assumes GetValue(p, offset) means *(uint32_t*)(p + offset), and
-- ReadPointer(base, offset) means *(uint32_t*)(*(uint32_t*)base + offset).
-- Uses corner differences, with the user's width doubling after the first NPC.

local NPC_BASE = 0xBF5198
local CAMERA_BASE = 0xBF14EC

local function pointer(base, offset)
    if base == 0 then return 0 end
    return read_u32(base + offset)
end

local bounds = {}
local camera = read_u32(CAMERA_BASE)
if camera == 0 then return nil end
local cameraX = read_i32(camera + 0xF8)
local cameraY = read_i32(camera + 0xFC)

local function rectangle(node, index)
    local rect = pointer(node, 0x10)
    rect = pointer(rect, 0xE4)
    rect = pointer(rect, 0x40)
    rect = pointer(rect, 0x24)
    if index > 1 then
        rect = pointer(rect, 0x1C)
        rect = pointer(rect, 0x24)
    end
    return rect
end

local function corners(rect)
    return read_i32(rect + 0x60), read_i32(rect + 0x64),
        read_i32(rect + 0x70), read_i32(rect + 0x74)
end

local function append_bounds(node, index)
    -- Matching reads reduce tearing; they do not make game updates atomic.
    for attempt = 1, 3 do
        local rect = rectangle(node, index)
        if rect == 0 then return false end
        local x1, y1, x2, y2 = corners(rect)
        local checkX1, checkY1, checkX2, checkY2 = corners(rect)
        if x1 == checkX1 and y1 == checkY1 and x2 == checkX2 and y2 == checkY2
            and rectangle(node, index) == rect then
            -- Dimensions stay in world units; only the origin uses the camera.
            local width, height = math.abs(x2 - x1), math.abs(y2 - y1)
            if index > 1 then width = width * 2 end
            -- Preserve the supplied size filter. This is not an off-screen test.
            if width > 0 and height > 0 and width < 400 and height < 400 then
                bounds[#bounds + 1] = {
                    x = math.min(x1, x2) - cameraX,
                    y = math.min(y1, y2) - cameraY,
                    w = width,
                    h = height
                }
            end
            return true
        end
    end
    return false
end

local pool = read_u32(NPC_BASE)
if pool == 0 then return nil end

local count = read_i32(pool + 0x24)
if count < 0 then return nil end
local node = pointer(pool, 0x28)
local firstNode = node

for i = 1, count do
    if node == 0 then return nil end

    -- Do not publish a partial list when one NPC could not be read consistently.
    if not append_bounds(node, i) then return nil end

    if i < count then node = pointer(node, 0x04) end
end

-- A changed pool/list/count also makes the entire snapshot unavailable.
if read_u32(NPC_BASE) ~= pool or read_i32(pool + 0x24) ~= count
    or pointer(pool, 0x28) ~= firstNode then return nil end

-- A completed zero-count or fully filtered result is a genuine empty list.
return bounds
