-- FireFly Lua State: Collection
-- Returns { { x = left, y = top, w = width, h = height }, ... }.
-- Uses 32-bit pointers and the supplied portal/ZRef layout and filtering rules.
-- Diagnostic mode returns Text; use it in a temporary Lua State, not a Region.
local DIAGNOSTICS = true
local PORTAL_LIST_BASE = 0xBED768
local UI_MINIMAP_BASE = 0xBED788
local CAMERA_BASE = 0xBF14EC

local OFS_PORTAL_COUNT = 0x18
local OFS_MAP_ID = 0x668
local OFS_PORTAL_TO_MAP = 0x1C
local OFS_PORTAL_TYPE = 0x08
local OFS_PORTAL_X = 0x0C
local OFS_PORTAL_Y = 0x10
local OFS_PORTAL_WIDTH = 0x14
local OFS_PORTAL_HEIGHT = 0x18
local ZREF_SIZE = 0x08
local ZREF_PTR_OFFSET = 0x04

-- Reject the Windows null-pointer range and validate the entire field span.
-- Never wrap bad pointers.
-- This checks the address range, not whether the game still owns the allocation.
local function validRange(address, size)
    return address >= 0x10000 and size > 0 and address <= 0x100000000 - size
end

local bounds = {}
local traceLines = {}
local scanned, counted, eligible, unstable, invalid, nonpositive = 0, 0, 0, 0, 0, 0
local function trace(message, ...)
    if DIAGNOSTICS and #traceLines < 80 then
        traceLines[#traceLines + 1] = string.format(message, ...)
    end
end
local function finish(reason, discard)
    if DIAGNOSTICS then
        traceLines[#traceLines + 1] = string.format(
            "exit=%s scanned=%d counted=%d eligible=%d invalid=%d unstable=%d nonpositive=%d boxes=%d discarded=%s",
            reason, scanned, counted, eligible, invalid, unstable, nonpositive, #bounds, discard and "yes" or "no")
        return table.concat(traceLines, "\n")
    end
    if discard then return {} end
    return bounds
end
-- One camera sample for every portal; dimensions never depend on the camera.
local camera = read_u32(CAMERA_BASE)
trace("camera=0x%X", camera)
if not validRange(camera, 0x100) then return finish("invalid camera") end
local cameraX = read_i32(camera + 0xF8)
local cameraY = read_i32(camera + 0xFC)
trace("cameraX=%d cameraY=%d", cameraX, cameraY)

local function dimensions(portal)
    return read_i32(portal + OFS_PORTAL_X), read_i32(portal + OFS_PORTAL_Y),
        read_i32(portal + OFS_PORTAL_WIDTH), read_i32(portal + OFS_PORTAL_HEIGHT)
end

local function append_bounds(portal, zref, toMap, pType)
    -- Best-effort consistency checks, not an atomic snapshot of game memory.
    for attempt = 1, 3 do
        if read_u32(zref + ZREF_PTR_OFFSET) ~= portal then
            unstable = unstable + 1; trace("ptr=0x%X changed before dimensions", portal); return
        end
        local x, y, width, height = dimensions(portal)
        local checkX, checkY, checkWidth, checkHeight = dimensions(portal)
        if read_u32(zref + ZREF_PTR_OFFSET) ~= portal
            or read_i32(portal + OFS_PORTAL_TO_MAP) ~= toMap
            or read_i32(portal + OFS_PORTAL_TYPE) ~= pType then
            unstable = unstable + 1; trace("ptr=0x%X pointer/type/destination changed", portal); return
        end
        if x == checkX and y == checkY and width == checkWidth and height == checkHeight then
            if width > 0 and height > 0 then
                bounds[#bounds + 1] = {
                    x = x - math.floor(width / 2) - cameraX,
                    y = y - height - cameraY,
                    w = width,
                    h = height
                }
                trace("ptr=0x%X accepted x=%d y=%d w=%d h=%d", portal,
                    x - math.floor(width / 2) - cameraX, y - height - cameraY, width, height)
            else
                nonpositive = nonpositive + 1
                trace("ptr=0x%X nonpositive dimensions w=%d h=%d", portal, width, height)
            end
            return
        end
    end
    unstable = unstable + 1
    trace("ptr=0x%X dimensions changed on all 3 attempts", portal)
end

local pool = read_u32(PORTAL_LIST_BASE)
local minimap = read_u32(UI_MINIMAP_BASE)
trace("pool=0x%X minimap=0x%X", pool, minimap)
if not validRange(pool, OFS_PORTAL_COUNT + 4) then return finish("invalid pool") end
if not validRange(minimap, OFS_MAP_ID + 4) then return finish("invalid minimap") end
local portalArray = read_u32(pool + 0x04)
local portalCount = read_u32(pool + OFS_PORTAL_COUNT)
local currentMapId = read_u32(minimap + OFS_MAP_ID)
trace("array=0x%X count=%d map=%d", portalArray, portalCount, currentMapId)
if portalCount <= 0 then return finish("portal count is zero") end
if not validRange(portalArray, portalCount * ZREF_SIZE) then return finish("invalid array range") end

-- The original C++ counts only type-2 destinations and type-7 FM entrances.
-- Other entries are scanned (and may be drawn) without consuming that count.
-- The actual allocation length is not supplied by these offsets. The runtime's
-- read/instruction limits still apply; this loop does not prove allocation bounds.
local i, realPortal = 0, 0
while realPortal < portalCount do
    -- Discard this run if the list or map changed during traversal.
    if read_u32(PORTAL_LIST_BASE) ~= pool or read_u32(UI_MINIMAP_BASE) ~= minimap then return finish("pool/minimap changed", true) end
    if read_u32(pool + 0x04) ~= portalArray or read_u32(pool + OFS_PORTAL_COUNT) ~= portalCount
        or read_u32(minimap + OFS_MAP_ID) ~= currentMapId then return finish("array/count/map changed", true) end
    local zref = portalArray + i * ZREF_SIZE
    if not validRange(zref, ZREF_SIZE) then return finish("slot address overflow", true) end
    local portal = read_u32(zref + ZREF_PTR_OFFSET)
    scanned = scanned + 1
    -- Portal contains 32-bit ints/pointers and must be aligned to four bytes.
    if validRange(portal, OFS_PORTAL_TO_MAP + 4) and portal % 4 == 0 then
        local toMap = read_i32(portal + OFS_PORTAL_TO_MAP)
        local pType = read_i32(portal + OFS_PORTAL_TYPE)
        local draw = false
        if toMap ~= 999999999 and toMap ~= currentMapId and pType == 2 then
            realPortal = realPortal + 1
            draw = true
        elseif toMap == 999999999 and pType == 7 then
            -- Free Market entrance
            realPortal = realPortal + 1
            draw = true
        elseif toMap ~= 999999999 and toMap ~= currentMapId then
            draw = true
        end
        counted = realPortal
        trace("slot=%d ptr=0x%X type=%d toMap=%d %s", i, portal, pType, toMap, draw and "eligible" or "filtered out")
        if draw then eligible = eligible + 1; append_bounds(portal, zref, toMap, pType) end
    else
        invalid = invalid + 1
        trace("slot=%d ptr=0x%X null/invalid", i, portal)
    end
    i = i + 1
end

return finish("count reached")
