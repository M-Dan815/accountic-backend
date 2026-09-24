import { normalizeText, toLatinDigits } from "@/lib/arabic";
import { loadGrids, sniffKind, type Cell, type Grid } from "./grid";
import { parseAmount, round2 } from "./numbers";
import { splitCodeName, isTotalLabel, isFooterNoise } from "./accountCell";
import { AMOUNT_ROLES, composeLabel, roleOfLabel } from "./headers";
import type { ColumnTemplate, ParsedAccount, ReadResult, Role } from "./types";

/**
 * Universal trial-balance reader (spec §5). One reader for قيود, دفترة,
 * قوائم, رواء, Odoo, Zoho Books and hand-made Excel files. When it cannot be
 * sure it says NEEDS_MAPPING (with the first 30 rows) instead of an error, so
 * the UI can show the manual column screen (§5.3).
 */

const HEADER_SCAN_ROWS = 40;
const isAmountRole = (r: Role) => AMOUNT_ROLES.includes(r);
const cellStr = (v: Cell | undefined) => (v === undefined ? "" : String(v));

function looksNumeric(v: Cell | undefined): boolean {
  if (v === undefined || v === "") return false;
  if (typeof v === "number") return true;
  const s = toLatinDigits(String(v)).trim();
  if (/[A-Za-z\u0600-\u06FF]/.test(s.replace(/(SAR|SR|DR|CR|مدين|دائن|ر\.?س|ريال)/gi, ""))) return false;
  return parseAmount(s) !== null;
}

export function sheetScore(g: Grid): number {
  let n = 0;
  for (const r of g.rows) {
    const hasText = r.some((c) => typeof c === "string" && /[A-Za-z\u0600-\u06FF]/.test(c));
    const hasNum = r.some((c) => looksNumeric(c) && typeof c === "number" ? true : looksNumeric(c) && String(c).includes(".") );
    if (hasText && hasNum) n++;
  }
  return n;
}

function rowHits(row: Cell[]): number {
  let h = 0;
  for (const c of row) {
    if (looksNumeric(c)) continue;
    if (roleOfLabel(cellStr(c)) !== "ignore") h++;
  }
  return h;
}

export function findHeaderBlock(rows: Cell[][]): number[] | null {
  let start = -1;
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    if (rowHits(rows[i]) >= 2) { start = i; break; }
  }
  if (start < 0) return null;
  const block = [start];
  for (let i = start + 1; i < Math.min(rows.length, start + 4); i++) {
    const r = rows[i];
    const hits = rowHits(r);
    const amounts = r.filter((c) => looksNumeric(c)).length;
    if (hits >= 1 && amounts === 0 && r.filter((c) => cellStr(c)).length >= 2) block.push(i);
    else break;
  }
  return block;
}

export function buildColumns(rows: Cell[][], headerRows: number[], width: number) {
  const GROUP = /افتتاح|ختام|اقفال|حركه|حركات|صافي|OPENING|CLOSING|ENDING|MOVEMENT|NET|BEGINNING|INITIAL/;
  // Parent header rows: a group label ("الرصيد الافتتاحي") that was merged over two
  // columns is already expanded by the grid loader; if the file used blank cells
  // instead, carry the group label forward across the blanks.
  const filled = headerRows.map((hr, k) => {
    const row = rows[hr] ?? [];
    const out: string[] = [];
    let last = "";
    for (let c = 0; c < width; c++) {
      const v = cellStr(row[c]).trim();
      if (v) { last = GROUP.test(normalizeText(v)) ? v : ""; out.push(v); }
      else out.push(k < headerRows.length - 1 ? last : "");
    }
    return out;
  });
  const cols: { index: number; label: string; role: Role }[] = [];
  for (let c = 0; c < width; c++) {
    const label = composeLabel(filled.map((f) => f[c] ?? ""));
    cols.push({ index: c, label, role: roleOfLabel(label) });
  }
  return cols;
}

