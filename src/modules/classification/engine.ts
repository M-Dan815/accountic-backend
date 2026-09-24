import { normalizeText } from "@/lib/arabic";
import { type Enrichment } from "@/modules/extraction/statementEnricher";
import { STANDARD, SYS, THRESHOLDS, type SeedRule, type SeedMerchant } from "@/modules/chart/standard";
import { classifyFromStatement, DEFAULT_ROLE_CODES } from "./statementClassifier";

/**
 * The classification engine (spec §7). Every row goes through the stages in
 * order and the FIRST stage that gives an answer stops the rest:
 *
 *   1 client rules  2 counterparty memory  3 auto-matching  4 system rules (62)
 *   5 merchant directory  6 statement evidence  →  (7 AI, done by the caller)
 *
 * The engine is PURE and speaks STANDARD account codes; classify-case.ts turns
 * them into the file's own accounts. Confidence bands (thresholds in the seed):
 *   ≥ 0.90 automatic · 0.70–0.89 automatic + "مراجعة سريعة" · < 0.70 → a question.
 */

export type Target = { stdCode?: string; accountCode?: string; stdKey?: string | null; accountId?: string | null };
export type EngineRule = {
  id: string; kind: string; matchText: string; target: Target; direction?: "debit" | "credit" | null;
  minAmount?: number | null; maxAmount?: number | null;
};
export type Stage = "client_rule" | "memory" | "auto_match" | "system_rule" | "merchant" | "evidence";
export type Outcome =
  | { decision: "assign"; stage: Stage; target: Target; confidence: number; reason: string; ruleId?: string; needsConfirm?: boolean; questionId?: string }
  | { decision: "question"; stage: Stage | "none"; questionId: string; reason: string; suggested?: Target; confidence?: number };

export type EngineInput = {
  description: string; amount: number; e: Enrichment; beneficiaryKey?: string | null; counterparty?: string | null;
};
export type EngineContext = {
  activity: string;
  clientRules: EngineRule[];
  memoryRules: EngineRule[];
  knownCustomers: string[];
  sadadBillers: Map<string, Target>;
};

const AUTO = THRESHOLDS.auto, REVIEW = THRESHOLDS.auto_with_review;

