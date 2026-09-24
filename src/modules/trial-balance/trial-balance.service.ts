import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { badRequest } from "@/lib/http-error";
import { accountWhere, ensureSystemAccount, getChartScope, listChart } from "@/modules/chart/chart.service";
import { computeReadiness } from "./readiness.service";

/**
 * Deterministic accounting engine. No AI touches any of this.
 *
 * Journal lines come from three sources:
 *   1. bank-transaction lines (bankTransactionId set) — rebuilt by generateTrialBalance()
 *   2. manual adjustment lines (adjustmentGroupId set) — preserved on regenerate
 *   3. accepted statement differences (adjustmentGroupId "diff:<documentId>") — rebuilt
 *
 * "لا توقف" (spec §3): generating the Trial Balance is NEVER refused because
 * something is unanswered. A row nobody has classified yet is posted to the
 * suspense account (110801) and reported as a warning; the release gate (see
 * readiness.service.ts) is where real blockers live.
 */

const D = (n: number) => new Prisma.Decimal(n);
const ZERO = new Prisma.Decimal(0);

export async function generateTrialBalance(caseId: string, firmId: string) {
  const scope = await getChartScope(caseId, firmId);
  const chart = await listChart(scope);
  const suspense = await ensureSystemAccount(scope, "suspense");

  const docs = await prisma.document.findMany({ where: { caseId, firmId, type: "BANK_STATEMENT" } });
  const bankByDoc = new Map(docs.filter((d) => d.bankAccountId).map((d) => [d.id, d.bankAccountId!]));
  // Legacy files (no per-statement bank account): one cash account, as before.
  const fallbackCash =
    chart.find((a) => a.stdKey === "cash.bank" && a.postable) ??
    chart.find((a) => a.type === "ASSET" && a.postable && /نقد|بنك|cash|bank/i.test(`${a.name} ${a.nameAr ?? ""}`)) ??
    chart.find((a) => a.type === "ASSET" && a.postable);
  if (!fallbackCash && bankByDoc.size === 0) throw badRequest("لا يوجد حساب نقد أو بنك في شجرة هذا الملف. أضف حسابًا بنكيًا ثم أعد المحاولة.");

  const transactions = await prisma.bankTransaction.findMany({ where: { caseId, firmId } });
  const diffAccount = docs.some((d) => (d.extractionReport as { acceptedDifference?: unknown } | null)?.acceptedDifference)
    ? await ensureSystemAccount(scope, "reconciliation_differences")
    : null;

  await prisma.$transaction(async (tx) => {
    await tx.journalLine.deleteMany({ where: { caseId, firmId, bankTransactionId: { not: null } } });
    await tx.journalLine.deleteMany({ where: { caseId, firmId, adjustmentGroupId: { startsWith: "diff:" } } });

    const lines: Prisma.JournalLineCreateManyInput[] = [];
    for (const t of transactions) {
      const amount = Number(t.amount);
      const magnitude = D(Math.abs(amount));
      const outflow = amount < 0;
      const bankId = bankByDoc.get(t.documentId) ?? fallbackCash!.id;
      const counterId = t.categoryAccountId ?? suspense.id;
      const base = { firmId, caseId, bankTransactionId: t.id, date: t.date, memo: t.description };

      // bank side: one line
      lines.push({ ...base, accountId: bankId, debit: outflow ? ZERO : magnitude, credit: outflow ? magnitude : ZERO });
      // other side: one line, or one per split (split amounts are absolute SAR and sum to |amount|)
      const splits = t.splits as Array<{ accountId: string; amount: number }> | null;
      if (splits && splits.length >= 2) {
        for (const s of splits) lines.push({ ...base, accountId: s.accountId, debit: outflow ? D(s.amount) : ZERO, credit: outflow ? ZERO : D(s.amount) });
      } else {
        lines.push({ ...base, accountId: counterId, debit: outflow ? magnitude : ZERO, credit: outflow ? ZERO : magnitude });
      }
    }
    // accepted differences: bank ↔ "فروقات تسوية الكشف" (110803)
    for (const d of docs) {
      const diff = (d.extractionReport as { acceptedDifference?: { amount: number } } | null)?.acceptedDifference?.amount;
      if (!diff || !diffAccount) continue;
      const bankId = d.bankAccountId ?? fallbackCash!.id;
      const mag = D(Math.abs(diff));
      const date = transactions.filter((t) => t.documentId === d.id).map((t) => t.date).sort((a, b) => b.getTime() - a.getTime())[0] ?? new Date();
      const base = { firmId, caseId, adjustmentGroupId: `diff:${d.id}`, date, memo: "فرق مقبول في مطابقة الكشف" };
      lines.push({ ...base, accountId: bankId, debit: diff > 0 ? mag : ZERO, credit: diff > 0 ? ZERO : mag });
      lines.push({ ...base, accountId: diffAccount.id, debit: diff > 0 ? ZERO : mag, credit: diff > 0 ? mag : ZERO });
    }
    if (lines.length) await tx.journalLine.createMany({ data: lines });
  });

  const tb = await computeTrialBalance(caseId, firmId);
  const pending = transactions.filter((t) => !t.categoryAccountId).length;
  return {
    ...tb,
    warnings: [
      ...(pending > 0 ? [`${pending} عملية غير مصنفة رُحّلت مؤقتًا إلى «حساب معلق» (${suspense.code}) إلى أن تُجاب أسئلتها.`] : []),
    ],
  };
}

