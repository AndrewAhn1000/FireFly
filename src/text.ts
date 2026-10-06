// Text shortened to fit on one line: line breaks show as ⏎, and a long text ends in …
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s*[\r\n]+\s*/g, ' ⏎ ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