// ─── pattern matching ────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cache = new Map<string, RegExp>();
/** Whole-word for short/Latin patterns (so "SEC" ≠ "SECURITY", "قوى" ≠ "قوية"), substring otherwise. */
export function patternMatches(text: string, patternRaw: string, wholeWord = false): boolean {
  const p = normalizeText(patternRaw);
  if (!p) return false;
  const short = /^[A-Z0-9 .&/-]+$/.test(p) ? p.length <= 5 : p.length <= 3;
  if (!wholeWord && !short) return text.includes(p);
  const key = `${p}|${wholeWord}`;
  let re = cache.get(key);
  if (!re) { re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(p)}(?![\\p{L}\\p{N}])`, "u"); cache.set(key, re); }
  return re.test(text);
}

type CompiledRule = { rule: SeedRule; patterns: string[]; regex?: RegExp; longest: number };
const compiled: CompiledRule[] = STANDARD.system_rules.map((r) => {
  let regex: RegExp | undefined;
  if (r.regex) { try { regex = new RegExp(r.regex.replace(/\(\?P</g, "(?<"), "u"); } catch { /* skip bad regex */ } }
  const patterns = r.patterns.map(normalizeText);
  return { rule: r, patterns, regex, longest: Math.max(0, ...patterns.map((p) => p.length)) };
});
const dirOf = (amount: number) => (amount < 0 ? "debit" : "credit");
const isFallbackRule = (r: SeedRule) => r.code === SYS.suspense || (r.code === null && !!r.question_id) || r.rule_id === "R047";
const questionFor = (r: SeedRule, dir: string): string | undefined =>
  typeof r.question_id === "string" ? r.question_id : (r.question_id as unknown as Record<string, string> | undefined)?.[dir];
// R047's question_id is a {debit,credit} map in the seed
const qOf = (r: SeedRule, dir: string) => questionFor(r, dir);

const tgt = (stdCode: string): Target => ({ stdCode });

/** Activity-specific alternatives written in the seed notes ("لشركات النقل: 510203"). */
function activityCode(base: string, note: string | undefined, activity: string): string {
  if (activity === "logistics") {
    const m = note?.match(/لشركات النقل:\s*(\d{6})/);
    if (m) return m[1];
  }
  return base;
}

function ruleApplies(r: EngineRule, i: EngineInput): boolean {
  const amount = Math.abs(i.amount);
  if (r.direction && r.direction !== dirOf(i.amount)) return false;
  if (r.minAmount != null && amount < r.minAmount) return false;
  if (r.maxAmount != null && amount > r.maxAmount) return false;
  const text = normalizeText(i.description);
  const mt = normalizeText(r.matchText);
  switch (r.kind) {
    case "beneficiary": return !!i.beneficiaryKey && normalizeText(i.beneficiaryKey) === mt;
    case "merchant": return normalizeText(i.counterparty ?? i.e.merchant ?? "").includes(mt) && mt.length > 0;
    case "amount-pattern": { const m = r.matchText.match(/amount:([\d.]+)/i); return !!m && Number(m[1]) === amount && text.includes(mt.replace(/AMOUNT:[\d.]+/i, "").trim()); }
    default: return patternMatches(text, r.matchText);
  }
}
const bestRule = (rules: EngineRule[], i: EngineInput) =>
  rules.filter((r) => ruleApplies(r, i)).sort((a, b) => (b.kind === "beneficiary" ? 1 : 0) - (a.kind === "beneficiary" ? 1 : 0) || b.matchText.length - a.matchText.length)[0];

// ─── the engine ──────────────────────────────────────────────────────────
export function classifyRow(i: EngineInput, ctx: EngineContext): Outcome | null {
  const { e } = i;
  const dir = dirOf(i.amount);
  const text = normalizeText(i.description);

  // 1 ─ client rules (highest priority, explicit human conditions)
  const cr = bestRule(ctx.clientRules, i);
  if (cr) return { decision: "assign", stage: "client_rule", target: cr.target, confidence: 0.98, ruleId: cr.id, reason: `قاعدة العميل: «${cr.matchText}»` };

  // 2 ─ counterparty memory (same payee decided before for this client)
  const mem = bestRule(ctx.memoryRules, i);
  if (mem) return { decision: "assign", stage: "memory", target: mem.target, confidence: mem.kind === "beneficiary" ? 0.97 : 0.9, ruleId: mem.id, reason: `ذاكرة الطرف المقابل: «${mem.matchText}»` };

  // 3 ─ auto-matching: own-account transfers, collections that match customers
  if (e.isSelfTransfer && e.kind !== "FEE") {
    if (dir === "debit" && /عموله تمويل/.test(e.searchText))
      return { decision: "assign", stage: "auto_match", target: tgt(DEFAULT_ROLE_CODES.FINANCE_COST), confidence: 0.75, reason: "تحويل لحساب الشركة بملاحظة «عمولة تمويل»" };
    return { decision: "assign", stage: "auto_match", target: tgt(SYS.internal_transfers), confidence: 0.95, ruleId: "R060", reason: "تحويل بين حسابي الشركة — يُطابق مع الطرف المقابل في كشف البنك الآخر" };
  }
  if (e.kind === "TRANSFER_IN" && ctx.knownCustomers.length) {
    const cp = normalizeText(e.counterparty ?? "");
    const tIn = e.searchText;
    if (ctx.knownCustomers.some((c) => c && (tIn.includes(c) || cp.includes(c))))
      return { decision: "assign", stage: "auto_match", target: tgt(DEFAULT_ROLE_CODES.RECEIVABLES), confidence: 0.95, reason: "تحصيل من عميل موجود في فواتير المبيعات — ليس إيرادًا جديدًا" };
  }

  // 4 ─ system rules. Generic "fallback" rules (suspense / ask) only apply when nothing specific does.
  const hits: { c: CompiledRule; len: number; groups?: Record<string, string> }[] = [];
  const fallbacks: CompiledRule[] = [];
  for (const c of compiled) {
    const r = c.rule;
    if (r.direction !== "any" && r.direction !== dir) continue;
    let matched = false, groups: Record<string, string> | undefined, len = c.longest;
    switch (r.match_type) {
      case "payee_is_client": matched = e.counterpartyType === "self"; len = 1; break;
      case "contains_any_adjacent_to_fee": matched = e.isFee || /رسوم/.test(text); if (matched) matched = c.patterns.some((p) => patternMatches(text, p)); break;
      case "starts_with": { const hit = c.patterns.find((p) => text.startsWith(p) || text.replace(/^[-\s]+/, "").startsWith(p)); matched = !!hit; len = hit?.length ?? 0; break; }
      case "extract_counterparty_account":
      case "extract_sadad_biller":
      case "extract_merchant":
      case "extract_payer_name": {
        matched = c.patterns.some((p) => text.includes(p.replace(/\s+/g, " ")) || i.description.includes(p));
        if (matched && c.regex) { const m = (i.description).match(c.regex); groups = m?.groups as Record<string, string> | undefined; }
        break;
      }
      default: {
        const hit = c.patterns.filter((p) => patternMatches(text, p)).sort((a, b) => b.length - a.length)[0];
        matched = !!hit; len = hit?.length ?? 0;
      }
    }
    if (!matched) continue;
    if (isFallbackRule(r)) { fallbacks.push(c); continue; }
    hits.push({ c, len, groups });
  }
  hits.sort((a, b) => b.len - a.len || (b.c.rule.confidence ?? 0) - (a.c.rule.confidence ?? 0));

  for (const h of hits) {
    const r = h.c.rule;
    if (r.match_type === "extract_merchant") continue; // → merchant directory below
    if (r.match_type === "extract_sadad_biller") {
      const biller = h.groups?.biller;
      const known = biller ? ctx.sadadBillers.get(biller) : undefined;
      if (known) return { decision: "assign", stage: "system_rule", target: known, confidence: 0.92, ruleId: r.rule_id, reason: `فاتورة سداد لمفوتر رقم ${biller} (معروف من قبل)` };
      continue; // unknown biller → evidence tier / question
    }
    if (r.match_type === "extract_payer_name" || (r.code && r.confidence != null)) {
      const code = r.code!;
      const conf = r.confidence ?? 0.8;
      const stdCode = activityCode(code, r.note_ar, ctx.activity);
      const q = r.question_id ? qOf(r, dir) : undefined;
      if (conf < REVIEW) return { decision: "question", stage: "system_rule", questionId: q ?? defaultQuestion(e, dir), suggested: tgt(stdCode), confidence: conf, reason: `${r.rule_id}: ${r.note_ar ?? ""}`.trim() };
      return { decision: "assign", stage: "system_rule", target: tgt(stdCode), confidence: conf, ruleId: r.rule_id, needsConfirm: !!r.question_id && conf < AUTO, questionId: q, reason: `${r.rule_id}: ${r.note_ar ?? "قاعدة النظام"}` };
    }
    if (r.resolve_via === "original_transaction") return null; // refund: the pairing pass handles it
  }

  // 5 ─ merchant directory (whole word), by merchant name first, then the whole text
  const merchantText = normalizeText([e.merchant, e.counterparty].filter(Boolean).join(" "));
  for (const m of STANDARD.merchant_directory as SeedMerchant[]) {
    const hit = m.patterns.some((p) => patternMatches(merchantText, p, true)) || (dir === "debit" && m.patterns.some((p) => patternMatches(text, p, true)));
    if (!hit) continue;
    if (dir !== "debit") continue; // merchants are spend
    const code = activityCode(m.code, m.note_ar, ctx.activity);
    return { decision: "assign", stage: "merchant", target: tgt(code), confidence: m.needs_confirm ? Math.min(m.confidence, 0.85) : m.confidence, needsConfirm: m.needs_confirm, reason: `دليل التجار: ${m.merchant_ar} (${m.category_ar})${m.note_ar ? " — " + m.note_ar : ""}` };
  }

  // 6 ─ statement evidence (the validated heuristics: memo keywords, SADAD kinds, fees, …)
  const h = classifyFromStatement(e, i.amount, { knownCustomers: ctx.knownCustomers });
  if (h?.decision === "CLASSIFY" && h.role !== "OTHER_EXPENSE") {
    const stdCode = activityCode(DEFAULT_ROLE_CODES[h.role], h.role === "TRANSPORT" ? "لشركات النقل: 510203" : undefined, ctx.activity);
    return { decision: "assign", stage: "evidence", target: tgt(stdCode), confidence: h.confidence, reason: h.reason };
  }
  if (h?.decision === "PENDING") return { decision: "question", stage: "evidence", questionId: defaultQuestion(e, dir), reason: h.reason };

  // generic ask-rules (R022–R025, R047, R053, R054 …): no specific evidence → ask, with the rule's account as the suggestion
  if (fallbacks.length) {
    const f = fallbacks.sort((a, b) => (qOf(b.rule, dir) ? 1 : 0) - (qOf(a.rule, dir) ? 1 : 0))[0].rule;
    const sug = f.code && f.code !== SYS.suspense ? tgt(f.code) : undefined;
    return { decision: "question", stage: "system_rule", questionId: qOf(f, dir) ?? defaultQuestion(e, dir), suggested: sug, confidence: f.confidence ?? undefined, reason: f.note_ar ?? "لا يوجد دليل كافٍ في نص الكشف" };
  }
  return null; // → AI, then question
}

/** Which multiple-choice question fits a row nobody could classify. */
export function defaultQuestion(e: Enrichment, dir: string): string {
  if (e.kind === "ATM_WITHDRAWAL") return "Q04";
  if (e.kind === "ATM_DEPOSIT") return "Q01";
  if (e.kind === "POS_PURCHASE" || e.kind === "ONLINE_PURCHASE") return "Q07";
  return dir === "debit" ? "Q02" : "Q03";
}
