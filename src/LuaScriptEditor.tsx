import { useId, useRef, useState } from 'react';
import { indentLua, nameCompletion } from './luaEditing';

export default function LuaScriptEditor({ value, onChange, regions, states, excludeId, label }: {
  value: string; onChange(value: string): void; label: string;
  regions: { id: string; label: string }[]; excludeId?: string;
  // The States a script can read, with what each holds; excludeId leaves out the one being edited too
  states: { id: string; label: string; detail: string }[];
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null), linesRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0), [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0), [dismissed, setDismissed] = useState(false);
  const listId = useId();
  const regionItems = regions.map(r => ({ ...r, detail: 'List of x, y, w, h boxes' }));
  const completion = focused && !dismissed
    ? nameCompletion('regions', value, caret, regionItems, excludeId) ?? nameCompletion('states', value, caret, states, excludeId) : null;
  const selected = completion ? Math.min(active, completion.options.length - 1) : 0;
  const input = inputRef.current;
  const menuHeight = Math.min(180, (completion?.options.length ?? 0) * 32 + 2);
  const menuTop = input ? Math.max(input.offsetTop, Math.min(input.offsetTop + input.clientHeight - menuHeight,
    input.offsetTop + 8 + value.slice(0, caret).split('\n').length * 17.6 - input.scrollTop)) : 0;
  const apply = (text: string, start: number, end = start) => {
    const input = inputRef.current, scroll = input?.scrollTop ?? 0;
    onChange(text); setDismissed(true); setCaret(start);
    requestAnimationFrame(() => { if (input) { input.focus(); input.setSelectionRange(start, end); input.scrollTop = scroll; } });
  };
  const insert = (index: number) => {
    if (!completion) return;
    const expression = completion.options[index].expression;
    apply(value.slice(0, completion.start) + expression + value.slice(completion.end), completion.start + expression.length);
  };
  return <div className="lua-script-field">
    <div className="modal-form-sub">Regions are available as <code>regions.Minimap</code> or <code>regions["Mini Map"]</code>. Each returns a list of boxes: <code>regions.Minimap[1].x</code>. Memory and Lua States are available as <code>states.Camera</code>, the value its script returns (<code>states.Camera.x</code>), read once each time this script runs. Type <code>regions.</code> or <code>states.</code> for names. Names must be unique.</div>
    <div className="script-editor-wrap">
      <div className="script-line-nums" ref={linesRef}>{value.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}</div>
      <textarea ref={inputRef} className="state-script-editor" aria-label={label} spellCheck={false} value={value}
        aria-autocomplete="list" aria-controls={completion ? listId : undefined}
        aria-activedescendant={completion ? `${listId}-${selected}` : undefined}
        onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); setDismissed(true); }}
        onSelect={e => { const input = e.currentTarget; setCaret(input.selectionStart); if (input.selectionStart !== input.selectionEnd) setDismissed(true); }}
        onChange={e => { setFocused(true); setCaret(e.target.selectionStart); setActive(0); setDismissed(false); onChange(e.target.value); }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
          if (completion && ['ArrowDown', 'ArrowUp', 'Escape', 'Enter', 'Tab'].includes(e.key) && !e.shiftKey) {
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Escape') setDismissed(true);
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setActive((selected + (e.key === 'ArrowDown' ? 1 : -1) + completion.options.length) % completion.options.length);
            else insert(selected);
            return;
          }
          if (e.key !== 'Tab') return;
          e.preventDefault(); e.stopPropagation();
          const input = e.currentTarget, edit = indentLua(input.value, input.selectionStart, input.selectionEnd, e.shiftKey);
          apply(edit.text, edit.start, edit.end);
        }}
        onScroll={() => { setDismissed(true); if (linesRef.current && inputRef.current) linesRef.current.scrollTop = inputRef.current.scrollTop; }} />
    </div>
    {completion && <div id={listId} className="lua-completions" style={{ top: menuTop, maxHeight: menuHeight }} role="listbox" aria-label="Name suggestions">
      {completion.options.map((r, i) => <button type="button" role="option" aria-selected={selected === i} id={`${listId}-${i}`} key={r.id}
        onMouseDown={e => e.preventDefault()} onClick={() => insert(i)}>
        <code>{r.expression}</code><span>{r.detail}</span>
      </button>)}
    </div>}
  </div>;
}
