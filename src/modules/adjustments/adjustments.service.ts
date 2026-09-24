import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound } from "@/lib/http-error";

/**
 * Manual adjustments and accruals — the MVP fallback for non-bank items
 * the client explicitly accepted as manual:
 *
 *   "for the MVP, non-bank items like depreciation and accruals require
 *    the accountant to enter them manually. The system will not invent or
 *    estimate them."
 *
 * Implementation: each adjustment is exactly one debit line + one credit
 * line in JournalLine, sharing an adjustmentGroupId. They carry
 * bankTransactionId = null, which is how generateTrialBalance() knows to
 * leave them alone when it regenerates bank-derived lines (see
 * trial-balance.service.ts).
 *
 * Writing an adjustment resets Case.adjustmentsConfirmed, forcing the
 * accountant to re-review the readiness checklist after any change.
 */

export type AdjustmentRow = {
  adjustmentGroupId: string;
  date: Date;
  memo: string | null;
  createdAt: Date;
  debit: {
    accountId: string;
    code: string;
    name: string;
    nameAr: string | null;
    amount: number;
  };
  credit: {
    accountId: string;
    code: string;
    name: string;
    nameAr: string | null;
    amount: number;
  };
};

export async function createAdjustment(opts: {
  firmId: string;
  caseId: string;
  date: Date;
  debitAccountId: string;
  creditAccountId: string;
  amount: number;
  memo?: string;
}): Promise<AdjustmentRow> {
  if (!(opts.amount > 0)) {
    throw badRequest("Adjustment amount must be greater than zero.");
  }
  if (opts.debitAccountId === opts.creditAccountId) {
    throw badRequest("Debit and credit accounts must be different.");
  }

  const kase = await prisma.case.findFirst({
    where: { id: opts.caseId, firmId: opts.firmId },
  });
  if (!kase) throw notFound("Case not found");

  const [debitAcc, creditAcc] = await Promise.all([
    prisma.account.findFirst({
      where: { id: opts.debitAccountId, firmId: opts.firmId, postable: true },
    }),
    prisma.account.findFirst({
      where: { id: opts.creditAccountId, firmId: opts.firmId, postable: true },
    }),
  ]);
  if (!debitAcc)
    throw badRequest(
      "Debit account not found in this firm's CoA (or not postable).",
    );
  if (!creditAcc)
    throw badRequest(
      "Credit account not found in this firm's CoA (or not postable).",
    );

  const groupId = randomUUID();
  const magnitude = new Prisma.Decimal(opts.amount);

  await prisma.$transaction(async (tx) => {
    await tx.journalLine.createMany({
      data: [
        {
          firmId: opts.firmId,
          caseId: opts.caseId,
          accountId: debitAcc.id,
          bankTransactionId: null,
          adjustmentGroupId: groupId,
          date: opts.date,
          debit: magnitude,
          credit: new Prisma.Decimal(0),
          memo: opts.memo,
        },
        {
          firmId: opts.firmId,
          caseId: opts.caseId,
          accountId: creditAcc.id,
          bankTransactionId: null,
          adjustmentGroupId: groupId,
          date: opts.date,
          debit: new Prisma.Decimal(0),
          credit: magnitude,
          memo: opts.memo,
        },
      ],
    });
    await tx.case.update({
      where: { id: opts.caseId },
      data: { adjustmentsConfirmed: false },
    });
  });

  return {
    adjustmentGroupId: groupId,
    date: opts.date,
    memo: opts.memo ?? null,
    createdAt: new Date(),
    debit: {
      accountId: debitAcc.id,
      code: debitAcc.code,
      name: debitAcc.name,
      nameAr: debitAcc.nameAr,
      amount: opts.amount,
    },
    credit: {
      accountId: creditAcc.id,
      code: creditAcc.code,
      name: creditAcc.name,
      nameAr: creditAcc.nameAr,
      amount: opts.amount,
    },
  };
}

export async function listAdjustments(
  caseId: string,
  firmId: string,
): Promise<AdjustmentRow[]> {
  const kase = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!kase) throw notFound("Case not found");

  const lines = await prisma.journalLine.findMany({
    where: {
      caseId,
      firmId,
      adjustmentGroupId: { not: null },
    },
    include: { account: true },
    orderBy: { createdAt: "asc" },
  });

  const byGroup = new Map<string, typeof lines>();
  for (const l of lines) {
    const g = l.adjustmentGroupId!;
    const arr = byGroup.get(g) ?? [];
    arr.push(l);
    byGroup.set(g, arr);
  }

  const out: AdjustmentRow[] = [];
  for (const [groupId, group] of byGroup) {
    const debitLine = group.find((l) => Number(l.debit) > 0);
    const creditLine = group.find((l) => Number(l.credit) > 0);
    if (!debitLine || !creditLine) continue; // corrupted pair — skip defensively

    out.push({
      adjustmentGroupId: groupId,
      date: debitLine.date,
      memo: debitLine.memo,
      createdAt: debitLine.createdAt,
      debit: {
        accountId: debitLine.accountId,
        code: debitLine.account.code,
        name: debitLine.account.name,
        nameAr: debitLine.account.nameAr,
        amount: Number(debitLine.debit),
      },
      credit: {
        accountId: creditLine.accountId,
        code: creditLine.account.code,
        name: creditLine.account.name,
        nameAr: creditLine.account.nameAr,
        amount: Number(creditLine.credit),
      },
    });
  }
  return out;
}

export async function deleteAdjustment(
  caseId: string,
  firmId: string,
  adjustmentGroupId: string,
): Promise<{ ok: true }> {
  const kase = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!kase) throw notFound("Case not found");

  const count = await prisma.journalLine.count({
    where: { caseId, firmId, adjustmentGroupId },
  });
  if (count === 0) throw notFound("Adjustment not found");

  await prisma.$transaction(async (tx) => {
    await tx.journalLine.deleteMany({
      where: { caseId, firmId, adjustmentGroupId },
    });
    await tx.case.update({
      where: { id: caseId },
      data: { adjustmentsConfirmed: false },
    });
  });

  return { ok: true };
}

export async function confirmAdjustments(caseId: string, firmId: string) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!kase) throw notFound("Case not found");

  await prisma.case.update({
    where: { id: caseId },
    data: { adjustmentsConfirmed: true },
  });
  return { ok: true, confirmed: true };
}

export async function unconfirmAdjustments(caseId: string, firmId: string) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!kase) throw notFound("Case not found");

  await prisma.case.update({
    where: { id: caseId },
    data: { adjustmentsConfirmed: false },
  });
  return { ok: true, confirmed: false };
}
