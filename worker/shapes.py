"""Geometry over the shapes the runtime reports (points, segments and paths, in frame px, y down), for
dataset values: the nearest point of a shape to a position, on either side of it, and the surface
directly below or above it."""
import math


def finite(value):
    return type(value) in (int, float) and not isinstance(value, bool) and math.isfinite(value)


def polyline(item):
    """A shape as the points of a line through it: a point, a segment's two ends, or a path's points."""
    if not isinstance(item, dict):
        return []
    if isinstance(item.get('points'), list):
        points = [(p[0], p[1]) for p in item['points'] if isinstance(p, list) and len(p) == 2 and finite(p[0]) and finite(p[1])]
    elif all(finite(item.get(k)) for k in ('x1', 'y1', 'x2', 'y2')):
        points = [(item['x1'], item['y1']), (item['x2'], item['y2'])]
    elif finite(item.get('x')) and finite(item.get('y')):
        points = [(item['x'], item['y'])]
    else:
        points = []
    return [(float(x), float(y)) for x, y in points]


def lines_of(items):
    """Every shape of a list as a line, leaving out what isn't one."""
    return [line for line in (polyline(item) for item in items or []) if line]


def _clip(a, b, side, px):
    """The part of segment a–b on one side of the vertical line x = px (side -1 left, 1 right), or None."""
    def inside(p):
        return side == 0 or (p[0] - px) * side >= 0
    if inside(a) and inside(b):
        return a, b
    if not inside(a) and not inside(b):
        return None
    t = (px - a[0]) / (b[0] - a[0])
    cut = (px, a[1] + t * (b[1] - a[1]))
    return (a, cut) if inside(a) else (cut, b)


def nearest_on(line, anchor, side=0):
    """The point of a line nearest the anchor, on one side of it (0 either, -1 left, 1 right), or None."""
    px, py = anchor
    best, best_d = None, math.inf
    segments = list(zip(line, line[1:])) or [(line[0], line[0])]
    for a, b in segments:
        part = _clip(a, b, side, px)
        if part is None:
            continue
        (ax, ay), (bx, by) = part
        dx, dy = bx - ax, by - ay
        length = dx * dx + dy * dy
        t = 0 if length == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
        q = (ax + t * dx, ay + t * dy)
        d = math.hypot(q[0] - px, q[1] - py)
        if d < best_d:
            best, best_d = q, d
    return best


def nearest(lines, anchor, side=0):
    """The nearest point of any of the lines to the anchor, on one side of it, or None."""
    px, py = anchor
    points = [q for q in (nearest_on(line, anchor, side) for line in lines) if q is not None]
    return min(points, key=lambda q: math.hypot(q[0] - px, q[1] - py)) if points else None


def surface(lines, anchor, side):
    """The line directly below (side 1) or above (side -1) the anchor, nearest it: (dy to it, dx to its
    left end, dx to its right end), or None. In a side-view game, what's stood on and its edges."""
    px, py = anchor
    found = None
    for line in lines:
        for (ax, ay), (bx, by) in zip(line, line[1:]):
            if min(ax, bx) <= px <= max(ax, bx) and ax != bx:
                y = ay + (px - ax) / (bx - ax) * (by - ay)
                if (y - py) * side >= 0 and (found is None or abs(y - py) < abs(found[0])):
                    xs = [x for x, _ in line]
                    found = (y - py, min(xs) - px, max(xs) - px)
    return found


def count_within(lines, anchor, radius):
    """How many lines come within radius of the anchor."""
    px, py = anchor
    return sum(1 for line in lines if (q := nearest_on(line, anchor)) is not None and math.hypot(q[0] - px, q[1] - py) <= radius)


GRID_MODES = ('coverage', 'present')


def grid_values(lines, width, height, cols, rows, mode='coverage'):
    """Shapes as a grid of cols x rows cells over the screen (width x height px, origin top-left), row by
    row: in each cell, how much of it the shapes cross (coverage: their length in it over the cell's
    longer side, at most 1) or whether any does (present: 1 or 0). A point counts as a cell's width."""
    cw, ch = width / cols, height / rows
    cells = [0.0] * (cols * rows)
    step = max(0.5, min(cw, ch) / 4)

    def add(x, y, amount):
        c, r = int(x // cw), int(y // ch)
        if 0 <= c < cols and 0 <= r < rows:
            cells[r * cols + c] += amount

    for line in lines:
        if len(line) == 1:
            add(line[0][0], line[0][1], max(cw, ch))
            continue
        for (ax, ay), (bx, by) in zip(line, line[1:]):
            length = math.hypot(bx - ax, by - ay)
            n = max(1, int(math.ceil(length / step)))
            for i in range(n):  # the middle of each of n equal pieces
                t = (i + 0.5) / n
                add(ax + t * (bx - ax), ay + t * (by - ay), length / n)
    longer = max(cw, ch)
    if mode == 'present':
        return [1.0 if v > 0 else 0.0 for v in cells]
    return [min(1.0, v / longer) for v in cells]
