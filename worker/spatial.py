"""The Spatial node: how shapes lie around a point, as columns, so a policy needn't have a formula written for every
relation. Each set of shapes (boxes or lines, in the point's coordinates, y down; an input can take several shapes
observations, measured together as one set) gives one column per field of the node.

A field is {name, pick, value, ...}: which shape it's about (`pick`: the nearest; the nearest left, right, above or
below, or ahead or behind with facing; the one with the lowest or highest of one of the shapes' own fields, `by`,
such as hp; `under`, the one directly below the point, which a player stands on or would land on; or `all` of
them), only shapes within a radius (`within`), only those where one of their fields compares to a number (`where:
{field, op, value}`), and not the one under the point (`notUnder`, so the nearest ahead is the next ledge, not the
one stood on), and what it gives (`value`: dx, dy, `forward` (dx, positive ahead), `dist`, `found`, `prop` (the
picked shape's own field `prop`, such as hp), how far its ends are (`left_end`, positive while its left end is left
of the point, `right_end`, positive while its right end is right of it, or `ahead_end` and `behind_end` with
facing: on a platform, how far there is to walk each way), or for `all`, `count` and `inside`). `fill` is what a prop reads when nothing's picked. `inputs` names the inputs it's for (all by default).
A node with no fields of its own has the presets (default_fields): the nearest's dx, dy, distance and found, the
nearest each way, how many within each radius, and whether the point is inside one.

A box is a closed outline (its first point again at the end, as the detector and the map scripts give them) and
counts as filled: from inside it, it's 0 away. Nothing here raises for an empty or missing set: nothing picked
reads as the reach (maxDistance) away, with `found` 0, so a row isn't skipped because nothing was in view."""
import math
import re

from shapes import finite, polyline

RADII = (100, 250, 500)
MAX_DISTANCE = 1000
MAX_SETS = 16
MAX_FIELDS = 32
DIRECTIONS = ('left', 'right', 'above', 'below')
FACING_DIRECTIONS = ('ahead', 'behind', 'above', 'below')
PICKS = ('nearest', 'left', 'right', 'above', 'below', 'ahead', 'behind', 'lowest', 'highest', 'under', 'all')
ENDS = ('left_end', 'right_end', 'ahead_end', 'behind_end')
ONE_VALUES = ('dx', 'dy', 'forward', 'dist', 'found', 'prop', *ENDS)  # of one picked shape
# How far above the point a line can be and still be the one under it: a player's feet read a pixel or two into
# the platform they stand on
UNDER_SLACK = 8
ALL_VALUES = ('count', 'inside')                                 # of all of them
OPS = {'<': lambda a, b: a < b, '<=': lambda a, b: a <= b, '>': lambda a, b: a > b, '>=': lambda a, b: a >= b,
       '==': lambda a, b: a == b, '!=': lambda a, b: a != b}
# What a shape's outline is made from, rather than fields of its own
GEOMETRY = {'points', 'x', 'y', 'w', 'h', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'area'}


def fmt_radius(r):
    return str(int(r)) if float(r).is_integer() else str(r)


def default_fields(radii=RADII, facing=False):
    """The presets, the columns the node always made: the nearest's dx (positive ahead with facing), dy, distance
    and found; the nearest each way; how many within each radius; and whether the point is inside one."""
    return ([{'name': 'nearest.dx', 'pick': 'nearest', 'value': 'forward' if facing else 'dx'},
             {'name': 'nearest.dy', 'pick': 'nearest', 'value': 'dy'},
             {'name': 'nearest.dist', 'pick': 'nearest', 'value': 'dist'},
             {'name': 'nearest.found', 'pick': 'nearest', 'value': 'found'}]
            + [{'name': d, 'pick': d, 'value': 'dist'} for d in (FACING_DIRECTIONS if facing else DIRECTIONS)]
            + [{'name': f'within.{fmt_radius(r)}', 'pick': 'all', 'within': r, 'value': 'count'} for r in sorted(radii)]
            + [{'name': 'inside', 'pick': 'all', 'value': 'inside'}])


def applies(field, alias):
    return field.get('inputs') is None or alias in field['inputs']


