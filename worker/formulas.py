"""Formulas: the values a dataset holds, written by the user over the observations of each sample.

    enemy_dist = distance(player, enemy)
    to_ladder  = nearest(ladders, player).x
    low_hp     = hp < 0.3 * `hp max`
    speed_x    = player.x - player.x[-1]

A formula names observations (in `backticks` if the name has spaces or symbols) and other formulas, and
combines them with + - * / %, comparisons, and/or/not (also && || !), ?? and the functions in FUNCTIONS.
Vectors have .x and .y, and add, subtract and scale. `x[-k]` is x k steps earlier on the dataset's fixed
time grid (see Worker.dataset). Shapes (platforms, ladders...) can only be used through the shape
functions. Types are checked before anything runs: a formula has to give a number, a true/false or a
vector, which become one column (`name`) or two (`name.x`, `name.y`).

A value that isn't there, such as the player not being found, a shape query with nothing to find, or no
sample that many steps earlier, is Missing: the sample is skipped, unless the formula falls back with
`a ?? b` (b where a is missing) or asks with found(a).
"""
import math

from shapes import count_within, finite, lines_of, nearest, surface

MAX_HISTORY = 30                      # how many steps back x[-k] can reach
RESULT_TYPES = ('number', 'boolean', 'vector')
USABLE_TYPES = ('number', 'boolean', 'vector', 'shapes')


class Shapes(list):
    """A list's shapes, as the lines the shape functions take, keeping how many items the list held:
    count() counts them all, though some (plain numbers, say) aren't shapes."""
    def __init__(self, lines, items):
        super().__init__(lines)
        self.items = items


class Missing(ValueError):
    """A value that isn't there in this sample; the sample is skipped unless a formula falls back."""


class FormulaError(ValueError):
    """A formula that can't be read or doesn't add up, found before anything runs."""


# ── Reading a formula ──────────────────────────────────────────────────────────────────────────────

