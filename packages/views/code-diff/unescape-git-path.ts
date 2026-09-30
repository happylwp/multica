/**
 * Decode a git path from a unified-diff header.
 * Handles a/ b/ prefixes, /dev/null, quoted C-style paths, and octal UTF-8.
 */
export function unescapeGitPath(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = decodeQuotedGitPath(s.slice(1, -1));
  }
  if (s === "/dev/null") return "";
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return s;
}

function decodeQuotedGitPath(body: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      let oct = "";
      let j = i + 1;
      while (j < body.length && oct.length < 3) {
        const digit = body[j];
        if (digit === undefined || digit < "0" || digit > "7") break;
        oct += digit;
        j++;
      }
      bytes.push(parseInt(oct, 8));
      i = j - 1;
      continue;
    }
    switch (next) {
      case "n":
        bytes.push(0x0a);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "r":
        bytes.push(0x0d);
        break;
      case '"':
        bytes.push(0x22);
        break;
      case "\\":
        bytes.push(0x5c);
        break;
      default:
        bytes.push(body.charCodeAt(i + 1));
    }
    i++;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
}
