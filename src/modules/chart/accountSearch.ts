import { normalizeText, tokens, editDistance } from "@/lib/arabic";

export type SearchableAccount = {
  id?: string; code: string; name: string; nameAr?: string | null; postable: boolean;
  keywordsAr?: string[]; keywordsEn?: string[]; parentCode?: string | null; active?: boolean; type?: string;
};

/**
 * Account picker search (spec §4.6 "مواصفات حقل اختيار الحساب"): by number, Arabic
 * or English name or keyword, tolerant of spelling mistakes. Postable accounts
 * only; the caller puts the suggestion and the user's last 5 on top.
 */
export function searchAccounts<T extends SearchableAccount>(accounts: T[], query: string, limit = 25): T[] {
  const q = normalizeText(query);
  const pool = accounts.filter((a) => a.postable && a.active !== false);
  if (!q) return pool.slice(0, limit);
  const qt = tokens(query);
  const scored: [number, T][] = [];
  for (const a of pool) {
    let score = 0;
    if (a.code === q) score = 100;
    else if (a.code.startsWith(q) && /^\d+$/.test(q)) score = 80;
    else {
      const hay = [a.nameAr ?? "", a.name, ...(a.keywordsAr ?? []), ...(a.keywordsEn ?? [])].map(normalizeText);
      for (const h of hay) {
        if (!h) continue;
        if (h === q) score = Math.max(score, 95);
        else if (h.includes(q)) score = Math.max(score, 70);
        else if (qt.length) {
          const ht = tokens(h);
          const hit = qt.filter((t) => ht.some((w) => w === t || w.includes(t) || (t.length >= 4 && editDistance(t, w, 1) <= 1))).length;
          if (hit === qt.length) score = Math.max(score, 60 + hit);
          else if (hit > 0) score = Math.max(score, 30 + hit * 10);
        }
      }
    }
    if (score > 0) scored.push([score, a]);
  }
  return scored.sort((x, y) => y[0] - x[0] || x[1].code.localeCompare(y[1].code)).slice(0, limit).map((x) => x[1]);
}

/** "مصروفات ← عمومية وإدارية ← وقود" path for display. */
export function pathOf(code: string, byCode: Map<string, { name: string; nameAr?: string | null; parentCode?: string | null }>): string {
  const parts: string[] = [];
  let cur: string | null | undefined = code;
  for (let i = 0; i < 6 && cur; i++) {
    const a = byCode.get(cur);
    if (!a) break;
    parts.unshift(a.nameAr || a.name);
    cur = a.parentCode;
  }
  return parts.join(" ← ");
}

/** Next free code for a new child account (spec §4.2: "بنك جديد تحت 1101 → 110110"). */
export function nextChildCode(parentCode: string, existingCodes: string[]): string {
  const kids = existingCodes.filter((c) => c.length > parentCode.length && c.startsWith(parentCode));
  if (kids.length === 0) return parentCode + (parentCode.length >= 4 ? "01" : "1");
  const width = Math.max(...kids.map((c) => c.length));
  const direct = kids.filter((c) => c.length === width);
  const max = Math.max(...direct.map((c) => Number(c)));
  return String(max + 1).padStart(width, "0");
}
