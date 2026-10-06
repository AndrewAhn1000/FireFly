// Lua results arrive as JSON. Check the declared type without coercing the value.
export function stateValueError(type: string, value: unknown): string | null {
  const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  const fields = object ? value as Record<string, unknown> : {};
  let valid: boolean;
  let expected: string;
  switch (type) {
    case 'number': valid = number(value); expected = 'Number (a finite number)'; break;
    case 'boolean': valid = typeof value === 'boolean'; expected = 'Boolean (true or false)'; break;
    case 'text': valid = typeof value === 'string'; expected = 'Text (a string)'; break;
    case 'vector':
      valid = Array.isArray(value) ? value.length === 2 && value.every(number) : object && number(fields.x) && number(fields.y);
      expected = 'Vector ({x, y} or two numbers)'; break;
    case 'collection':
      // The native Lua bridge serializes an empty table as {}, including empty lists.
      valid = Array.isArray(value) || (object && Object.keys(fields).length === 0);
      expected = 'Collection / List (an array)'; break;
    case 'object': valid = object; expected = 'Object / Struct (named fields)'; break;
    case 'category': valid = typeof value === 'string' || number(value); expected = 'Category / Enum (a string or number)'; break;
    // Image and Grid have no defined Lua representation yet.
    default: return null;
  }
  if (valid) return null;
  const actual = value == null ? 'nil' : Array.isArray(value) ? 'a list' : object ? 'an object' : typeof value === 'number' && !Number.isFinite(value) ? 'a non-finite number' : `a ${typeof value}`;
  return `Expected ${expected}, but Lua returned ${actual}. Change the State type or the script's return value.`;
}
