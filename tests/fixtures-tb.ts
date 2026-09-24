import * as XLSX from "xlsx";

/** Builds synthetic exports that mimic each system's layout. */
export type Sheet = { rows: (string | number)[][]; merges?: string[]; name?: string };

export function toXlsx(sheets: Sheet[]): Buffer {
  const wb = XLSX.utils.book_new();
  sheets.forEach((s, i) => {
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    if (s.merges) ws["!merges"] = s.merges.map((m) => XLSX.utils.decode_range(m));
    XLSX.utils.book_append_sheet(wb, ws, s.name ?? `Sheet${i + 1}`);
  });
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// Ground truth used by every fixture: final account → closing balance (debit +)
export const TRUTH: Record<string, number> = {
  "110101": 15000, "110102": 250000.5, "110201": 88000, "210101": -42000.25,
  "310101": -191009, "410101": -180000, "530101": 60000, "540102": 8.75,
};
const names: Record<string, string> = {
  "110101": "النقدية في الخزينة", "110102": "البنك - الراجحي", "110201": "العملاء", "210101": "الموردون",
  "310101": "رأس المال", "410101": "مبيعات بضائع", "530101": "رواتب أساسية", "540102": "رسوم وعمولات بنكية",
};
const dr = (n: number) => (n > 0 ? n : 0), cr = (n: number) => (n < 0 ? -n : 0);
const codes = Object.keys(TRUTH);

/** قيود — exactly the layout described in spec §5.1 (2-row merged header, merged code+name cell,
 *  Arabic-Indic digits in the title, group rows without amounts, total rows). */
export function qoyod(): Buffer {
  const rows: (string | number)[][] = [
    ["ميزان المراجعة"], ["شركة نخلة الخليج"], ["الفترة من ٢٠٢٣-٠١-٠١ إلى ٢٠٢٣-١٢-٣١"], [""],
    [""],
    ["الحساب", "الرصيد الافتتاحي", "", "الحركة", "", "صافي الحركة", "", "الرصيد الختامي", ""],
    ["", "مدين", "دائن", "مدين", "دائن", "مدين", "دائن", "مدين", "دائن"],
    ["الأصول - 1", "", "", "", "", "", "", "", ""],
    ["أصول متداولة - 11", "", "", "", "", "", "", "", ""],
    ["النقد وما يعادله - 1101", "", "", "", "", "", "", "", ""],
  ];
  const asset = codes.filter((c) => c.startsWith("1"));
  asset.forEach((c) => {
    const b = TRUTH[c];
    rows.push([`${names[c]} - ${c}`, 0, 0, dr(b), cr(b), dr(b), cr(b), dr(b), cr(b)]);
  });
  rows.push(["مجموع ١١٠١ - النقد ومايعادله", 0, 0, 265000.5, 0, 265000.5, 0, 265000.5, 0]);
  rows.push(["الخصوم - 2"]);
  codes.filter((c) => c.startsWith("2")).forEach((c) => rows.push([`${names[c]} - ${c}`, 0, 0, 0, 42000.25, 0, 42000.25, 0, 42000.25]));
  rows.push(["حقوق الملكية - 3"]);
  codes.filter((c) => c.startsWith("3")).forEach((c) => rows.push([`${names[c]} - ${c}`, 0, 0, 0, 191009, 0, 191009, 0, 191009]));
  rows.push(["الإيرادات - 4"]);
  codes.filter((c) => c.startsWith("4")).forEach((c) => rows.push([`${names[c]} - ${c}`, 0, 0, 0, 180000, 0, 180000, 0, 180000]));
  rows.push(["المصروفات - 5"]);
  codes.filter((c) => c.startsWith("5")).forEach((c) => rows.push([`${names[c]} - ${c}`, 0, 0, dr(TRUTH[c]), 0, dr(TRUTH[c]), 0, dr(TRUTH[c]), 0]));
  const td = codes.reduce((s, c) => s + dr(TRUTH[c]), 0), tc = codes.reduce((s, c) => s + cr(TRUTH[c]), 0);
  rows.push(["الإجمالي", 0, 0, td, tc, td, tc, td, tc]);
  return toXlsx([{ rows, merges: ["B6:C6", "D6:E6", "F6:G6", "H6:I6", "A6:A7"] }]);
}

/** Code in its own column, single header row, English (Zoho Books-like). */
export function zoho(): Buffer {
  const rows: (string | number)[][] = [["Trial Balance"], ["As of 31 Dec 2023"], [""], ["Account", "Account Code", "Debit", "Credit"]];
  codes.forEach((c) => rows.push([names[c], c, dr(TRUTH[c]), cr(TRUTH[c])]));
  rows.push(["Total", "", codes.reduce((s, c) => s + dr(TRUTH[c]), 0), codes.reduce((s, c) => s + cr(TRUTH[c]), 0)]);
  return toXlsx([{ rows }]);
}

/** Odoo: "110101 Cash" in one cell, Debit/Credit/Balance, numbers as text with commas. */
export function odoo(): Buffer {
  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2 });
  const rows: (string | number)[][] = [["Trial Balance"], [""], ["Account", "Debit", "Credit", "Balance"]];
  codes.forEach((c) => rows.push([`${c} ${names[c]}`, fmt(dr(TRUTH[c])), fmt(cr(TRUTH[c])), fmt(TRUTH[c])]));
  return toXlsx([{ rows }]);
}

/** دفترة-like: Arabic headers, separate code + name, parentheses negatives on ONE signed column, Arabic digits. */
export function daftra(): Buffer {
  const rows: (string | number)[][] = [["ميزان المراجعة - دفترة"], ["رقم الحساب", "اسم الحساب", "الرصيد"]];
  const ar = (s: string) => s.replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
  codes.forEach((c) => {
    const b = TRUTH[c];
    const txt = ar(Math.abs(b).toLocaleString("en-US", { minimumFractionDigits: 2 }));
    rows.push([ar(c), names[c], b < 0 ? `(${txt})` : txt]);
  });
  return toXlsx([{ rows }]);
}

/** رواء / قوائم-like: name-first cell "اسم - رمز", reversed column order, Dr/Cr suffix on a balance column. */
export function rawaa(): Buffer {
  const rows: (string | number)[][] = [["كشف أرصدة الحسابات"], ["الرصيد", "اسم الحساب"]];
  codes.forEach((c) => {
    const b = TRUTH[c];
    rows.push([`${Math.abs(b).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${b < 0 ? "Cr" : "Dr"}`, `[${c}] ${names[c]}`]);
  });
  return toXlsx([{ rows }]);
}

/** Hand-written: no header keywords at all → must fall to NEEDS_MAPPING, then work with a template. */
export function handmade(): Buffer {
  const rows: (string | number)[][] = [["x", "y", "z", "w"], ["", "", "", ""]];
  codes.forEach((c) => rows.push([c, names[c], dr(TRUTH[c]), cr(TRUTH[c])]));
  return toXlsx([{ rows }]);
}

export function csvFile(): Buffer {
  const lines = ["\uFEFFرقم الحساب;اسم الحساب;مدين;دائن"];
  codes.forEach((c) => lines.push(`${c};${names[c]};${dr(TRUTH[c])};${cr(TRUTH[c])}`));
  return Buffer.from(lines.join("\r\n"), "utf8");
}
