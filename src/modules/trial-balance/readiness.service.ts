import { prisma } from "@/lib/prisma";
import { computeTrialBalance } from "./trial-balance.service";
import { accountWhere, getChartScope } from "@/modules/chart/chart.service";
import { SYS } from "@/modules/chart/standard";

/**
 * The RELEASE GATE (spec §9.3). Blockers are few and limited to what makes the
 * statements arithmetically wrong; everything else is a warning the accountant may
 * pass by writing a justification (stored in Case.releaseOverrides). A draft is
 * always available — nothing here stops the Trial Balance from being built.
 *
 *   blockers : balanced TB · every bank = last printed balance · A = L + E ·
 *              opening balances decided (not "unavailable now") · every balance has a statement line
 *   warnings : suspense balance · internal transfers without a counterpart ·
 *              deferred adjustments · misc > 5 % of expenses · balances against their nature
 */

export type ReadinessStatus = "complete" | "in_progress" | "blocked";
export type ReadinessItem = {
  key: string;
  label: string;
  labelAr: string;
  status: ReadinessStatus;
  severity: "blocker" | "warning" | "info";
  done: number;
  total: number;
  detail?: string;
  /** Arabic, the exact message the UI shows. */
  detailAr?: string;
  /** What the "اذهب للمشكلة" button opens. */
  goTo?: { step: string; ref?: string };
  overridden?: boolean;
};
export type ReadinessReport = {
  items: ReadinessItem[];
  readyForStatements: boolean;
  blockingSummary: string | null;
  blockers: ReadinessItem[];
  warnings: ReadinessItem[];
};

