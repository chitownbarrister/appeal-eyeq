// Turns a PDF page's text layer (pdf.js text items) into lines of text, top to
// bottom and left to right, the same shape OCR gives, so one set of parsers reads both.

export interface TextItem { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }

export function linesFromTextItems(items: TextItem[]): string {
  const parts = items
    .filter((it) => typeof it.str === "string" && it.str.trim() !== "")
    .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.height) || Math.abs(it.transform[3]) || 10 }));
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: (typeof parts)[] = [];
  for (const p of parts) {
    const line = lines.find((l) => Math.abs(l[0].y - p.y) <= Math.max(2, Math.min(l[0].h, p.h) * 0.5));
    if (line) line.push(p);
    else lines.push([p]);
  }
  lines.sort((a, b) => b[0].y - a[0].y);
  return lines
    .map((line) => {
      line.sort((a, b) => a.x - b.x);
      let out = "";
      let end: number | null = null;
      for (const p of line) {
        if (end !== null) {
          const gap = p.x - end;
          if (gap > p.h * 2) out += "    ";
          else if (gap > p.h * 0.2 && !out.endsWith(" ") && !p.str.startsWith(" ")) out += " ";
        }
        out += p.str;
        end = p.x + p.w;
      }
      return out.replace(/\s+$/, "");
    })
    .join("\n");
}
