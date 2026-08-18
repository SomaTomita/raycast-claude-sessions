/** Single-quotes a value for /bin/sh. */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** Double-quotes a value for AppleScript. */
export function appleQuote(value: string): string {
  return `"${value.split("\\").join("\\\\").split('"').join('\\"')}"`;
}