KEYWORDS = {'and': '&&', 'or': '||', 'not': '!'}
SYMBOLS = ('??', '&&', '||', '==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '<', '>', '!', '(', ')', ',', '.', '[', ']')


def _tokens(source):
    tokens, i = [], 0
    while i < len(source):
        c = source[i]
        if c.isspace():
            i += 1
        elif c.isdigit() or (c == '.' and source[i + 1:i + 2].isdigit()):
            j = i
            while j < len(source) and (source[j].isdigit() or source[j] == '.'):
                j += 1
            try:
                tokens.append(('num', float(source[i:j]), i))
            except ValueError:
                raise FormulaError(f'At {i + 1}: “{source[i:j]}” isn’t a number') from None
            i = j
        elif c.isalpha() or c == '_':
            j = i
            while j < len(source) and (source[j].isalnum() or source[j] == '_'):
                j += 1
            word = source[i:j]
            if word in KEYWORDS:
                tokens.append(('op', KEYWORDS[word], i))
            elif word in ('true', 'false'):
                tokens.append(('bool', word == 'true', i))
            else:
                tokens.append(('name', word, i))
            i = j
        elif c == '`':
            j = source.find('`', i + 1)
            if j < 0:
                raise FormulaError(f'At {i + 1}: a name started with ` isn’t closed')
            tokens.append(('name', source[i + 1:j], i))
            i = j + 1
        else:
            symbol = next((s for s in SYMBOLS if source.startswith(s, i)), None)
            if not symbol:
                raise FormulaError(f'At {i + 1}: unexpected “{c}”')
            tokens.append(('op', symbol, i))
            i += len(symbol)
    tokens.append(('end', None, len(source)))
    return tokens


class _Parser:
    """Recursive descent, loosest first: ??, or, and, comparisons, + -, * / %, unary, then .x and [-k]."""

    def __init__(self, source):
        self.tokens, self.i = _tokens(source), 0

    def peek(self, *ops):
        kind, value, _ = self.tokens[self.i]
        return kind == 'op' and value in ops

    def take(self):
        token = self.tokens[self.i]
        self.i += 1
        return token

    def expect(self, op, what):
        kind, value, pos = self.take()
        if kind != 'op' or value != op:
            raise FormulaError(f'At {pos + 1}: expected {what}')

    def parse(self):
        if self.tokens[0][0] == 'end':
            raise FormulaError('Write a formula')
        node = self.coalesce()
        kind, value, pos = self.tokens[self.i]
        if kind != 'end':
            raise FormulaError(f'At {pos + 1}: unexpected “{value}”')
        return node

    def binary(self, ops, lower):
        node = lower()
        while self.peek(*ops):
            op = self.take()[1]
            node = ('bin', op, node, lower())
        return node

    def coalesce(self):
        return self.binary(('??',), self.disjunction)

    def disjunction(self):
        return self.binary(('||',), self.conjunction)

    def conjunction(self):
        return self.binary(('&&',), self.comparison)

    def comparison(self):
        node = self.additive()
        if self.peek('==', '!=', '<', '<=', '>', '>='):
            op = self.take()[1]
            node = ('bin', op, node, self.additive())
            if self.peek('==', '!=', '<', '<=', '>', '>='):
                raise FormulaError(f'At {self.tokens[self.i][2] + 1}: compare two values at a time; join comparisons with and')
        return node

    def additive(self):
        return self.binary(('+', '-'), self.multiplicative)

    def multiplicative(self):
        return self.binary(('*', '/', '%'), self.unary)

    def unary(self):
        if self.peek('-', '!'):
            op = self.take()[1]
            return ('un', op, self.unary())
        return self.postfix()

    def postfix(self):
        node = self.primary()
        while True:
            if self.peek('.'):
                self.take()
                kind, field, pos = self.take()
                if kind != 'name':
                    raise FormulaError(f'At {pos + 1}: expected x or y after the dot')
                node = ('member', node, field, pos)
            elif self.peek('['):
                pos = self.take()[2]
                self.expect('-', 'a step back, such as [-1]')
                kind, steps, _ = self.take()
                if kind != 'num' or steps != int(steps) or not 1 <= steps <= MAX_HISTORY:
                    raise FormulaError(f'At {pos + 1}: a step back is [-1] to [-{MAX_HISTORY}]')
                self.expect(']', ']')
                node = ('hist', node, int(steps))
            else:
                return node

    def primary(self):
        kind, value, pos = self.take()
        if kind == 'num':
            return ('num', value)
        if kind == 'bool':
            return ('bool', value)
        if kind == 'name':
            if self.peek('('):
                self.take()
                args = []
                if not self.peek(')'):
                    args.append(self.coalesce())
                    while self.peek(','):
                        self.take()
                        args.append(self.coalesce())
                self.expect(')', ') to close the call')
                return ('call', value, args, pos)
            return ('ref', value, pos)
        if kind == 'op' and value == '(':
            node = self.coalesce()
            self.expect(')', ')')
            return node
        if kind == 'end':
            raise FormulaError('The formula ends too soon')
        raise FormulaError(f'At {pos + 1}: unexpected “{value}”')


def parse(source):
    return _Parser(source).parse()


# ── Functions ──────────────────────────────────────────────────────────────────────────────────────

def _num(v):
    return float(v)


def _check_finite(v):
    if isinstance(v, tuple):
        if not all(math.isfinite(c) for c in v):
            raise Missing('the result isn’t a finite number')
    elif not isinstance(v, bool) and not math.isfinite(v):
        raise Missing('the result isn’t a finite number')
    return v


def _safe(fn):
    def call(*args):
        try:
            return _check_finite(fn(*args))
        except (ValueError, OverflowError, ZeroDivisionError) as e:
            if isinstance(e, Missing):
                raise
            raise Missing(str(e)) from None
    return call


def _normalize(v):
    length = math.hypot(*v)
    if length == 0:
        raise Missing('a vector of length 0 has no direction')
    return (v[0] / length, v[1] / length)


def _offset(point, anchor):
    if point is None:
        raise Missing('there’s no such shape')
    return (point[0] - anchor[0], point[1] - anchor[1])


def _surface(lines, anchor, side, part):
    found = surface(lines, anchor, side)
    if found is None:
        raise Missing('there’s no shape ' + ('below' if side > 0 else 'above'))
    return (0.0, found[0]) if part == 'point' else (found[1], found[2])


N, B, V, S = 'num', 'boolean', 'vector', 'shapes'
# name: (parameter types, result type, implementation, description). 'num' takes numbers and true/false.
FUNCTIONS = {
    'abs': ((N,), 'number', lambda a: abs(_num(a)), 'abs(x)'),
    'sign': ((N,), 'number', lambda a: float((a > 0) - (a < 0)), 'sign(x): -1, 0 or 1'),
    'sqrt': ((N,), 'number', lambda a: math.sqrt(a), 'sqrt(x)'),
    'floor': ((N,), 'number', lambda a: float(math.floor(a)), 'floor(x)'),
    'ceil': ((N,), 'number', lambda a: float(math.ceil(a)), 'ceil(x)'),
    'round': ((N,), 'number', lambda a: float(round(a)), 'round(x)'),
    'exp': ((N,), 'number', lambda a: math.exp(a), 'exp(x)'),
    'log': ((N,), 'number', lambda a: math.log(a), 'log(x): natural logarithm'),
    'pow': ((N, N), 'number', lambda a, b: math.pow(a, b), 'pow(x, y)'),
    'sin': ((N,), 'number', lambda a: math.sin(a), 'sin(radians)'),
    'cos': ((N,), 'number', lambda a: math.cos(a), 'cos(radians)'),
    'atan2': ((N, N), 'number', lambda y, x: math.atan2(y, x), 'atan2(y, x): radians'),
    'hypot': ((N, N), 'number', lambda a, b: math.hypot(a, b), 'hypot(x, y)'),
    'clamp': ((N, N, N), 'number', lambda x, lo, hi: min(max(_num(x), _num(lo)), _num(hi)), 'clamp(x, low, high)'),
    'vec': ((N, N), 'vector', lambda x, y: (_num(x), _num(y)), 'vec(x, y): a vector'),
    'len': ((V,), 'number', lambda v: math.hypot(*v), 'len(v): a vector’s length'),
    'distance': ((V, V), 'number', lambda a, b: math.hypot(b[0] - a[0], b[1] - a[1]), 'distance(a, b): how far apart two positions are'),
    'dot': ((V, V), 'number', lambda a, b: a[0] * b[0] + a[1] * b[1], 'dot(a, b)'),
    'normalize': ((V,), 'vector', _normalize, 'normalize(v): length 1, the same direction'),
    'angle': ((V,), 'number', lambda v: math.atan2(v[1], v[0]), 'angle(v): radians, y down'),
    'nearest': ((S, V), 'vector', lambda s, p: _offset(nearest(s, p), p), 'nearest(shapes, position): where the nearest shape point is from the position'),
    'nearest_left': ((S, V), 'vector', lambda s, p: _offset(nearest(s, p, -1), p), 'nearest_left(shapes, position)'),
    'nearest_right': ((S, V), 'vector', lambda s, p: _offset(nearest(s, p, 1), p), 'nearest_right(shapes, position)'),
    'below': ((S, V), 'vector', lambda s, p: _surface(s, p, 1, 'point'), 'below(shapes, position): where the shape directly below is (dy in .y)'),
    'above': ((S, V), 'vector', lambda s, p: _surface(s, p, -1, 'point'), 'above(shapes, position)'),
    'below_ends': ((S, V), 'vector', lambda s, p: _surface(s, p, 1, 'ends'), 'below_ends(shapes, position): how far the left (.x) and right (.y) ends of the shape below are'),
    'above_ends': ((S, V), 'vector', lambda s, p: _surface(s, p, -1, 'ends'), 'above_ends(shapes, position)'),
    'count_within': ((S, V, N), 'number', lambda s, p, r: float(count_within(s, p, r)), 'count_within(shapes, position, radius)'),
    'count': ((S,), 'number', lambda s: float(getattr(s, 'items', len(s))), 'count(list): how many items it holds'),
}
# Checked and run on their own: min/max take any count, if and found don't evaluate everything
SPECIAL = {'min': 'min(a, b, ...)', 'max': 'max(a, b, ...)', 'if': 'if(condition, then, else)',
           'found': 'found(x): whether x is there in this sample'}


def functions_help():
    """What there is to call, for the dataset builder's reference."""
    return [d for *_, d in FUNCTIONS.values()] + list(SPECIAL.values())


# ── Checking and running a set of formulas ─────────────────────────────────────────────────────────

def _fits(have, want):
    return have == want or (want == N and have in ('number', 'boolean'))


def _numeric(t):
    return t in ('number', 'boolean')


class FormulaSet:
    """Formulas `[{name, source, inputs?}]` over observations with these schema fields. Each is checked up
    front (see entries: its type, its columns or its error); evaluate() works one out for a sample.

    `inputs` names what a formula's own names stand for, {alias: observation or formula}, as wires into a
    formula node do: `distance(a, b)` with {a: player, b: enemy}. A name that isn't an input is looked up
    as an observation or formula."""

    def __init__(self, formulas, fields):
        self.fields = {f['name']: f['type'] for f in fields}
        self.entries = {}
        for f in formulas or []:
            name, source = str(f.get('name', '')).strip(), str(f.get('source', ''))
            inputs = f.get('inputs') or {}
            entry = {'name': name, 'source': source, 'type': None, 'columns': [], 'error': None,
                     'node': None, 'depth': 0, 'observations': set(),
                     'inputs': {str(k): str(v) for k, v in inputs.items()} if isinstance(inputs, dict) else {}}
            if not isinstance(inputs, dict) or not all(isinstance(v, str) and v for v in inputs.values()):
                entry['error'] = 'Each input stands for an observation or formula'
            elif not name or len(name) > 60 or '@' in name or '`' in name:
                entry['error'] = 'Name each formula (up to 60 characters, without @ or `)'
            elif name in self.entries:
                entry['error'] = f'Another formula is already called “{name}”'
                name = f'{name}​{len(self.entries)}'  # kept apart, so both can be shown
            elif name in self.fields:
                entry['error'] = f'An observation is already called “{name}”'
            else:
                try:
                    entry['node'] = parse(source)
                except FormulaError as e:
                    entry['error'] = str(e)
            self.entries[name] = entry
        self._visiting = set()
        for entry in self.entries.values():
            self._check(entry)
        for entry in self.entries.values():
            if entry['error'] is None and entry['type'] not in RESULT_TYPES:
                entry['error'] = f'A formula has to give a number, true/false or a vector; this gives {entry["type"]}'
            if entry['error'] is None:
                entry['columns'] = [f'{entry["name"]}.x', f'{entry["name"]}.y'] if entry['type'] == 'vector' else [entry['name']]
        self.depth = max((e['depth'] for e in self.entries.values() if e['error'] is None), default=0)

    def results(self):
        """Each formula as shown in the builder: its name, source, type, columns and error."""
        return [{k: e[k] for k in ('name', 'source', 'inputs', 'type', 'columns', 'error')} for e in self.entries.values()]

    def ok(self):
        return [e for e in self.entries.values() if e['error'] is None]

    def errors(self):
        return [f'{e["name"]}: {e["error"]}' for e in self.entries.values() if e['error']]

    # Types, before anything runs

    def _check(self, entry):
        if entry['type'] is not None or entry['error'] is not None or entry['node'] is None:
            return
        if entry['name'] in self._visiting:
            entry['error'] = 'It uses itself, through other formulas'
            return
        self._visiting.add(entry['name'])
        try:
            entry['type'], entry['depth'] = self._type(entry['node'], entry)
        except FormulaError as e:
            entry['error'] = str(e)
        self._visiting.discard(entry['name'])

    def _type(self, node, entry):
        """(type, how many steps back it reaches) of a node."""
        kind = node[0]
        if kind == 'num':
            return 'number', 0
        if kind == 'bool':
            return 'boolean', 0
        if kind == 'ref':
            name = entry['inputs'].get(node[1], node[1])
            if name in self.entries and name not in self.fields:
                other = self.entries[name]
                if other is entry:
                    raise FormulaError('It uses itself')
                if other['name'] in self._visiting:
                    raise FormulaError(f'“{name}” and this formula use each other')
                self._check(other)
                if other['error']:
                    raise FormulaError(f'It uses “{name}”, which has an error')
                entry['observations'] |= other['observations']
                return other['type'], other['depth']
            if name not in self.fields:
                if node[1] in entry['inputs']:
                    raise FormulaError(f'Input “{node[1]}” is wired to “{name}”, which isn’t an observation or formula')
                raise FormulaError(f'There’s no {"input, " if entry["inputs"] else ""}observation or formula called “{name}”')
            if self.fields[name] not in USABLE_TYPES:
                raise FormulaError(f'“{name}” is {self.fields[name]}, which formulas can’t use')
            entry['observations'].add(name)
            return self.fields[name], 0
        if kind == 'member':
            t, depth = self._type(node[1], entry)
            if t != 'vector' or node[2] not in ('x', 'y'):
                raise FormulaError(f'At {node[3] + 1}: only a vector has .x and .y')
            return 'number', depth
        if kind == 'hist':
            t, depth = self._type(node[1], entry)
            return t, depth + node[2]
        if kind == 'un':
            t, depth = self._type(node[2], entry)
            if node[1] == '-' and t in ('number', 'boolean', 'vector'):
                return ('vector' if t == 'vector' else 'number'), depth
            if node[1] == '!' and _numeric(t):
                return 'boolean', depth
            raise FormulaError(f'{"-" if node[1] == "-" else "not"} can’t be used on {t}')
        if kind == 'bin':
            op = node[1]
            (a, da), (b, db) = self._type(node[2], entry), self._type(node[3], entry)
            depth = max(da, db)
            if op == '??':
                if a == b or (_numeric(a) and _numeric(b)):
                    return (a if a == b else 'number'), depth
                raise FormulaError(f'?? needs the same type on both sides, not {a} and {b}')
            if op in ('&&', '||'):
                if _numeric(a) and _numeric(b):
                    return 'boolean', depth
                raise FormulaError(f'{"and" if op == "&&" else "or"} joins true/false values, not {a} and {b}')
            if op in ('<', '<=', '>', '>='):
                if _numeric(a) and _numeric(b):
                    return 'boolean', depth
                raise FormulaError(f'{op} compares numbers, not {a} and {b}')
            if op in ('==', '!='):
                if (_numeric(a) and _numeric(b)) or (a == b == 'vector'):
                    return 'boolean', depth
                raise FormulaError(f'{op} can’t compare {a} with {b}')
            if op in ('+', '-'):
                if _numeric(a) and _numeric(b):
                    return 'number', depth
                if a == b == 'vector':
                    return 'vector', depth
            elif op == '*':
                if _numeric(a) and _numeric(b):
                    return 'number', depth
                if (a == 'vector' and _numeric(b)) or (_numeric(a) and b == 'vector'):
                    return 'vector', depth
            elif op in ('/', '%'):
                if _numeric(a) and _numeric(b):
                    return 'number', depth
                if op == '/' and a == 'vector' and _numeric(b):
                    return 'vector', depth
            raise FormulaError(f'{op} can’t combine {a} and {b}')
        if kind == 'call':
            name, args, pos = node[1], node[2], node[3]
            typed = [self._type(arg, entry) for arg in args]
            types, depth = [t for t, _ in typed], max((d for _, d in typed), default=0)
            if name in ('min', 'max'):
                if len(types) < 2 or not all(_numeric(t) for t in types):
                    raise FormulaError(f'{name} takes two or more numbers')
                return 'number', depth
            if name == 'if':
                if len(types) != 3 or not _numeric(types[0]):
                    raise FormulaError('if takes a condition, then what it gives if true, and if false')
                a, b = types[1], types[2]
                if a == b or (_numeric(a) and _numeric(b)):
                    return (a if a == b else 'number'), depth
                raise FormulaError(f'if gives the same type either way, not {a} and {b}')
            if name == 'found':
                if len(types) != 1:
                    raise FormulaError('found takes one value')
                return 'boolean', depth
            if name not in FUNCTIONS:
                raise FormulaError(f'At {pos + 1}: there’s no function called “{name}”')
            params, result, _, description = FUNCTIONS[name]
            if len(types) != len(params) or not all(_fits(t, p) for t, p in zip(types, params)):
                raise FormulaError(f'Use it as {description.split(":")[0]} ({", ".join("number" if p == N else p for p in params)}), '
                                   f'not ({", ".join(types) or "nothing"})')
            return result, depth
        raise FormulaError('Unknown part of a formula')

    # Values, per sample

    def evaluate(self, name, frames):
        """A formula's value for a sample. frames[0] is its observations by name, frames[k] those k steps
        earlier on the grid (None where there's no sample); raises Missing when something isn't there."""
        memo = {}
        return self._value(('ref', name, 0), frames, 0, memo, {})

    def _lookup(self, name, frames, offset, memo):
        key = (name, offset)
        if key in memo:
            if isinstance(memo[key], Missing):
                raise memo[key]
            return memo[key]
        try:
            if name in self.entries and name not in self.fields:
                value = self._value(self.entries[name]['node'], frames, offset, memo, self.entries[name]['inputs'])
            else:
                row = frames[offset] if offset < len(frames) else None
                if row is None:
                    raise Missing(f'there’s no sample {offset} step{"s" if offset > 1 else ""} earlier')
                o = row.get(name)
                if not o or not o.get('valid'):
                    raise Missing(f'{name} isn’t found' + (f' {offset} step{"s" if offset > 1 else ""} earlier' if offset else ''))
                value = self._convert(o.get('value'), self.fields[name], name)
        except Missing as e:
            memo[key] = e
            raise
        memo[key] = value
        return value

    @staticmethod
    def _convert(value, kind, name):
        if kind == 'number' and finite(value):
            return float(value)
        if kind == 'boolean' and isinstance(value, bool):
            return value
        if kind == 'vector' and isinstance(value, list) and len(value) == 2 and all(finite(v) for v in value):
            return (float(value[0]), float(value[1]))
        if kind == 'shapes' and isinstance(value, list):
            return Shapes(lines_of(value), len(value))
        raise Missing(f'{name} doesn’t have a usable value')

    def _value(self, node, frames, offset, memo, inputs):
        kind = node[0]
        if kind in ('num', 'bool'):
            return node[1]
        if kind == 'ref':
            return self._lookup(inputs.get(node[1], node[1]), frames, offset, memo)
        if kind == 'member':
            v = self._value(node[1], frames, offset, memo, inputs)
            return v[0] if node[2] == 'x' else v[1]
        if kind == 'hist':
            return self._value(node[1], frames, offset + node[2], memo, inputs)
        if kind == 'un':
            v = self._value(node[2], frames, offset, memo, inputs)
            if node[1] == '!':
                return not v
            return (-v[0], -v[1]) if isinstance(v, tuple) else -float(v)
        if kind == 'bin':
            op = node[1]
            if op == '??':
                try:
                    return self._value(node[2], frames, offset, memo, inputs)
                except Missing:
                    return self._value(node[3], frames, offset, memo, inputs)
            a = self._value(node[2], frames, offset, memo, inputs)
            if op == '&&' and not a:
                return False
            if op == '||' and a:
                return True
            b = self._value(node[3], frames, offset, memo, inputs)
            return _safe(_binary)(op, a, b)
        if kind == 'call':
            name, args = node[1], node[2]
            if name == 'found':
                try:
                    self._value(args[0], frames, offset, memo, inputs)
                    return True
                except Missing:
                    return False
            if name == 'if':
                condition = self._value(args[0], frames, offset, memo, inputs)
                return self._value(args[1] if condition else args[2], frames, offset, memo, inputs)
            values = [self._value(arg, frames, offset, memo, inputs) for arg in args]
            if name in ('min', 'max'):
                return float((min if name == 'min' else max)(float(v) for v in values))
            return _safe(FUNCTIONS[name][2])(*values)
        raise Missing('unknown part of a formula')


def _binary(op, a, b):
    if op in ('&&', '||'):
        return bool(b)
    if op in ('<', '<=', '>', '>='):
        a, b = float(a), float(b)
        return a < b if op == '<' else a <= b if op == '<=' else a > b if op == '>' else a >= b
    if op in ('==', '!='):
        same = a == b if isinstance(a, tuple) else float(a) == float(b)
        return same if op == '==' else not same
    if isinstance(a, tuple) or isinstance(b, tuple):
        if op == '+':
            return (a[0] + b[0], a[1] + b[1])
        if op == '-':
            return (a[0] - b[0], a[1] - b[1])
        if op == '*':
            (v, k) = (a, float(b)) if isinstance(a, tuple) else (b, float(a))
            return (v[0] * k, v[1] * k)
        if op == '/':
            if float(b) == 0:
                raise Missing('division by zero')
            return (a[0] / float(b), a[1] / float(b))
    a, b = float(a), float(b)
    if op == '+':
        return a + b
    if op == '-':
        return a - b
    if op == '*':
        return a * b
    if b == 0:
        raise Missing('division by zero')
    return a / b if op == '/' else math.fmod(a, b)


def columns_of(value, kind):
    """A formula's value as the numbers it puts in a dataset: a number, 1 or 0, or a vector's x and y."""
    if kind == 'vector':
        return [float(value[0]), float(value[1])]
    if kind == 'boolean':
        return [1.0 if value else 0.0]
    return [float(value)]