def field_columns(name, aliases, fields):
    """Every column a Spatial node makes, in order: per input, name.input.field for each field it's for."""
    return [f'{name}.{alias}.{f["name"]}' for alias in aliases for f in fields if applies(f, alias)]


def columns(name, aliases, radii, facing):
    """The presets' columns (see default_fields)."""
    return field_columns(name, aliases, default_fields(radii, facing))


# How an input's shapes of x, y, w, h alone (no points) are read: as a point at (x, y), which is what any shape of
# x and y alone is; as the box from its top-left corner (what a script's {x, y, w, h} means); as the box round its
# centre (what a template match's means); or as the point at its bottom centre (x, y its top-left corner)
READS = ('point', 'corner', 'centre', 'bottom')


def read_as(items, read):
    """An input's shapes as its `read` says (see READS): those of x, y, w, h alone given their outline, or their
    bottom centre, keeping their own fields; any other shape as it is."""
    if read == 'point':
        return items
    out = []
    for item in items or []:
        if isinstance(item, dict) and 'points' not in item and all(finite(item.get(k)) for k in ('x', 'y', 'w', 'h')):
            x, y, w, h = (float(item[k]) for k in ('x', 'y', 'w', 'h'))
            if read == 'centre':
                x, y = x - w / 2, y - h / 2
            item = {**item, 'points': [[x + w / 2, y + h]] if read == 'bottom'
                    else [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]}
        out.append(item)
    return out


def shapes_of(items):
    """Each shape as (points, closed): closed when its outline ends where it began (a box), a filled area."""
    return [(points, closed) for points, closed, _ in _shapes(items)]


def _shapes(items):
    out = []
    for item in items or []:
        points = polyline(item)
        if points:
            out.append((points, len(points) >= 4 and points[0] == points[-1], item))
    return out


def number_of(item, key):
    """One of a shape's own fields as a number (true/false as 1/0), or None if it hasn't that field as a number."""
    value = item.get(key) if isinstance(item, dict) else None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    return float(value) if finite(value) else None


def fields_of(items):
    """The names of the number fields the shapes carry beside their outline, such as hp."""
    return sorted({k for item in items or [] if isinstance(item, dict) for k in item
                   if k not in GEOMETRY and number_of(item, k) is not None})


def _inside(points, px, py):
    """Whether (px, py) is inside a closed outline (even-odd rule), or on it."""
    hit = False
    for (ax, ay), (bx, by) in zip(points, points[1:]):
        if (ay > py) != (by > py):
            x = ax + (py - ay) * (bx - ax) / (by - ay)
            if x == px:
                return True
            if x > px:
                hit = not hit
    return hit


def _half(a, b, axis, side, at):
    """The part of segment a–b where coordinate `axis` is on `side` of `at` (side -1 less, 1 more), or None."""
    da, db = (a[axis] - at) * side, (b[axis] - at) * side
    if da >= 0 and db >= 0:
        return a, b
    if da < 0 and db < 0:
        return None
    t = (at - a[axis]) / (b[axis] - a[axis])
    cut = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
    return (a, cut) if da >= 0 else (cut, b)


def _closest(a, b, px, py):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
    return ax + t * dx, ay + t * dy


# Each direction as (axis, side) in screen coordinates: left is x less, below is y more
_HALVES = {'left': (0, -1), 'right': (0, 1), 'above': (1, -1), 'below': (1, 1)}