/** Decide code / name / code_name from data when headers are vague. */
export function resolveIdentityColumns(cols: { index: number; label: string; role: Role }[], data: Cell[][]) {
  const sample = data.slice(0, 200);
  const stat = (c: number) => {
    let n = 0, letters = 0, digitsOnly = 0, mixed = 0;
    for (const r of sample) {
      const s = cellStr(r[c]).trim();
      if (!s) continue;
      n++;
      const t = toLatinDigits(s);
      if (/^\d{1,12}(\.\d+)*$/.test(t)) digitsOnly++;
      else if (/[A-Za-z\u0600-\u06FF]/.test(t)) { letters++; if (splitCodeName(t).code) mixed++; }
    }
    return { n, letters, digitsOnly, mixed };
  };
  const hasRole = (r: Role) => cols.some((c) => c.role === r);
  for (const col of cols) {
    if (col.role === "name" || (col.role === "ignore" && !hasRole("name") && !hasRole("code_name"))) {
      const s = stat(col.index);
      if (s.letters >= 3 && s.mixed / Math.max(1, s.letters) > 0.5) col.role = "code_name";
      else if (col.role === "ignore" && s.letters >= 3 && !hasRole("name")) col.role = "name";
    }
  }
  if (!hasRole("code") && !hasRole("code_name")) {
    const cand = cols.filter((c) => c.role === "ignore").find((c) => {
      const s = stat(c.index);
      return s.n >= 3 && s.digitsOnly / s.n > 0.7;
    });
    if (cand) cand.role = "code";
  }
}

