import { toLatinDigits } from "@/lib/arabic";

/**
 * Parses an amount cell from any accounting export.
 * Handles: real numbers · Arabic-Indic digits · ٫ ٬ separators · thousands
 * commas/spaces/NBSP · (1,250.00) and -1,250.00 and 1,250.00- negatives ·
 * "1,250.00 Dr/Cr" and "مدين/دائن" suffixes · currency words · "1.234,56".
 * Returns null when the cell is not a number at all, 0 for "-" / "—".
 */
export function parseAmount(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = toLatinDigits(String(v)).replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "").trim();
  if (!s) return null;
  if (/^[-–—]+$/.test(s)) return 0;

  let sign = 1;
  // Dr / Cr suffix or prefix (Cr = credit = negative when the sheet is debit-positive)
  const dc = s.match(/(\bDR\b|\bCR\b|مدين|دائن)\.?\s*$/i) || s.match(/^(\bDR\b|\bCR\b|مدين|دائن)\.?\s*/i);
  let dcSign = 0;
  if (dc) {
    dcSign = /^(CR|دائن)$/i.test(dc[1]) ? -1 : 1;
    s = s.replace(dc[0], "").trim();
  }
  s = s.replace(/(SAR|SR|ر\.?\s?س\.?|ريال|﷼|USD|\$|AED)/gi, "").trim();
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (s.endsWith("-")) { sign = -sign; s = s.slice(0, -1); }
  if (s.startsWith("-") || s.startsWith("−") || s.startsWith("–")) { sign = -sign; s = s.slice(1); }
  if (s.startsWith("+")) s = s.slice(1);
  s = s.replace(/٫/g, ".").replace(/٬/g, ",").replace(/[\s\u00A0']/g, "");
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", "."); // 1.234,56
    else s = s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // "1,234" (thousands) vs "12,5" (decimal comma)
    const after = s.length - lastComma - 1;
    s = after === 3 && s.indexOf(",") === lastComma ? s.replace(",", "") : after <= 2 && s.indexOf(",") === lastComma ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return (dcSign || 1) * sign * n;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
