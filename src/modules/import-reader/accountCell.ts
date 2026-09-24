import { toLatinDigits } from "@/lib/arabic";

/**
 * Pull an account number out of a cell that mixes it with the name
 * (spec §5.2 step 4). All of these must read:
 *   "النقدية في الخزينة - 110101" · "110101 - النقدية في الخزينة"
 *   "110101 النقدية في الخزينة"   · "[110101] النقدية في الخزينة"
 * plus "(110101) …", "110101: …", "1.1.01 …".
 */
export type CodeName = { code: string | null; name: string };

const CODE = String.raw`\d{1,12}(?:\.\d{1,6})*`;
const SEP = String.raw`\s*[-–—:.\s]\s*`;

export function splitCodeName(raw: unknown): CodeName {
  const s = toLatinDigits(String(raw ?? "")).replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  if (!s) return { code: null, name: "" };
  let m: RegExpMatchArray | null;
  if ((m = s.match(new RegExp(String.raw`^[\[(]\s*(${CODE})\s*[\])]\s*[-–—:]?\s*(.+)$`)))) return { code: m[1], name: m[2].trim() };
  if ((m = s.match(new RegExp(String.raw`^(.+?)\s*[\[(]\s*(${CODE})\s*[\])]$`)))) return { code: m[2], name: m[1].trim() };
  if ((m = s.match(new RegExp(`^(${CODE})${SEP}(\\D.*)$`)))) return { code: m[1], name: m[2].trim() };
  if ((m = s.match(new RegExp(`^(\\D.*?)${SEP}(${CODE})$`)))) return { code: m[2], name: m[1].trim() };
  if (/^\d{1,12}$/.test(s)) return { code: s, name: "" };
  return { code: null, name: s };
}

const TOTAL_RE = /^(مجموع|المجموع|اجمالي|إجمالي|الاجمالي|الإجمالي|جمله|الجمله|total|sub\s*total|subtotal|grand\s*total|totals?\b)/i;
import { normalizeText } from "@/lib/arabic";
export function isTotalLabel(label: string): boolean {
  const n = normalizeText(label).replace(/^[-–—:\s]+/, "");
  return TOTAL_RE.test(n) || /^(مجموع|اجمالي|جمله)\b/.test(n) || /^TOTAL\b/.test(n);
}

export function isFooterNoise(label: string): boolean {
  const n = normalizeText(label);
  return /^(صفحه|PAGE)\s*\d+/.test(n) || /^(تاريخ (الطباعه|الاصدار)|PRINTED|GENERATED|تم الاستخراج)/.test(n);
}
