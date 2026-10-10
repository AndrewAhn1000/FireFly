import { useEffect, type CSSProperties } from 'react';

// The buttons a recording can record and a policy can press, as the runtime's action schema takes them
// (native/session.cpp, actionSchema). Their order is the order a recording's buttons are sent in, which is
// part of its action identity: the first 24 are the buttons FireFly always had, in their old order, so a
// recording of those keeps the identity it had and still trains with the ones before; new ones go last.
export interface ButtonDef { id: string; label: string; vk: number }
export const BUTTONS: ButtonDef[] = [
  { id: 'lmb', label: 'LMB', vk: 1 }, { id: 'rmb', label: 'RMB', vk: 2 }, { id: 'mmb', label: 'MMB', vk: 4 },
  { id: 'w', label: 'W', vk: 87 }, { id: 'a', label: 'A', vk: 65 }, { id: 's', label: 'S', vk: 83 }, { id: 'd', label: 'D', vk: 68 },
  { id: 'space', label: 'Space', vk: 32 },
  { id: 'up', label: '↑', vk: 38 }, { id: 'down', label: '↓', vk: 40 }, { id: 'left', label: '←', vk: 37 }, { id: 'right', label: '→', vk: 39 },
  { id: 'q', label: 'Q', vk: 81 }, { id: 'e', label: 'E', vk: 69 }, { id: 'r', label: 'R', vk: 82 }, { id: 'f', label: 'F', vk: 70 },
  { id: 'g', label: 'G', vk: 71 }, { id: 'c', label: 'C', vk: 67 }, { id: 'z', label: 'Z', vk: 90 }, { id: 'x', label: 'X', vk: 88 },
  { id: 'k1', label: '1', vk: 49 }, { id: 'k2', label: '2', vk: 50 }, { id: 'k3', label: '3', vk: 51 }, { id: 'k4', label: '4', vk: 52 },
  // Added with the full keyboard
  ...['5', '6', '7', '8', '9', '0'].map(d => ({ id: `k${d}`, label: d, vk: d.charCodeAt(0) })),
  ...'BHIJKLMNOPTUVY'.split('').map(l => ({ id: l.toLowerCase(), label: l, vk: l.charCodeAt(0) })),
  { id: 'esc', label: 'Esc', vk: 27 },
  ...Array.from({ length: 12 }, (_, i) => ({ id: `f${i + 1}`, label: `F${i + 1}`, vk: 112 + i })),
  { id: 'backquote', label: '`', vk: 192 }, { id: 'minus', label: '-', vk: 189 }, { id: 'equals', label: '=', vk: 187 },
  { id: 'backspace', label: 'Backspace', vk: 8 }, { id: 'tab', label: 'Tab', vk: 9 }, { id: 'enter', label: 'Enter', vk: 13 },
  { id: 'bracketleft', label: '[', vk: 219 }, { id: 'bracketright', label: ']', vk: 221 }, { id: 'backslash', label: '\\', vk: 220 },
  { id: 'semicolon', label: ';', vk: 186 }, { id: 'quote', label: '\'', vk: 222 },
  { id: 'comma', label: ',', vk: 188 }, { id: 'period', label: '.', vk: 190 }, { id: 'slash', label: '/', vk: 191 },
  { id: 'insert', label: 'Insert', vk: 45 }, { id: 'delete', label: 'Delete', vk: 46 }, { id: 'home', label: 'Home', vk: 36 },
  { id: 'end', label: 'End', vk: 35 }, { id: 'pageup', label: 'Page Up', vk: 33 }, { id: 'pagedown', label: 'Page Down', vk: 34 },
  ...Array.from({ length: 10 }, (_, i) => ({ id: `num${i}`, label: `Num ${i}`, vk: 96 + i })),
  { id: 'nummultiply', label: 'Num *', vk: 106 }, { id: 'numadd', label: 'Num +', vk: 107 }, { id: 'numsubtract', label: 'Num -', vk: 109 },
  { id: 'numdecimal', label: 'Num .', vk: 110 }, { id: 'numdivide', label: 'Num /', vk: 111 },
  // Either side's; the input guard never presses them into a Windows shortcut (session.cpp withoutShortcuts)
  { id: 'shift', label: 'Shift', vk: 16 }, { id: 'ctrl', label: 'Ctrl', vk: 17 }, { id: 'alt', label: 'Alt', vk: 18 },
];
export const MAX_BUTTONS = BUTTONS.length; // every key at once (actionSchema takes up to 128)
const BY_ID = new Map(BUTTONS.map(b => [b.id, b]));
// A button's name as people know it ('k1' is “1”), or its id if it isn't one of these
export const buttonLabel = (id: string) => BY_ID.get(id)?.label ?? id;

// Why a key can't be chosen: the runtime refuses it (actionSchema)
const WINDOWS = 'The Windows key opens Windows’ Start menu, outside the game, so it can’t be recorded or pressed. Bind the game’s action to another key to use it.';
const TOGGLE = 'A lock key stays switched on for the whole system, so a policy can’t be allowed to press it.';
const SYSTEM = 'Opens something of Windows’ outside the game, so it can’t be recorded or pressed.';

