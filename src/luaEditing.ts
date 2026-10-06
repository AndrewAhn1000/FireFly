export function indentLua(text: string, start: number, end: number, unindent: boolean) {
  const indent = '    ';
  if (start === end && !unindent) return { text: text.slice(0, start) + indent + text.slice(end), start: start + 4, end: start + 4 };
  const first = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const lineEnd = text.indexOf('\n', last);
  const stop = lineEnd < 0 ? text.length : lineEnd;
  const lines = text.slice(first, stop).split('\n');
  const removed = lines.map(line => unindent ? (line.startsWith('\t') ? 1 : (line.match(/^ {0,4}/)?.[0].length ?? 0)) : 0);
  const changed = lines.map((line, i) => unindent ? line.slice(removed[i]) : indent + line).join('\n');
  const delta = changed.length - (stop - first);
  const newStart = unindent ? Math.max(first, start - removed[0]) : start + 4;
  return { text: text.slice(0, first) + changed + text.slice(stop), start: newStart, end: start === end ? newStart : Math.max(newStart, end + delta) };
}

const luaKeywords = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));
// How a script names an entry of a namespace table (regions, states): Minimap, or ["Mini Map"]
function nameExpression(table: string, label: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(label) && !luaKeywords.has(label)
    ? `${table}.${label}` : `${table}[${JSON.stringify(label).replace(/\\u([0-9a-f]{4})/gi, '\\u{$1}')}]`;
}
export const regionExpression = (label: string) => nameExpression('regions', label);

// Do not suggest references inside Lua comments or string literals.
function isCodeAt(text: string, stop: number) {
  for (let i = 0; i < stop;) {
    const long = text.slice(i).match(/^(?:--)?\[(=*)\[/);
    if (long) {
      const end = text.indexOf(`]${long[1]}]`, i + long[0].length);
      if (end < 0 || end >= stop) return false;
      i = end + long[1].length + 2;
    } else if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i);
      if (end < 0 || end >= stop) return false;
      i = end + 1;
    } else if (text[i] === '"' || text[i] === "'") {
      const quote = text[i++];
      while (i < stop && text[i] !== quote) { if (text[i] === '\\') i++; i++; }
      if (i >= stop) return false;
      i++;
    } else i++;
  }
  return true;
}

export function regionCompletion(text: string, caret: number, regions: { id: string; label: string }[], excludeId?: string) {
  return nameCompletion('regions', text, caret, regions, excludeId);
}

// Suggests the names of a namespace table's entries as the script is typed: regions.Mi → regions.Minimap
export function nameCompletion<T extends { id: string; label: string }>(table: string, text: string, caret: number, items: T[], excludeId?: string) {
  const match = text.slice(0, caret).match(new RegExp(`\\b${table}(?:\\.#?([A-Za-z0-9_]*)|\\[(?:"([^"\\n]*)|'([^'\\n]*)))$`));
  if (!match || match.index === undefined || (match.index > 0 && /[\w.:]/.test(text[match.index - 1])) || !isCodeAt(text, match.index)) return null;
  const prefix = (match[1] ?? match[2] ?? match[3] ?? '').toLowerCase();
  const counts = new Map<string, number>();
  items.forEach(r => counts.set(r.label, (counts.get(r.label) ?? 0) + 1));
  const options = items.filter(r => r.id !== excludeId && counts.get(r.label) === 1 && r.label.toLowerCase().startsWith(prefix))
    .map(r => ({ ...r, expression: nameExpression(table, r.label) }));
  const tail = text.slice(caret);
  const suffix = match[1] !== undefined ? tail.match(/^[A-Za-z0-9_]*/)?.[0]
    : match[2] !== undefined ? tail.match(/^(?:\\.|[^"\\\n])*"\s*\]/)?.[0]
    : tail.match(/^(?:\\.|[^'\\\n])*'\s*\]/)?.[0];
  return options.length ? { start: match.index, end: caret + (suffix?.length ?? 0), options } : null;
}
