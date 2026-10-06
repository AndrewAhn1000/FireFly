export const NEW_INPUT = 'in:+';
const RESERVED = new Set(['and', 'or', 'not', 'true', 'false', 'if']);
export const isAlias = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name) && name.length <= 40;

export function aliasFrom(label: string, taken: string[]): string {
  let base = label.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'x';
  if (/^[0-9]/.test(base) || RESERVED.has(base)) base = `v_${base}`;
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}_${n}`;
  return name;
}

// Rename whole identifiers, preserving quoted observation names and vector members.
export const renameIn = (source: string, from: string, to: string) =>
  source.split(/(`[^`]*`)/).map(part => part.startsWith('`') ? part
    : part.replace(new RegExp(`(?<![A-Za-z0-9_.])${from}(?![A-Za-z0-9_])`, 'g'), to)).join('');