const LOW = 0.7;
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function computeReadiness(caseId: string, firmId: string): Promise<ReadinessReport> {
  const scope = await getChartScope(caseId, firmId);
  const [kase, tb, txnCount, resolved, openQ, answeredQ, docs, accounts, lastDates] = await Promise.all([
    prisma.case.findUnique({ where: { id: caseId } }),
    computeTrialBalance(caseId, firmId),
    prisma.bankTransaction.count({ where: { caseId, firmId } }),
    prisma.bankTransaction.count({ where: { caseId, firmId, categoryAccountId: { not: null }, categoryConfidence: { gte: LOW } } }),
    prisma.clarification.count({ where: { caseId, firmId, status: "OPEN" } }),
    prisma.clarification.count({ where: { caseId, firmId, status: "ANSWERED" } }),
    prisma.document.findMany({ where: { caseId, firmId, type: "BANK_STATEMENT" }, select: { id: true, fileName: true, bankAccountId: true, closingBalance: true } }),
    prisma.account.findMany({ where: accountWhere(scope) }),
    prisma.bankTransaction.groupBy({ by: ["documentId"], where: { caseId, firmId }, _max: { date: true } }),
  ]);
  const overrides = (kase?.releaseOverrides ?? {}) as Record<string, { reason: string }>;
  const items: ReadinessItem[] = [];
  const push = (i: Omit<ReadinessItem, "overridden">) => items.push({ ...i, overridden: i.severity === "warning" && !!overrides[i.key] });

  // ── info ──
  push({ key: "transactions", label: "Bank transactions", labelAr: "حركات كشف البنك", severity: "info", status: txnCount > 0 ? "complete" : "blocked", done: txnCount, total: txnCount,
    detailAr: txnCount === 0 ? "لم يُرفع أي كشف بعد. ارفع كشف بنك للمتابعة." : undefined, goTo: { step: "documents" } });
  push({ key: "classification", label: "Classification", labelAr: "التصنيف المحاسبي", severity: "info", status: resolved === txnCount ? "complete" : "in_progress", done: resolved, total: txnCount,
    detailAr: resolved < txnCount ? `${txnCount - resolved} عملية بانتظار قرارك، وهي مرحّلة مؤقتًا إلى الحساب المعلق.` : undefined, goTo: { step: "classification" } });
  push({ key: "clarifications", label: "Questions", labelAr: "الأسئلة", severity: "info", status: openQ === 0 ? "complete" : "in_progress", done: answeredQ, total: answeredQ + openQ,
    detailAr: openQ ? `${openQ} سؤال مفتوح.` : undefined, goTo: { step: "questions" } });

  // ── blockers ──
  push({ key: "trial_balance", label: "Trial Balance balanced", labelAr: "ميزان المراجعة متوازن", severity: "blocker",
    status: tb.rows.length > 0 && tb.balanced ? "complete" : "blocked", done: tb.balanced && tb.rows.length ? 1 : 0, total: 1,
    detailAr: tb.rows.length === 0 ? "لم تُرحَّل قيود بعد." : tb.balanced ? undefined : `المدين ${money(tb.totalDebit)} ≠ الدائن ${money(tb.totalCredit)}. الفرق ${money(Math.abs(tb.totalDebit - tb.totalCredit))}.`,
    goTo: { step: "opening" } });

  const openingOk = !!kase && (kase.openingMode ? kase.openingMode !== "unavailable" : kase.openingBalancesConfirmed);
  push({ key: "opening_balances", label: "Opening balances decided", labelAr: "الأرصدة الافتتاحية محددة", severity: "blocker",
    status: openingOk ? "complete" : "blocked", done: openingOk ? 1 : 0, total: 1,
    detailAr: openingOk ? undefined : kase?.openingMode === "unavailable" ? "الأرصدة الافتتاحية «غير متوفرة الآن». يمكنك تنزيل مسودة، لكن الإصدار النهائي يتطلب رفع ميزان السنة السابقة أو إدخال الأرصدة." : "اختر طريقة الأرصدة الافتتاحية: رفع الميزان، إدخال يدوي، أو «السنة الأولى للمنشأة».",
    goTo: { step: "opening" } });

  // each bank = the last balance printed in its statement
  const lastDate = new Map(lastDates.map((d) => [d.documentId, d._max.date?.getTime() ?? 0]));
  const latestByBank = new Map<string, (typeof docs)[number]>();
  for (const d of docs) {
    if (!d.bankAccountId || d.closingBalance == null) continue;
    const cur = latestByBank.get(d.bankAccountId);
    if (!cur || (lastDate.get(d.id) ?? 0) > (lastDate.get(cur.id) ?? 0)) latestByBank.set(d.bankAccountId, d);
  }
  const tbById = new Map(tb.rows.map((r) => [r.accountId, r]));
  const bad: string[] = [];
  for (const [bankId, d] of latestByBank) {
    const row = tbById.get(bankId);
    const ours = row ? row.debit - row.credit : 0;
    const printed = Number(d.closingBalance);
    if (Math.abs(ours - printed) > 0.01) bad.push(`«${d.fileName}»: الدفتر ${money(ours)} والكشف ${money(printed)} (الفرق ${money(ours - printed)})`);
  }
  push({ key: "bank_balances", label: "Bank = last statement balance", labelAr: "رصيد كل بنك = آخر رصيد في كشفه", severity: "blocker",
    status: bad.length === 0 ? "complete" : "blocked", done: latestByBank.size - bad.length, total: latestByBank.size,
    detailAr: bad.length ? bad.join(" · ") : undefined, goTo: { step: "extraction" } });

  const sum = (type: string) => tb.rows.filter((r) => r.type === type).reduce((s, r) => s + r.debit - r.credit, 0);
  const A = sum("ASSET"), L = -sum("LIABILITY"), E = -sum("EQUITY"), profit = -(sum("REVENUE") + sum("EXPENSE"));
  const eqDiff = Math.round((A - (L + E + profit)) * 100) / 100;
  push({ key: "equation", label: "Assets = Liabilities + Equity", labelAr: "الأصول = الخصوم + حقوق الملكية", severity: "blocker",
    status: Math.abs(eqDiff) < 0.01 ? "complete" : "blocked", done: Math.abs(eqDiff) < 0.01 ? 1 : 0, total: 1,
    detailAr: Math.abs(eqDiff) < 0.01 ? undefined : `الفرق ${money(eqDiff)} — راجع الأرصدة الافتتاحية والقيود.`, goTo: { step: "outputs" } });

  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const noLine = tb.rows.filter((r) => (r.debit !== 0 || r.credit !== 0) && !acctById.get(r.accountId)?.fsLine && scope.mode !== "legacy");
  push({ key: "fs_lines", label: "Every balance has a statement line", labelAr: "كل حساب عليه رصيد له بند قوائم", severity: "blocker",
    status: noLine.length === 0 ? "complete" : "blocked", done: 0, total: noLine.length,
    detailAr: noLine.length ? `اختر بند القوائم المالية للحسابات: ${noLine.slice(0, 5).map((r) => r.code + " " + (r.nameAr ?? r.name)).join("، ")}` : undefined, goTo: { step: "tree" } });

  // ── warnings ──
  const bal = (code: string) => { const a = accounts.find((x) => x.code === code || (code === SYS.suspense && x.stdKey === "system.suspense")); const r = a && tbById.get(a.id); return r ? r.debit - r.credit : 0; };
  const susp = bal(SYS.suspense);
  push({ key: "suspense", label: "Suspense balance", labelAr: "رصيد في الحساب المعلق", severity: "warning", status: Math.abs(susp) < 0.01 ? "complete" : "in_progress", done: 0, total: Math.abs(susp) < 0.01 ? 0 : 1,
    detailAr: Math.abs(susp) < 0.01 ? undefined : `${money(susp)} ريال ما زال في الحساب المعلق: صنّفه، أو أصدر القوائم مع إظهاره بندًا وإيضاحًا.`, goTo: { step: "classification" } });
  const internal = accounts.find((a) => a.stdKey === "system.internal_transfer");
  const ib = internal ? (tbById.get(internal.id)?.debit ?? 0) - (tbById.get(internal.id)?.credit ?? 0) : 0;
  push({ key: "internal_transfers", label: "Internal transfers unmatched", labelAr: "تحويلات داخلية بدون مقابل", severity: "warning", status: Math.abs(ib) < 0.01 ? "complete" : "in_progress", done: 0, total: Math.abs(ib) < 0.01 ? 0 : 1,
    detailAr: Math.abs(ib) < 0.01 ? undefined : `${money(ib)} ريال تحويلات بين حسابات الشركة بلا مقابل: ارفع كشف البنك الآخر أو اختر الحساب المقابل.`, goTo: { step: "documents" } });
  push({ key: "adjustments", label: "Adjustments", labelAr: "التسويات", severity: "warning", status: kase?.adjustmentsConfirmed ? "complete" : "in_progress", done: kase?.adjustmentsConfirmed ? 1 : 0, total: 1,
    detailAr: kase?.adjustmentsConfirmed ? undefined : "لم تُراجع تسويات نهاية السنة (الإهلاك، المستحقات، المخزون…). أكملها أو أصدر مع ملاحظة.", goTo: { step: "adjustments" } });
  const misc = accounts.find((a) => a.stdKey === "other_exp.misc");
  const expenses = tb.rows.filter((r) => r.type === "EXPENSE").reduce((s, r) => s + r.debit - r.credit, 0);
  const miscAmt = misc ? (tbById.get(misc.id)?.debit ?? 0) - (tbById.get(misc.id)?.credit ?? 0) : 0;
  const miscHigh = expenses > 0 && miscAmt / expenses > 0.05;
  push({ key: "misc_expenses", label: "Misc expenses > 5%", labelAr: "«مصروفات متنوعة» أكثر من 5% من المصروفات", severity: "warning", status: miscHigh ? "in_progress" : "complete", done: 0, total: miscHigh ? 1 : 0,
    detailAr: miscHigh ? `${money(miscAmt)} ريال (${Math.round((miscAmt / expenses) * 100)}%). راجع البند أو تجاوزه بتبرير.` : undefined, goTo: { step: "classification" } });
  const contra = tb.rows.filter((r) => { const a = acctById.get(r.accountId); if (!a?.nature || a.isContra) return false; return a.nature === "debit" ? r.credit > 0.01 : r.debit > 0.01; });
  push({ key: "reverse_nature", label: "Balances against nature", labelAr: "أرصدة عكس الطبيعة", severity: "warning", status: contra.length ? "in_progress" : "complete", done: 0, total: contra.length,
    detailAr: contra.length ? `أرصدة عكس طبيعتها: ${contra.slice(0, 4).map((r) => r.code + " " + (r.nameAr ?? r.name)).join("، ")}` : undefined, goTo: { step: "outputs" } });

  const blockers = items.filter((i) => i.severity === "blocker" && i.status !== "complete");
  const warnings = items.filter((i) => i.severity === "warning" && i.status !== "complete" && !i.overridden);
  return {
    items,
    blockers,
    warnings,
    readyForStatements: blockers.length === 0,
    blockingSummary: blockers.length ? blockers.map((i) => i.labelAr + (i.detailAr ? ` — ${i.detailAr}` : "")).join(" | ") : null,
  };
}