// A key on the board, in key widths (u) from its top left; id is the button it chooses, or blocked says why none
interface Key { x: number; y: number; w?: number; h?: number; label: string; id?: string; blocked?: string }
const row = (y: number, x: number, keys: [string, string | null, number?][]): Key[] => {
  const out: Key[] = [];
  for (const [label, id, w = 1] of keys) { out.push({ x, y, w, label, ...(id ? { id } : {}) }); x += w; }
  return out;
};
const blocked = (k: Key, why: string): Key => ({ ...k, blocked: why });
const fnRow: Key[] = [
  { x: 0, y: 0, label: 'Esc', id: 'esc' },
  ...[1, 2, 3, 4].map((n, i) => ({ x: 2 + i, y: 0, label: `F${n}`, id: `f${n}` })),
  ...[5, 6, 7, 8].map((n, i) => ({ x: 6.5 + i, y: 0, label: `F${n}`, id: `f${n}` })),
  ...[9, 10, 11, 12].map((n, i) => ({ x: 11 + i, y: 0, label: `F${n}`, id: `f${n}` })),
  blocked({ x: 15.25, y: 0, label: 'PrtSc' }, SYSTEM), blocked({ x: 16.25, y: 0, label: 'ScrLk' }, TOGGLE), blocked({ x: 17.25, y: 0, label: 'Pause' }, SYSTEM),
];
const Y = 1.25; // the rows below the function keys
const BOARD: Key[] = [
  ...fnRow,
  ...row(Y, 0, [['`', 'backquote'], ['1', 'k1'], ['2', 'k2'], ['3', 'k3'], ['4', 'k4'], ['5', 'k5'], ['6', 'k6'], ['7', 'k7'], ['8', 'k8'],
    ['9', 'k9'], ['0', 'k0'], ['-', 'minus'], ['=', 'equals'], ['Backspace', 'backspace', 2]]),
  ...row(Y + 1, 0, [['Tab', 'tab', 1.5], ...'QWERTYUIOP'.split('').map(l => [l, l.toLowerCase()] as [string, string]),
    ['[', 'bracketleft'], [']', 'bracketright'], ['\\', 'backslash', 1.5]]),
  blocked({ x: 0, y: Y + 2, w: 1.75, label: 'Caps' }, TOGGLE),
  ...row(Y + 2, 1.75, [...'ASDFGHJKL'.split('').map(l => [l, l.toLowerCase()] as [string, string]), [';', 'semicolon'], ['\'', 'quote'], ['Enter', 'enter', 2.25]]),
  // Shift, Ctrl and Alt: either side's key is the same button, as both Enters are
  { x: 0, y: Y + 3, w: 2.25, label: 'Shift', id: 'shift' },
  ...row(Y + 3, 2.25, [...'ZXCVBNM'.split('').map(l => [l, l.toLowerCase()] as [string, string]), [',', 'comma'], ['.', 'period'], ['/', 'slash']]),
  { x: 12.25, y: Y + 3, w: 2.75, label: 'Shift', id: 'shift' },
  { x: 0, y: Y + 4, w: 1.25, label: 'Ctrl', id: 'ctrl' }, blocked({ x: 1.25, y: Y + 4, w: 1.25, label: 'Win' }, WINDOWS),
  { x: 2.5, y: Y + 4, w: 1.25, label: 'Alt', id: 'alt' },
  { x: 3.75, y: Y + 4, w: 6.25, label: 'Space', id: 'space' },
  { x: 10, y: Y + 4, w: 1.25, label: 'Alt', id: 'alt' }, blocked({ x: 11.25, y: Y + 4, w: 1.25, label: 'Win' }, WINDOWS),
  blocked({ x: 12.5, y: Y + 4, w: 1.25, label: 'Menu' }, SYSTEM), { x: 13.75, y: Y + 4, w: 1.25, label: 'Ctrl', id: 'ctrl' },
  // Navigation and arrows
  ...row(Y, 15.25, [['Ins', 'insert'], ['Home', 'home'], ['PgUp', 'pageup']]),
  ...row(Y + 1, 15.25, [['Del', 'delete'], ['End', 'end'], ['PgDn', 'pagedown']]),
  { x: 16.25, y: Y + 3, label: '↑', id: 'up' },
  ...row(Y + 4, 15.25, [['←', 'left'], ['↓', 'down'], ['→', 'right']]),
  // Number pad: its Enter is the same key to Windows as the main one
  blocked({ x: 18.5, y: Y, label: 'Num' }, TOGGLE),
  ...row(Y, 19.5, [['/', 'numdivide'], ['*', 'nummultiply'], ['-', 'numsubtract']]),
  ...row(Y + 1, 18.5, [['7', 'num7'], ['8', 'num8'], ['9', 'num9']]),
  { x: 21.5, y: Y + 1, h: 2, label: '+', id: 'numadd' },
  ...row(Y + 2, 18.5, [['4', 'num4'], ['5', 'num5'], ['6', 'num6']]),
  ...row(Y + 3, 18.5, [['1', 'num1'], ['2', 'num2'], ['3', 'num3']]),
  { x: 21.5, y: Y + 3, h: 2, label: 'Enter', id: 'enter' },
  { x: 18.5, y: Y + 4, w: 2, label: '0', id: 'num0' }, { x: 20.5, y: Y + 4, label: '.', id: 'numdecimal' },
];
const WIDTH = 22.5, HEIGHT = Y + 5; // in key widths