class _Shape:
    """A shape within reach of the point: its index, outline, own fields, nearest point (distance, x, y), whether
    the point is inside it, and its nearest point each way, worked out when first asked for."""

    def __init__(self, index, points, closed, item, point):
        self.index, self.points, self.closed, self.item, self.point = index, points, closed, item, point
        px, py = point
        self.segments = list(zip(points, points[1:])) or [(points[0], points[0])]
        self.inside = closed and _inside(points, px, py)
        if self.inside:
            self.best = (0.0, px, py)
        else:
            self.best = None
            for a, b in self.segments:
                qx, qy = _closest(a, b, px, py)
                d = math.hypot(qx - px, qy - py)
                if self.best is None or d < self.best[0]:
                    self.best = (d, qx, qy)
        self._ways = {}
        self._under = False

    def under(self):
        """Where the shape is directly below the point (distance, x, y), or None: the first line under it going
        straight down, a few px above it allowed (UNDER_SLACK). Upright lines (ropes) are never under it."""
        if self._under is False:
            px, py = self.point
            found = None
            for (ax, ay), (bx, by) in self.segments:
                if ax == bx or not min(ax, bx) <= px <= max(ax, bx):
                    continue
                y = ay + (px - ax) * (by - ay) / (bx - ax)
                if y >= py - UNDER_SLACK and (found is None or y - py < found[0]):
                    found = (y - py, px, y)
            self._under = None if found is None else (max(0.0, found[0]), found[1], found[2])
        return self._under

    def way(self, name):
        """The nearest point on one side of the point (left, right, above or below), or None if none is there."""
        if name not in self._ways:
            if self.inside:
                self._ways[name] = self.best
            else:
                px, py = self.point
                axis, side = _HALVES[name]
                found = None
                for a, b in self.segments:
                    part = _half(a, b, axis, side, self.point[axis])
                    if part is not None:
                        qx, qy = _closest(*part, px, py)
                        d = math.hypot(qx - px, qy - py)
                        if found is None or d < found[0]:
                            found = (d, qx, qy)
                self._ways[name] = found
        return self._ways[name]


def area_of(field, point, facing_left):
    """A field's area as a box [left, top, right, bottom] around the point: so far ahead, behind, up and down, ahead
    the way it faces (to the right without facing). None without one."""
    a = field.get('area')
    if not a:
        return None
    px, py = point
    left, right = (a['ahead'], a['behind']) if facing_left else (a['behind'], a['ahead'])
    return [px - left, py - a['above'], px + right, py + a['below']]


def _segment_meets(a, b, box):
    """Whether segment a–b reaches into box (Liang–Barsky)."""
    (x0, y0), (x1, y1) = a, b
    t0, t1, dx, dy = 0.0, 1.0, x1 - x0, y1 - y0
    for p, q in ((-dx, x0 - box[0]), (dx, box[2] - x0), (-dy, y0 - box[1]), (dy, box[3] - y0)):
        if p == 0:
            if q < 0:
                return False
        else:
            t = q / p
            if p < 0:
                t0 = max(t0, t)
            else:
                t1 = min(t1, t)
            if t0 > t1:
                return False
    return True


def touches(shape, box):
    """Whether any part of a shape is in box: a point of it, a stretch of a line through it, or, a box being
    filled, the box itself round the area."""
    points = shape.points
    if any(box[0] <= x <= box[2] and box[1] <= y <= box[3] for x, y in points):
        return True
    if any(_segment_meets(a, b, box) for a, b in zip(points, points[1:])):
        return True
    return shape.closed and _inside(points, box[0], box[1])


def _passes(field, shape, box=None):
    where = field.get('where')
    if where:
        have = number_of(shape.item, where['field'])
        if have is None or not OPS[where['op']](have, where['value']):
            return False
    if box is not None and not touches(shape, box):
        return False
    return field.get('within') is None or shape.best[0] <= field['within']