/**
 * Pure aggregation. Journal lines are the source of truth; the opening balances the accountant set
 * for THIS file are folded in on the fly, so the TB reflects the client's real position.
 */
export async function computeTrialBalance(caseId: string, firmId: string) {
  const [lines, kase] = await Promise.all([
    prisma.journalLine.findMany({ where: { caseId, firmId }, include: { account: true } }),
    prisma.case.findUnique({ where: { id: caseId } }),
  ]);

  const byAccount = new Map<string, { account: (typeof lines)[number]["account"]; debit: number; credit: number; opening: number }>();
  for (const line of lines) {
    const entry = byAccount.get(line.accountId) ?? { account: line.account, debit: 0, credit: 0, opening: 0 };
    entry.debit += Number(line.debit);
    entry.credit += Number(line.credit);
    byAccount.set(line.accountId, entry);
  }

  // Opening balances: confirmed, or any explicit mode chosen in step 4.
  if (kase && (kase.openingBalancesConfirmed || kase.openingMode)) {
    const scope = await getChartScope(caseId, firmId);
    const allAccounts = await prisma.account.findMany({ where: accountWhere(scope) });
    for (const acc of allAccounts) {
      const ob = Number(acc.openingBalance);
      if (ob === 0) continue;
      const entry = byAccount.get(acc.id) ?? { account: acc, debit: 0, credit: 0, opening: 0 };
      // openingBalance is stored DEBIT-POSITIVE for every account, whatever its nature.
      entry.opening = ob;
      byAccount.set(acc.id, entry);
    }
  }

  const rows = [...byAccount.values()]
    .map((e) => {
      const openDebit = e.opening > 0 ? e.opening : 0;
      const openCredit = e.opening < 0 ? -e.opening : 0;
      const net = openDebit - openCredit + e.debit - e.credit;
      return {
        accountId: e.account.id,
        code: e.account.code,
        name: e.account.name,
        nameAr: e.account.nameAr,
        type: e.account.type,
        openingDebit: round2(openDebit),
        openingCredit: round2(openCredit),
        movementDebit: round2(e.debit),
        movementCredit: round2(e.credit),
        debit: round2(net > 0 ? net : 0), // closing
        credit: round2(net < 0 ? -net : 0),
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  return { rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}

export async function approveTrialBalance(caseId: string, firmId: string) {
  const tb = await computeTrialBalance(caseId, firmId);
  if (tb.rows.length === 0) throw badRequest("أنشئ ميزان المراجعة قبل اعتماده.");
  const readiness = await computeReadiness(caseId, firmId);
  if (!readiness.readyForStatements) {
    throw badRequest(`لا يمكن اعتماد الميزان بعد. المتبقي: ${readiness.blockingSummary}`);
  }
  await prisma.case.update({ where: { id: caseId }, data: { status: "TB_APPROVED" } });
  return tb;
}

/** "اقبل الفرق" — record the unexplained gap of a statement so the release gate can pass, with a note. */
export async function acceptStatementDifference(caseId: string, firmId: string, documentId: string, note: string, userId: string) {
  const doc = await prisma.document.findFirst({ where: { id: documentId, caseId, firmId, type: "BANK_STATEMENT" } });
  if (!doc) throw badRequest("الكشف غير موجود.");
  if (note.trim().length < 3) throw badRequest("اكتب ملاحظة تبرّر قبول الفرق.");
  const rows = await prisma.bankTransaction.findMany({ where: { documentId, caseId, firmId }, select: { amount: true } });
  const sum = rows.reduce((s, r) => s + Number(r.amount), 0);
  if (doc.openingBalance == null || doc.closingBalance == null) throw badRequest("لا يوجد رصيد افتتاحي/ختامي مقروء لهذا الكشف لحساب الفرق.");
  const amount = round2(Number(doc.closingBalance) - (Number(doc.openingBalance) + sum));
  const report = ((doc.extractionReport ?? {}) as Record<string, unknown>);
  await prisma.document.update({
    where: { id: doc.id },
    data: { extractionReport: { ...report, acceptedDifference: { amount, note, by: userId, at: new Date().toISOString() } } as unknown as Prisma.InputJsonObject },
  });
  await prisma.exception.updateMany({
    where: { caseId, firmId, type: "MISSING_INFO", status: "OPEN" },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: userId },
  });
  return { amount };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