// What pressing a key while choosing chooses, by KeyboardEvent.code
const CODES: Record<string, string> = {
  Escape: 'esc', Backquote: 'backquote', Minus: 'minus', Equal: 'equals', Backspace: 'backspace', Tab: 'tab', Enter: 'enter',
  NumpadEnter: 'enter', BracketLeft: 'bracketleft', BracketRight: 'bracketright', Backslash: 'backslash', Semicolon: 'semicolon',
  Quote: 'quote', Comma: 'comma', Period: 'period', Slash: 'slash', Space: 'space', Insert: 'insert', Delete: 'delete', Home: 'home',
  End: 'end', PageUp: 'pageup', PageDown: 'pagedown', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  NumpadDivide: 'numdivide', NumpadMultiply: 'nummultiply', NumpadSubtract: 'numsubtract', NumpadAdd: 'numadd', NumpadDecimal: 'numdecimal',
  ShiftLeft: 'shift', ShiftRight: 'shift', ControlLeft: 'ctrl', ControlRight: 'ctrl', AltLeft: 'alt', AltRight: 'alt',
};
const codeToId = (code: string): string | undefined => {
  if (CODES[code]) return CODES[code];
  let m = /^Key([A-Z])$/.exec(code); if (m) return m[1].toLowerCase();
  m = /^Digit(\d)$/.exec(code); if (m) return `k${m[1]}`;
  m = /^Numpad(\d)$/.exec(code); if (m) return `num${m[1]}`;
  m = /^F(\d{1,2})$/.exec(code); if (m && Number(m[1]) <= 12) return `f${m[1]}`;
  return undefined;
};

interface Props {
  selected: ReadonlySet<string>;
  onToggle(id: string): void;
  disabled?: boolean;
  listen?: boolean; // pressing a key chooses it too (Escape excepted, which the dialog closes on)
}

// A whole keyboard and mouse to choose buttons on: what can be chosen is lit when chosen, what can't is
// greyed out and says why. It takes its container's width.
export default function Keyboard({ selected, onToggle, disabled, listen }: Props) {
  const full = selected.size >= MAX_BUTTONS;
  useEffect(() => {
    if (!listen || disabled) return;
    const onKey = (e: KeyboardEvent) => {
      // A modifier pressed on its own chooses it; held with another key, that key isn't chosen
      const alone = /^(Shift|Control|Alt)(Left|Right)$/.test(e.code);
      if (e.code === 'Escape' || e.repeat || e.metaKey || (!alone && (e.ctrlKey || e.altKey))) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const id = codeToId(e.code);
      if (!id || !BY_ID.has(id)) return;
      e.preventDefault(); // Tab mustn't move focus, nor Space press the focused key a second time
      if (selected.has(id) || !full) onToggle(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listen, disabled, selected, full, onToggle]);

  const key = (k: Key, i: number) => {
    const on = !!k.id && selected.has(k.id);
    const why = k.blocked ?? (k.id && !on && full ? `At most ${MAX_BUTTONS} buttons can be recorded at once` : undefined);
    const style = { '--x': k.x, '--y': k.y, '--w': k.w ?? 1, '--h': k.h ?? 1 } as CSSProperties;
    return (
      <button key={i} type="button" style={style} aria-pressed={k.id ? on : undefined} aria-label={k.id ? buttonLabel(k.id) : k.label}
        className={`kb-key${on ? ' kb-key-on' : ''}${k.blocked ? ' kb-key-blocked' : ''}`}
        disabled={disabled || !!why} title={why ?? (k.id ? `${buttonLabel(k.id)}: ${on ? 'recorded; click to leave out' : 'click to record'}` : undefined)}
        onClick={() => k.id && onToggle(k.id)}>{k.label}</button>
    );
  };
  return (
    <div className="kb">
      <div className="kb-board" style={{ '--cols': WIDTH, '--rows': HEIGHT } as CSSProperties}>
        {BOARD.map(key)}
      </div>
      <div className="kb-mouse" aria-label="Mouse buttons">
        {([['lmb', 'Left'], ['mmb', 'Middle'], ['rmb', 'Right']] as const).map(([id, label]) => {
          const on = selected.has(id);
          return (
            <button key={id} type="button" aria-pressed={on} aria-label={buttonLabel(id)}
              className={`kb-mouse-btn${on ? ' kb-key-on' : ''}`} disabled={disabled || (!on && full)}
              title={!on && full ? `At most ${MAX_BUTTONS} buttons can be recorded at once` : `${label} mouse button: ${on ? 'recorded; click to leave out' : 'click to record'}`}
              onClick={() => onToggle(id)}>{label}<small>click</small></button>
          );
        })}
      </div>
    </div>
  );
}