def evaluate(items, point, facing_left, fields, max_distance=MAX_DISTANCE):
    """One set's columns for these fields (in order), and what each is about, for the picture: per field, the
    picked shape and where it ends ({end: [x, y, distance], shape}) or the shapes counted or the point is inside
    ({shapes: [...]}), and each shape's distance (None beyond the reach, which isn't measured). facing_left is
    True or False when facing is known (ahead, behind and forward need it)."""
    px, py = point
    # Shapes further than anything is measured to are left out: further than the reach, a radius, or an area's corner
    reach = max([max_distance] + [f['within'] for f in fields if f.get('within') is not None]
                + [math.hypot(max(f['area']['ahead'], f['area']['behind']), max(f['area']['above'], f['area']['below']))
                   for f in fields if f.get('area')])
    shapes, distances = [], []
    for index, (points, closed, item) in enumerate(_shapes(items)):
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        # A shape further than anything is measured to can't change a value: left out (whole maps of platforms)
        if math.hypot(max(min(xs) - px, 0, px - max(xs)), max(min(ys) - py, 0, py - max(ys))) > reach:
            distances.append(None)
            continue
        shape = _Shape(index, points, closed, item, point)
        shapes.append(shape)
        distances.append(shape.best[0])
    values, about = [], {}
    # The shape under the point (the one stood on), for fields that leave it out
    unders = [(s.under(), s) for s in shapes if any(f.get('notUnder') for f in fields)]
    unders = [(u, s) for u, s in unders if u is not None]
    stood_on = min(unders, key=lambda us: us[0][0])[1] if unders else None
    for f in fields:
        box = area_of(f, point, facing_left)
        chosen = [s for s in shapes if _passes(f, s, box) and not (f.get('notUnder') and s is stood_on)]
        pick, value = f['pick'], f['value']
        if pick == 'all':
            hits = chosen if value == 'count' else [s for s in chosen if s.inside]
            values.append(float(len(hits)) if value == 'count' else 1.0 if hits else 0.0)
            about[f['name']] = {'shapes': [s.index for s in hits]}
            continue
        if pick in ('ahead', 'behind'):
            pick = ('left' if facing_left else 'right') if pick == 'ahead' else ('right' if facing_left else 'left')
        if pick in _HALVES or pick == 'under':
            ends = [(s.under() if pick == 'under' else s.way(pick), s) for s in chosen]
            ends = [(e, s) for e, s in ends if e is not None]
        else:
            ends = [(s.best, s) for s in chosen]
            if pick in ('lowest', 'highest'):
                ranked = [(number_of(s.item, f['by']), e, s) for e, s in ends]
                ranked = [r for r in ranked if r[0] is not None and r[1][0] <= max_distance]
                sign = 1 if pick == 'lowest' else -1
                ends = [(e, s) for _, e, s in sorted(ranked, key=lambda r: (sign * r[0], r[1][0]))[:1]]
        end, shape = min(ends, key=lambda es: es[0][0]) if ends else (None, None)
        if end is not None and end[0] > max_distance:
            end, shape = None, None
        if end is None:
            reads_as_reach = value == 'dist' or value in ENDS
            values.append(float(max_distance) if reads_as_reach else float(f.get('fill', 0)) if value == 'prop' else 0.0)
            about[f['name']] = None
            continue
        if value in ENDS:
            # How far the picked shape reaches each way from the point, to its leftmost or rightmost point
            side = value[:-4]
            if side in ('ahead', 'behind'):
                side = ('left' if facing_left else 'right') if side == 'ahead' else ('right' if facing_left else 'left')
            tip = min(shape.points) if side == 'left' else max(shape.points)
            reach_to = px - tip[0] if side == 'left' else tip[0] - px
            values.append(max(-max_distance, min(max_distance, reach_to)))
            about[f['name']] = {'end': [tip[0], tip[1], math.hypot(tip[0] - px, tip[1] - py)], 'shape': shape.index}
            continue
        dx = max(-max_distance, min(max_distance, end[1] - px))
        dy = max(-max_distance, min(max_distance, end[2] - py))
        if value == 'prop':
            have = number_of(shape.item, f['prop'])
            values.append(have if have is not None else float(f.get('fill', 0)))
        else:
            values.append({'dx': dx, 'dy': dy, 'forward': -dx if facing_left else dx, 'dist': end[0], 'found': 1.0}[value])
        about[f['name']] = {'end': [end[1], end[2], end[0]], 'shape': shape.index}
    return [float(v) + 0.0 for v in values], about, distances  # + 0.0: no -0 from turning a 0 round


def relations(items, point, facing_left=None, radii=RADII, max_distance=MAX_DISTANCE):
    """The presets' columns for one set (in columns()' order), from point (x, y). facing_left None: left and right;
    True or False: ahead and behind, and the nearest's dx positive ahead."""
    return evaluate(items, point, facing_left, default_fields(radii, facing_left is not None), max_distance)[0]