export function readTrialBalance(buf: Buffer, fileName = "", template?: ColumnTemplate): ReadResult {
  const kind = sniffKind(buf, fileName);
  if (kind === "pdf" || kind === "unknown") {
    return needsMapping([], "لم نتمكن من قراءة هذا النوع من الملفات. الصيغ المقبولة: Excel (xlsx / xls) أو CSV. يمكنك تصدير الميزان من نظامك المحاسبي بإحدى هذه الصيغ، أو إدخال الأرصدة يدويًا.", "");
  }
  let grids: Grid[];
  try { grids = loadGrids(buf, fileName); } catch {
    return needsMapping([], "تعذّر فتح الملف. تأكد أنه ملف Excel أو CSV سليم، أو أدخل الأرصدة يدويًا.", "");
  }
  if (grids.length === 0) return needsMapping([], "الملف فارغ.", "");

  const grid = template?.sheet
    ? grids.find((g) => g.name === template.sheet) ?? grids[0]
    : [...grids].sort((a, b) => sheetScore(b) - sheetScore(a))[0];
  const rows = grid.rows;
  const width = Math.max(0, ...rows.map((r) => r.length));
  const preview = rows.slice(0, 30);

  let headerRows: number[];
  let dataStart: number;
  let columns: { index: number; label: string; role: Role }[];

  if (template) {
    headerRows = template.headerRows ?? [];
    dataStart = template.dataStartRow;
    columns = Array.from({ length: width }, (_, i) => ({
      index: i,
      label: composeLabel(headerRows.map((h) => cellStr(rows[h]?.[i]))),
      role: (template.roles[String(i)] ?? "ignore") as Role,
    }));
  } else {
    const block = findHeaderBlock(rows);
    if (!block) return needsMapping(preview, "لم نجد صف العناوين تلقائيًا. حدّد صف العناوين وأعمدة الحساب والمبالغ من الجدول.", grid.name);
    headerRows = block;
    dataStart = block[block.length - 1] + 1;
    columns = buildColumns(rows, headerRows, width);
    resolveIdentityColumns(columns, rows.slice(dataStart));
  }

  const roleCol = (r: Role) => columns.find((c) => c.role === r)?.index;
  const codeCol = roleCol("code");
  const nameCol = roleCol("name");
  const cnCol = roleCol("code_name");
  const amountCols = columns.filter((c) => isAmountRole(c.role));
  const titleLines = rows.slice(0, headerRows[0] ?? 0).map((r) => r.map(cellStr).filter(Boolean)[0] ?? "").filter(Boolean).slice(0, 5);

  if ((codeCol === undefined && nameCol === undefined && cnCol === undefined) || amountCols.length === 0) {
    return { ...needsMapping(preview, "لم نتعرف على أعمدة الحساب أو المبالغ. حدّد دور كل عمود من الجدول.", grid.name), columns, headerRows, dataStartRow: dataStart, titleLines };
  }

  const has = (r: Role) => amountCols.some((c) => c.role === r);
  const basis: ReadResult["basis"] =
    has("closing_debit") || has("closing_credit") || has("closing_balance") ? "closing"
    : has("opening_debit") || has("opening_credit") || has("opening_balance") || has("movement_debit") || has("movement_credit") || has("net_debit") || has("net_credit") ? "opening+movement"
    : has("debit") || has("credit") ? "debit-credit"
    : "signed-balance";

  const amt = (row: Cell[], r: Role): number | null => {
    const c = roleCol(r);
    return c === undefined ? null : parseAmount(row[c]);
  };
  const pair = (row: Cell[], d: Role, c: Role): number | null => {
    const a = amt(row, d), b = amt(row, c);
    if (a === null && b === null) return null;
    return (a ?? 0) - (b ?? 0);
  };

  const warnings: string[] = [];
  const structure: { code: string; name: string }[] = [];
  const accounts: ParsedAccount[] = [];
  const totalRows: { row: Cell[] }[] = [];
  const headerLabelSet = new Set(columns.map((c) => normalizeText(c.label)).filter(Boolean));

  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r];
    let code: string | null = null;
    let name = "";
    if (cnCol !== undefined) {
      const cn = splitCodeName(cellStr(row[cnCol]));
      code = cn.code; name = cn.name;
    }
    if (nameCol !== undefined) {
      const n = cellStr(row[nameCol]).trim();
      if (n) {
        if (cnCol === undefined && codeCol === undefined) { const cn = splitCodeName(n); code = cn.code; name = cn.name || n; }
        else name = n;
      }
    }
    if (codeCol !== undefined) {
      const c = toLatinDigits(cellStr(row[codeCol]).trim());
      if (c && /^[\dA-Za-z.\-_/]+$/.test(c)) code = c.replace(/\.0+$/, "");
    }
    const label = name || code || "";
    if (!label) continue;
    if (isFooterNoise(label)) continue;
    if (isTotalLabel(label) || (codeCol !== undefined && isTotalLabel(cellStr(row[codeCol])))) { totalRows.push({ row }); continue; }
    // repeated header row on a new page
    const nonNumeric = row.filter((c) => cellStr(c) && !looksNumeric(c)).map((c) => normalizeText(cellStr(c)));
    if (nonNumeric.length >= 2 && nonNumeric.filter((x) => headerLabelSet.has(x)).length >= 2) continue;

    let debit = 0, credit = 0, balance: number | null = null;
    if (basis === "closing") {
      balance = pair(row, "closing_debit", "closing_credit") ?? amt(row, "closing_balance");
    } else if (basis === "opening+movement") {
      const o = pair(row, "opening_debit", "opening_credit") ?? amt(row, "opening_balance");
      const m = pair(row, "movement_debit", "movement_credit") ?? pair(row, "net_debit", "net_credit");
      balance = o === null && m === null ? null : (o ?? 0) + (m ?? 0);
    } else if (basis === "debit-credit") {
      balance = pair(row, "debit", "credit");
    } else balance = amt(row, "balance");

    if (balance === null) { if (code) structure.push({ code, name }); continue; }
    if (balance > 0) debit = balance; else credit = -balance;
    accounts.push({ code, name, balance: round2(balance), debit: round2(debit), credit: round2(credit), sourceRow: r + 1 });
  }

  // Leaf detection: a coded row is FINAL only if no other code starts with it (§5.2 step 6).
  const allCodes = [...structure.map((s) => s.code), ...accounts.map((a) => a.code).filter((c): c is string => !!c)];
  const isAncestor = (a: string, b: string) => b !== a && b.length > a.length && (b.startsWith(a + ".") || (!a.includes(".") && !b.includes(".") ? b.startsWith(a) : false));
  const parentsWithAmounts: string[] = [];
  const finals = accounts.filter((a) => {
    if (!a.code) return true;
    const isParent = allCodes.some((c) => isAncestor(a.code!, c));
    if (isParent) parentsWithAmounts.push(a.code);
    return !isParent;
  });
  for (const a of accounts) if (a.code && !finals.includes(a)) structure.push({ code: a.code, name: a.name });

  // Signed-balance sheets sometimes print natural signs (credit accounts positive).
  let final = finals;
  if (basis === "signed-balance" && final.length > 2) {
    const sum = round2(final.reduce((s, a) => s + a.balance, 0));
    if (Math.abs(sum) > 1) {
      const flipped = final.map((a) => (a.code && /^[2-4]/.test(a.code) ? { ...a, balance: -a.balance } : a));
      const sum2 = round2(flipped.reduce((s, a) => s + a.balance, 0));
      if (Math.abs(sum2) < Math.abs(sum) && Math.abs(sum2) <= 1) {
        final = flipped.map((a) => ({ ...a, debit: a.balance > 0 ? a.balance : 0, credit: a.balance < 0 ? -a.balance : 0 }));
        warnings.push("الأرصدة في الملف مكتوبة بإشارة طبيعية الحساب (الدائن موجب)، وتم تحويلها إلى مدين/دائن تلقائيًا.");
      }
    }
  }

  if (final.length === 0) {
    return { ...needsMapping(preview, "لم نجد أي صف حساب بمبلغ. تأكد من صف البداية وأعمدة المبالغ.", grid.name), columns, headerRows, dataStartRow: dataStart, titleLines };
  }

  const totalDebit = round2(final.reduce((s, a) => s + a.debit, 0));
  const totalCredit = round2(final.reduce((s, a) => s + a.credit, 0));
  const difference = round2(totalDebit - totalCredit);

  // Compare with the file's own grand total (last total row that has amounts).
  let matchesFileTotal: boolean | null = null;
  for (let i = totalRows.length - 1; i >= 0; i--) {
    const row = totalRows[i].row;
    const d = basis === "closing" ? amt(row, "closing_debit") : basis === "debit-credit" ? amt(row, "debit") : null;
    const c = basis === "closing" ? amt(row, "closing_credit") : basis === "debit-credit" ? amt(row, "credit") : null;
    if (d !== null && c !== null && d + c > 0) {
      matchesFileTotal = Math.abs(d - totalDebit) <= 1 && Math.abs(c - totalCredit) <= 1;
      break;
    }
  }
  if (matchesFileTotal === false) warnings.push("مجموع الحسابات النهائية لا يطابق سطر الإجمالي في الملف. راجع المعاينة قبل الاعتماد.");
  if (Math.abs(difference) > 0.01) warnings.push(`الميزان غير متوازن: مجموع المدين ${totalDebit.toLocaleString("en-US")} ومجموع الدائن ${totalCredit.toLocaleString("en-US")} (الفرق ${Math.abs(difference).toLocaleString("en-US")}).`);
  if (parentsWithAmounts.length > 0) warnings.push("بعض الحسابات التجميعية عليها مبالغ في الملف، وتم تجاهلها وأخذ المبالغ من الحسابات النهائية فقط.");

  const period = detectPeriod(titleLines.concat(rows.slice(0, headerRows[0] ?? 0).flat().map(cellStr)));
  return {
    status: "OK", sheet: grid.name, headerRows, dataStartRow: dataStart, columns, accounts: final, structure, basis,
    totals: { rows: final.length, debit: totalDebit, credit: totalCredit, difference, balanced: Math.abs(difference) <= 0.01, matchesFileTotal },
    warnings, titleLines, period, preview, usedTemplate: !!template,
  };
}

function needsMapping(preview: Cell[][], message: string, sheet: string): ReadResult {
  return {
    status: "NEEDS_MAPPING", message, sheet, headerRows: [], dataStartRow: 0, columns: [], accounts: [], structure: [], basis: "none",
    totals: { rows: 0, debit: 0, credit: 0, difference: 0, balanced: false, matchesFileTotal: null },
    warnings: [], titleLines: [], preview, usedTemplate: false,
  };
}

function detectPeriod(lines: string[]): { from?: string; to?: string; year?: number } | undefined {
  const text = toLatinDigits(lines.join(" | "));
  const iso = [...text.matchAll(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g)].map((m) => `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  const dmy = [...text.matchAll(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/g)].map((m) => `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  const dates = [...iso, ...dmy].sort();
  const year = text.match(/\b(20\d{2})\b/)?.[1];
  if (!dates.length && !year) return undefined;
  return { from: dates[0], to: dates[dates.length - 1], year: year ? Number(year) : undefined };
}
