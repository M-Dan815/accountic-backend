import * as XLSX from "xlsx";

export type Cell = string | number;
export type Grid = { name: string; rows: Cell[][]; merges: number };

function decodeText(buf: Buffer): string {
  let t = buf.toString("utf8");
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  if (t.includes("\uFFFD")) {
    try { t = new TextDecoder("windows-1256").decode(buf); } catch { /* keep utf8 */ }
  }
  return t;
}

function parseDelimited(text: string): Cell[][] {
  const first = text.split(/\r?\n/).slice(0, 15).join("\n");
  const count = (c: string) => (first.match(new RegExp(c === "\t" ? "\\t" : `\\${c}`, "g")) ?? []).length;
  const delim = [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur.replace(/\r$/, "")); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

export type FileKind = "xlsx" | "xls" | "csv" | "pdf" | "unknown";

export function sniffKind(buf: Buffer, fileName = ""): FileKind {
  if (buf.length >= 4 && buf.slice(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return "xlsx";
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf) return "xls";
  if (/\.(csv|txt|tsv)$/i.test(fileName)) return "csv";
  const head = buf.slice(0, 2000).toString("utf8");
  if (/[,;\t]/.test(head) && !head.includes("\u0000")) return "csv";
  return "unknown";
}

/** Every sheet as a rectangular grid with MERGED CELLS EXPANDED. */
export function loadGrids(buf: Buffer, fileName = ""): Grid[] {
  const kind = sniffKind(buf, fileName);
  if (kind === "csv") return [{ name: "CSV", rows: parseDelimited(decodeText(buf)), merges: 0 }];
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const out: Grid[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const rows: Cell[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: Cell[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        row.push(cell ? (cell.t === "n" ? (cell.v as number) : String(cell.w ?? cell.v ?? "")) : "");
      }
      rows.push(row);
    }
    const merges = ws["!merges"] ?? [];
    for (const m of merges) {
      const v = rows[m.s.r - range.s.r]?.[m.s.c - range.s.c];
      if (v === "" || v === undefined) continue;
      for (let r = m.s.r; r <= m.e.r; r++)
        for (let c = m.s.c; c <= m.e.c; c++) {
          const rr = rows[r - range.s.r];
          if (rr && (rr[c - range.s.c] === "" || rr[c - range.s.c] === undefined)) rr[c - range.s.c] = v;
        }
    }
    out.push({ name, rows, merges: merges.length });
  }
  return out;
}