def bounds_of(items):
    """The box round shapes, [left, top, right, bottom], or None: a shape's points, or a box given as x, y, w, h
    alone (as a script can return the map's bounds)."""
    xs, ys = [], []
    for item in items or []:
        points = polyline(item) if isinstance(item, dict) and 'points' in item else []
        if not points and isinstance(item, dict) and all(finite(item.get(k)) for k in ('x', 'y', 'w', 'h')):
            points = [(item['x'], item['y']), (item['x'] + item['w'], item['y'] + item['h'])]
        elif not points:
            points = polyline(item)
        xs += [p[0] for p in points]
        ys += [p[1] for p in points]
    return [min(xs), min(ys), max(xs), max(ys)] if xs else None


# A box as a script may return it: its edges, two corners, or a corner and a size, by these names
_EDGES = (('left', 'top', 'right', 'bottom'), ('x1', 'y1', 'x2', 'y2'), ('minX', 'minY', 'maxX', 'maxY'),
          ('min_x', 'min_y', 'max_x', 'max_y'), ('l', 't', 'r', 'b'))
_SIZES = (('x', 'y', 'w', 'h'), ('x', 'y', 'width', 'height'))


def box_of(value):
    """Bounds as [left, top, right, bottom], from whatever a State gives: shapes (a list of them), or one table,
    with its edges ({left, top, right, bottom}, {x1, y1, x2, y2}, {minX, minY, maxX, maxY}), a corner and a size
    ({x, y, w, h}), points, four numbers (left, top, right, bottom) or corner points. None if it's none of these."""
    if isinstance(value, dict):
        for keys in _EDGES:
            if all(finite(value.get(k)) for k in keys):
                x1, y1, x2, y2 = (float(value[k]) for k in keys)
                return [min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)]
        if 'points' in value:
            return bounds_of([value])
        for keys in _SIZES:
            if all(finite(value.get(k)) for k in keys):
                x, y, w, h = (float(value[k]) for k in keys)
                return [min(x, x + w), min(y, y + h), max(x, x + w), max(y, y + h)]
        return None
    if isinstance(value, list) and value:
        if len(value) == 4 and all(finite(v) for v in value):
            x1, y1, x2, y2 = (float(v) for v in value)
            return [min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)]
        if all(isinstance(p, list) and len(p) == 2 and all(finite(v) for v in p) for p in value):
            return bounds_of([{'points': value}])
        boxes = [b for b in (box_of(v) for v in value) if b]
        if boxes:
            return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
    return None


MAX_DRAWN = 3000  # shapes per input in the node's picture


def picture(sets, point, facing_left, fields, bounds=None, max_distance=MAX_DISTANCE):
    """What a Spatial node draws for a sample: its bounds (the Bounds input's box, see box_of, else round
    everything and the point), each input's shapes as points to draw through (whole px) with the fields of theirs
    the node's fields read, the point and facing, the radii its fields count within, and per input what each of its
    fields is about (evaluate: `fields`, with each shape's distance, `distances`) and the number fields its shapes
    carry (`props`, to choose from). sets: [(alias, items)]."""
    def rounded(about):
        if about is None or 'shapes' in about:
            return about if about is None else {'shapes': [i for i in about['shapes'] if i < MAX_DRAWN]}
        x, y, d = about['end']
        return {'end': [round(x, 1), round(y, 1), round(d, 1)], 'shape': about['shape']}

    read = sorted({f['prop'] for f in fields if f['value'] == 'prop'} | {f['by'] for f in fields if f.get('by')}
                  | {f['where']['field'] for f in fields if f.get('where')})
    drawn = []
    for alias, items in sets:
        own = [f for f in fields if applies(f, alias)]
        _, about, distances = evaluate(items, point, facing_left, own, max_distance)
        shapes = []
        for points, closed, item in _shapes(items)[:MAX_DRAWN]:
            shape = {'points': [[round(x), round(y)] for x, y in points], 'closed': closed}
            props = {k: number_of(item, k) for k in read if number_of(item, k) is not None}
            if props:
                shape['props'] = props
            shapes.append(shape)
        drawn.append({'alias': alias, 'shapes': shapes, 'props': fields_of(items),
                      'fields': {name: rounded(a) for name, a in about.items()},
                      'distances': [None if d is None else round(d, 1) for d in distances[:MAX_DRAWN]]})
    box = box_of(bounds) if bounds is not None else None
    fitted = box is None
    if box is None:
        everything = [{'points': [list(point)]}] + [{'points': s['points']} for d in drawn for s in d['shapes']]
        box = bounds_of(everything)
        pad = max(20.0, 0.05 * max(box[2] - box[0], box[3] - box[1]))
        box = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad]
    radii = sorted({f['within'] for f in fields if f.get('within') is not None})
    areas = {f['name']: area_of(f, point, facing_left) for f in fields if f.get('area')}
    return {'bounds': box, 'fitted': fitted, 'point': [point[0], point[1]], 'facingLeft': facing_left,
            'radii': radii, 'areas': areas, 'sets': drawn}


