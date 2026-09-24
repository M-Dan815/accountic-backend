/**
 * Text normalisation shared by the file reader, the classifier and the
 * account search. Implements the `normalization` list shipped in
 * coa_seed.json (spec §7 stage 0):
 *
 *   remove_tatweel · remove_diacritics · arabic_indic_digits_to_latin ·
 *   unify_alef · uppercase_latin · collapse_spaces
 *
 * Two flavours:
 *   • `normalizeText`  — what we MATCH on (also unifies ة/ه and ى/ي, which
 *     accountants type interchangeably)
 *   • `toLatinDigits`  — display-safe: only converts digits, keeps the words
 */

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_INDIC = "۰۱۲۳۴۵۶۷۸۹";

export function toLatinDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    const p = PERSIAN_INDIC.indexOf(ch);
    out += p >= 0 ? String(p) : ch;
  }
  return out;
}

const DIACRITICS_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function normalizeText(input: unknown): string {
  let s = String(input ?? "");
  s = s.replace(INVISIBLE_RE, "");
  s = s.replace(/\u0640/g, ""); // tatweel
  s = s.replace(DIACRITICS_RE, "");
  s = toLatinDigits(s);
  s = s.replace(/[أإآٱ]/g, "ا"); // unify alef
  s = s.replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي");
  s = s.replace(/\u00A0/g, " ");
  s = s.toUpperCase();
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Tokens for fuzzy matching: normalised words, minus Arabic/English stop words. */
const STOP = new Set([
  "ال", "و", "في", "من", "الى", "على", "عن", "حساب", "حسابات", "ذات", "OF", "THE", "AND", "FOR", "ACCOUNT", "ACC", "A/C",
]);

export function tokens(input: unknown): string[] {
  return normalizeText(input)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(" ")
    .map((w) => (w.startsWith("ال") && w.length > 3 ? w.slice(2) : w)) // strip definite article
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Levenshtein distance, capped for speed (used for spelling tolerance). */
export function editDistance(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = i - 1;
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > cap) return cap + 1;
  }
  return prev[b.length];
}

/** Set-overlap similarity of two strings on tokens, tolerant of 1-char typos. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const used = new Set<number>();
  let hit = 0;
  for (const x of ta) {
    let best = -1;
    for (let j = 0; j < tb.length; j++) {
      if (used.has(j)) continue;
      const y = tb[j];
      const ok = x === y || (x.length >= 4 && y.length >= 4 && editDistance(x, y, 1) <= 1) ||
        (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)));
      if (ok) { best = j; break; }
    }
    if (best >= 0) { used.add(best); hit++; }
  }
  // Dice-style: rewards covering both sides, penalises one-sided containment.
  return (2 * hit) / (ta.length + tb.length);
}
