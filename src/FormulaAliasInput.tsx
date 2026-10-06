import { useEffect, useRef, useState } from 'react';
import { isAlias } from './formulaInputs';

export default function FormulaAliasInput({ alias, taken, onRename, disabled = false }: {
  alias: string; taken: string[]; onRename(next: string): void; disabled?: boolean;
}) {
  const [text, setText] = useState(alias);
  const cancelled = useRef(false);
  useEffect(() => setText(alias), [alias]);
  const commit = () => {
    const next = text.trim();
    if (!disabled && !cancelled.current && next !== alias && isAlias(next) && !taken.includes(next)) onRename(next);
    else setText(alias);
    cancelled.current = false;
  };
  return <input className={`nodrag pg-alias ${text.trim() !== alias && (!isAlias(text.trim()) || taken.includes(text.trim())) ? 'pg-alias-bad' : ''}`}
    aria-label="Input name" value={text} size={Math.max(2, text.length)} spellCheck={false} disabled={disabled}
    title="Its name in the formula: letters, digits and _"
    onChange={e => setText(e.target.value)} onBlur={commit}
    onKeyDown={e => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        if (e.key === 'Enter') commit();
        else setText(alias);
        cancelled.current = true;
        (e.target as HTMLInputElement).blur();
        cancelled.current = false;
      }
    }} />;
}