_FIELD_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*')
_KEY = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,39}')


def checked_fields(name, fields, aliases, facing):
    """A node's own fields, checked: each has a name of its own, a pick and a value that go together, a field to
    rank or read where it needs one, facing where it needs it, and only the node's inputs."""
    if not isinstance(fields, list) or not 1 <= len(fields) <= MAX_FIELDS:
        raise ValueError(f'{name}: 1..{MAX_FIELDS} fields')
    out, names = [], set()
    for f in fields:
        label = str(f.get('name', '')) if isinstance(f, dict) else ''
        if not _FIELD_NAME.fullmatch(label) or len(label) > 60:
            raise ValueError(f'{name}: name each field with letters, digits, _ and dots, such as lowest.hp')
        if label in names:
            raise ValueError(f'{name}: two fields are called {label}')
        names.add(label)
        pick, value = f.get('pick'), f.get('value')
        if pick not in PICKS:
            raise ValueError(f'{name}.{label}: pick the nearest, one each way, the lowest or highest, or all')
        if value not in (ALL_VALUES if pick == 'all' else ONE_VALUES):
            raise ValueError(f'{name}.{label}: ' + ('of all the shapes it gives a count or whether the point is inside one'
                             if pick == 'all' else 'of one shape it gives dx, dy, forward, distance, found or one of its fields'))
        if not facing and (pick in ('ahead', 'behind') or value in ('forward', 'ahead_end', 'behind_end')):
            raise ValueError(f'{name}.{label}: ahead, behind and forward need Facing wired in')
        spec = {'name': label, 'pick': pick, 'value': value}
        if f.get('notUnder'):
            if pick == 'under':
                raise ValueError(f'{name}.{label}: the one under the point can’t leave itself out')
            spec['notUnder'] = True
        if pick in ('lowest', 'highest'):
            if not isinstance(f.get('by'), str) or not _KEY.fullmatch(f['by']):
                raise ValueError(f'{name}.{label}: say which of the shapes’ fields it ranks by, such as hp')
            spec['by'] = f['by']
        if value == 'prop':
            if f.get('prop') is None and 'by' in spec:
                f = {**f, 'prop': spec['by']}  # the lowest hp's value: its hp, unless it says otherwise
            if not isinstance(f.get('prop'), str) or not _KEY.fullmatch(f['prop']):
                raise ValueError(f'{name}.{label}: say which of the shape’s fields it gives, such as hp')
            spec['prop'] = f['prop']
        if f.get('within') is not None:
            if not (finite(f['within']) and 1 <= f['within'] <= 100000):
                raise ValueError(f'{name}.{label}: within is 1..100000 px')
            spec['within'] = f['within']
        if f.get('area') is not None:
            a = f['area']
            sides = ('ahead', 'behind', 'above', 'below')
            if not (isinstance(a, dict) and all(finite(a.get(k)) and 0 <= a[k] <= 100000 for k in sides)
                    and a['ahead'] + a['behind'] > 0 and a['above'] + a['below'] > 0):
                raise ValueError(f'{name}.{label}: an area reaches 0..100000 px ahead, behind, up and down, some of it each way')
            spec['area'] = {k: a[k] for k in sides}
        if f.get('where') is not None:
            w = f['where']
            if not (isinstance(w, dict) and isinstance(w.get('field'), str) and _KEY.fullmatch(w['field'])
                    and w.get('op') in OPS and finite(w.get('value'))):
                raise ValueError(f'{name}.{label}: “where” compares one of the shapes’ fields to a number, such as hp < 100')
            spec['where'] = {'field': w['field'], 'op': w['op'], 'value': w['value']}
        if f.get('fill') is not None:
            if not finite(f['fill']):
                raise ValueError(f'{name}.{label}: what it reads with nothing picked is a number')
            spec['fill'] = f['fill']
        if f.get('inputs') is not None:
            if not isinstance(f['inputs'], list) or not f['inputs'] or not all(a in aliases for a in f['inputs']):
                raise ValueError(f'{name}.{label}: it’s for one or more of the node’s inputs')
            spec['inputs'] = [a for a in aliases if a in f['inputs']]
        out.append(spec)
    return out


