import { normalizeText, tokenSimilarity } from "@/lib/arabic";
import type { SearchableAccount } from "./accountSearch";

/**
 * Map an account from a client's file (trial balance or chart) to the closest
 * POSTABLE account of the file's chart (spec §4.4 "جدول مطابقة" and §6.1).
 * green ≥ 0.90 (auto) · yellow 0.45–0.89 (needs a tick) · red < 0.60 (pick / create).
 */
export type MapCandidate = { account: SearchableAccount & { id?: string; stdKey?: string | null }; confidence: number; why: string };
export type MapResult = {
  source: { code: string | null; name: string };
  status: "green" | "yellow" | "red";
  best: MapCandidate | null;
  alternatives: MapCandidate[];
  suggestedParentCode?: string;
};

// Arabic has no \\b in JS regex — use Unicode letter look-arounds instead.
const W = (alts: string) => new RegExp(`(?<!\\p{L})(?:${alts})(?!\\p{L})`, "gu");
const SYN: [RegExp, string][] = [
  [W("المصرف|المصارف|البنوك"), "بنك"],
  [W("النقديه|الصندوق|خزينه|الخزينه|عهده نقديه"), "نقد"],
  [W("المدينون|ذمم مدينه|عملاء|مدينو"), "عملاء"],
  [W("الداينون|ذمم داينه|الموردون|موردين"), "موردون"],
  [W("رواتب واجور|الرواتب|اجور"), "رواتب"],
  [W("مصاريف|مصروفات|مصروف"), "مصروف"],
  [W("عموله|عمولات"), "رسوم"],
  [W("فوايد|فوائد|مرابحه"), "تمويل"],
  [W("ايراد|ايرادات|مبيعات"), "ايراد"],
  [W("نقل ومواصلات|مواصلات|سيارات"), "مركبات"],
  [W("دعايه واعلان|تسويقيه ودعائيه|دعايه|تسويقيه|تسويق"), "دعايه"],
  [W("اخري|متنوعه"), "متنوع"],
];
const canon = (s: string) => SYN.reduce((t, [re, to]) => t.replace(re, to), normalizeText(s));

function typeFromCode(code: string | null): string | null {
  if (!code) return null;
  return ({ "1": "ASSET", "2": "LIABILITY", "3": "EQUITY", "4": "REVENUE", "5": "EXPENSE" } as Record<string, string>)[code[0]] ?? null;
}

export function matchToTree(
  source: { code: string | null; name: string },
  tree: (SearchableAccount & { id?: string; stdKey?: string | null; type?: string })[],
  opts: { typeHint?: string | null } = {},
): MapResult {
  const srcType = opts.typeHint ?? typeFromCode(source.code);
  const sname = canon(source.name);
  const isBank = /بنك|راجحي|رياض|اهلي|انماء|بلاد|سامبا|مصرف/.test(sname);
  const scored: MapCandidate[] = [];
  for (const a of tree) {
    if (!a.postable || a.active === false) continue;
    let s = Math.max(tokenSimilarity(sname, canon(a.nameAr ?? a.name)), tokenSimilarity(sname, canon(a.name)));
    let why = "تشابه الاسم";
    for (const k of [...(a.keywordsAr ?? []), ...(a.keywordsEn ?? [])]) {
      const ks = tokenSimilarity(sname, canon(k));
      if (ks > s) { s = Math.min(0.95, ks * 0.95); why = "كلمة مفتاحية"; }
    }
    if (isBank && a.stdKey === "cash.bank") { s = Math.max(s, 0.55); }
    if (source.code && a.code === source.code) {
      if (s >= 0.5) { s = Math.max(s, 0.98); why = "نفس الرقم والاسم"; }
      else if (s < 0.3) { s = Math.min(s, 0.3); why = "نفس الرقم لكن الاسم مختلف"; }
    }
    if (srcType && a.type && a.type !== srcType) s *= 0.4;
    if (s > 0.15) scored.push({ account: a, confidence: Math.round(s * 100) / 100, why });
  }
  scored.sort((x, y) => y.confidence - x.confidence || x.account.code.localeCompare(y.account.code));
  const best = scored[0] ?? null;
  const status = !best ? "red" : best.confidence >= 0.9 ? "green" : best.confidence >= 0.45 ? "yellow" : "red";
  return {
    source, status, best: status === "red" ? null : best, alternatives: scored.slice(0, 4),
    suggestedParentCode: status === "red" ? scored[0]?.account.parentCode ?? undefined : undefined,
  };
}
