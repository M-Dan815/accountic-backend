import { toLatinDigits, normalizeText } from "@/lib/arabic";
import { loadGrids, sniffKind, type Cell } from "./grid";
import { buildColumns, findHeaderBlock, readTrialBalance, resolveIdentityColumns, sheetScore } from "./readTrialBalance";
import { splitCodeName, isTotalLabel } from "./accountCell";
import type { ColumnTemplate, Role } from "./types";

/** A client's own chart of accounts, read from any Excel/CSV (or from a trial balance that lists every account). */
export type TreeAccount = { code: string; name: string; parentCode: string | null; typeHint: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE" | null; postable: boolean; sourceRow: number };
export type TreeRead = {
  status: "OK" | "NEEDS_MAPPING";
  message?: string;
  accounts: TreeAccount[];
  preview: Cell[][];
  sheet: string;
};

const cs = (v: Cell | undefined) => (v === undefined ? "" : String(v));

export function typeFromText(t: string): TreeAccount["typeHint"] {
  const n = normalizeText(t);
  if (/اصول|ASSET/.test(n)) return "ASSET";
  if (/خصوم|التزامات|LIAB/.test(n)) return "LIABILITY";
  if (/حقوق|EQUITY|CAPITAL/.test(n)) return "EQUITY";
  if (/ايراد|REVENUE|INCOME|SALES/.test(n)) return "REVENUE";
  if (/مصروف|مصاريف|تكلف|EXPENSE|COST/.test(n)) return "EXPENSE";
  return null;
}
const typeFromCode = (c: string): TreeAccount["typeHint"] =>
  (({ "1": "ASSET", "2": "LIABILITY", "3": "EQUITY", "4": "REVENUE", "5": "EXPENSE" }) as Record<string, TreeAccount["typeHint"]>)[c[0]] ?? null;

export function readChartTree(buf: Buffer, fileName = "", template?: ColumnTemplate): TreeRead {
  const kind = sniffKind(buf, fileName);
  if (kind === "pdf" || kind === "unknown") return { status: "NEEDS_MAPPING", accounts: [], preview: [], sheet: "", message: "الصيغ المقبولة لشجرة الحسابات: Excel أو CSV." };
  const grids = loadGrids(buf, fileName);
  if (!grids.length) return { status: "NEEDS_MAPPING", accounts: [], preview: [], sheet: "", message: "الملف فارغ." };
  const grid = template?.sheet ? grids.find((g) => g.name === template.sheet) ?? grids[0] : [...grids].sort((a, b) => sheetScore(b) - sheetScore(a))[0];
  const rows = grid.rows;
  const preview = rows.slice(0, 30);
  const width = Math.max(0, ...rows.map((r) => r.length));

  let cols: { index: number; label: string; role: Role }[];
  let start: number;
  if (template) {
    cols = Array.from({ length: width }, (_, i) => ({ index: i, label: "", role: (template.roles[String(i)] ?? "ignore") as Role }));
    start = template.dataStartRow;
  } else {
    const block = findHeaderBlock(rows);
    if (!block) return fromTrialBalance(buf, fileName, preview, grid.name);
    cols = buildColumns(rows, block, width);
    start = block[block.length - 1] + 1;
    resolveIdentityColumns(cols, rows.slice(start));
  }
  const col = (r: Role) => cols.find((c) => c.role === r)?.index;
  const codeC = col("code"), nameC = col("name"), cnC = col("code_name"), typeC = col("type"), parentC = col("parent");
  if (codeC === undefined && cnC === undefined) return fromTrialBalance(buf, fileName, preview, grid.name);

  const out: TreeAccount[] = [];
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    let code: string | null = null, name = "";
    if (cnC !== undefined) ({ code, name } = splitCodeName(cs(row[cnC])));
    if (nameC !== undefined && cs(row[nameC]).trim()) name = cs(row[nameC]).trim();
    if (codeC !== undefined) { const c = toLatinDigits(cs(row[codeC]).trim()); if (c) code = c; }
    if (!code || !name || isTotalLabel(name)) continue;
    const parentRaw = parentC !== undefined ? toLatinDigits(cs(row[parentC]).trim()) : "";
    out.push({ code, name, parentCode: parentRaw || null, typeHint: (typeC !== undefined ? typeFromText(cs(row[typeC])) : null) ?? typeFromCode(code), postable: true, sourceRow: r + 1 });
  }
  return finish(out, preview, grid.name);
}

function finish(list: TreeAccount[], preview: Cell[][], sheet: string): TreeRead {
  if (list.length < 2) return { status: "NEEDS_MAPPING", accounts: [], preview, sheet, message: "لم نجد أرقام حسابات وأسماء. حدّد الأعمدة من الجدول." };
  const codes = list.map((a) => a.code);
  const seen = new Set<string>();
  const accounts = list.filter((a) => (seen.has(a.code) ? false : (seen.add(a.code), true)));
  for (const a of accounts) {
    // parent: explicit, else the longest other code that is a prefix of this one
    if (!a.parentCode) {
      const parents = codes.filter((c) => c !== a.code && a.code.startsWith(c) && a.code.length > c.length).sort((x, y) => y.length - x.length);
      a.parentCode = parents[0] ?? null;
    }
  }
  const parentSet = new Set(accounts.map((a) => a.parentCode).filter(Boolean));
  for (const a of accounts) a.postable = !parentSet.has(a.code);
  return { status: "OK", accounts, preview, sheet };
}

/** "أو ميزان فيه كل الحسابات" (§6.1): a trial balance lists every account, so it doubles as a tree. */
function fromTrialBalance(buf: Buffer, fileName: string, preview: Cell[][], sheet: string): TreeRead {
  const tb = readTrialBalance(buf, fileName);
  if (tb.status !== "OK") return { status: "NEEDS_MAPPING", accounts: [], preview, sheet, message: tb.message };
  const list: TreeAccount[] = [
    ...tb.structure.map((s) => ({ code: s.code, name: s.name, parentCode: null, typeHint: typeFromCode(s.code), postable: true, sourceRow: 0 })),
    ...tb.accounts.filter((a) => a.code).map((a) => ({ code: a.code!, name: a.name, parentCode: null, typeHint: typeFromCode(a.code!), postable: true, sourceRow: a.sourceRow })),
  ];
  return finish(list, preview, sheet);
}