def checked(s, fields, vectors, booleans):
    """A Spatial node's spec, as the app sends it, checked: {name, point, facing?, bounds?, sets: [{alias,
    shapes: [names]}], fields?, radii, maxDistance}. vectors and booleans: what the point and facing can come from
    (observations and formulas). Without fields of its own it has the presets, from radii. Bounds only frame the
    node's picture: no value comes from them."""
    name = str(s.get('name', '')).strip() if isinstance(s, dict) else ''
    if not name or len(name) > 60 or '@' in name:
        raise ValueError('Name each Spatial node (up to 60 characters, without @)')
    point = s.get('point')
    if point not in vectors:
        raise ValueError(f'{name}: wire a position into Point, such as the player’s, a vector state or formula')
    facing = s.get('facing')
    if facing is not None and facing not in booleans:
        raise ValueError(f'{name}: Facing is true or false (true facing left), such as a Face Left state')
    sets = s.get('sets')
    if not isinstance(sets, list) or not 1 <= len(sets) <= MAX_SETS:
        raise ValueError(f'{name}: wire 1..{MAX_SETS} shapes, such as platforms or monsters')
    aliases, shapes_of_set = [], []
    for entry in sets:
        alias, shapes = (entry.get('alias'), entry.get('shapes')) if isinstance(entry, dict) else (None, None)
        if not isinstance(alias, str) or not _KEY.fullmatch(alias) or alias in aliases:
            raise ValueError(f'{name}: each shapes input has a name of its own')
        shapes = [shapes] if isinstance(shapes, str) else shapes  # one observation, or several measured as one set
        if not isinstance(shapes, list) or not shapes or len(set(shapes)) != len(shapes) or not all(
                (fields.get(n) or {}).get('type') == 'shapes' for n in shapes):
            raise ValueError(f'{name}: {alias} is made from shapes, such as platforms')
        if entry.get('read', 'point') not in READS:
            raise ValueError(f'{name}: {alias} reads x, y, w, h as a point, a box from its corner or round its centre, or its bottom centre')
        aliases.append(alias)
        shapes_of_set.append((list(shapes), entry.get('read', 'point')))
    bounds = s.get('bounds')
    if bounds is not None and (fields.get(bounds) or {}).get('type') not in ('shapes', 'object'):
        raise ValueError(f'{name}: Bounds are a box round the map, as shapes or a table such as {{left, top, right, bottom}}')
    max_distance = s.get('maxDistance', MAX_DISTANCE)
    if not (finite(max_distance) and 10 <= max_distance <= 100000):
        raise ValueError(f'{name}: the reach is 10..100000 px')
    if s.get('fields') is not None:
        own = checked_fields(name, s['fields'], aliases, facing is not None)
    else:
        radii = s.get('radii', list(RADII))
        if not isinstance(radii, list) or len(radii) > 4 or not all(finite(r) and 1 <= r <= 10000 for r in radii) or len(set(radii)) != len(radii):
            raise ValueError(f'{name}: up to 4 different radii, each 1..10000 px')
        own = default_fields(radii, facing is not None)
    return {'name': name, 'point': point, **({'facing': facing} if facing is not None else {}),
            **({'bounds': bounds} if bounds is not None else {}),
            'sets': [{'alias': a, 'shapes': sh, **({'read': read} if read != 'point' else {})} for a, (sh, read) in zip(aliases, shapes_of_set)],
            'fields': own, 'maxDistance': max_distance}
