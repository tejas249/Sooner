/**
 * One short line of plain text that is safe to store and to log: control characters become spaces, runs of whitespace
 * collapse, and the result is cut to `max` characters. Error messages and provider text go through this before they are
 * written anywhere.
 */
export function oneLine(text: string, max = 300): string {
  const plain = [...text]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const characters = [...plain];
  return characters.length <= max ? plain : `${characters.slice(0, Math.max(max - 1, 0)).join("")}…`;
}
