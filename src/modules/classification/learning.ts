import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = PrismaClient | Prisma.TransactionClient;

export type LearnableTxn = {
  id: string;
  caseId: string;
  firmId: string;
  description: string;
  counterparty: string | null;
  beneficiaryKey: string | null;
  amount: Prisma.Decimal | number;
};

/**
 * Turn a human decision into reusable knowledge.
 *
 *  1. a ClassificationRule so the NEXT case gets it for free, and
 *  2. propagation to every other unresolved payment to the SAME payee in
 *     THIS case, so the accountant/client answers once per payee — not
 *     once per transaction (a monthly salary transfer that appears 12
 *     times used to raise 12 separate questions).
 */
export async function learnFromDecision(
  opts: {
    firmId: string;
    accountId: string;
    createdFrom: string;
    scope?: "none" | "description" | "merchant";
    ruleText?: string;
    reason: string;
    txn: LearnableTxn;
  },
  db: Db = prisma,
) {
  await createReusableRule({ ...opts, caseId: opts.txn.caseId }, db);
  return propagateToPayeeSiblings(
    { ...opts, sourceTxn: opts.txn },
    db,
  );
}

export async function createReusableRule(
  opts: {
    firmId: string;
    accountId: string;
    createdFrom: string;
    scope?: "none" | "description" | "merchant";
    ruleText?: string;
    caseId?: string;
    txn: Pick<LearnableTxn, "description" | "counterparty" | "beneficiaryKey">;
  },
  db: Db = prisma,
) {
  if (opts.scope === "none") return;

  let matchText: string;
  let ruleKind: "substring" | "merchant" | "beneficiary";

  if (opts.ruleText) {
    matchText = opts.ruleText;
    ruleKind = opts.scope === "merchant" ? "merchant" : "substring";
  } else if (opts.txn.beneficiaryKey) {
    // Best signal we have: the exact payee. Immune to memo/timestamp noise.
    matchText = opts.txn.beneficiaryKey;
    ruleKind = "beneficiary";
  } else if (opts.scope === "merchant" && opts.txn.counterparty) {
    matchText = opts.txn.counterparty.slice(0, 60);
    ruleKind = "merchant";
  } else {
    // Auto-derive a substring rule from the description's first words.
    // SKIP generic movement-type words — they overmatch catastrophically.
    // The classic case: an accountant categorizes "تحويل -E-/TOACCT/..."
    // and the auto-derived rule with matchText="تحويل" (literally just
    // "transfer") then matches EVERY transfer in every future case,
    // routing salary payments, customer collections, internal transfers
    // all to the same account. Bug #1.
    const stop = new Set([
      "تحويل", "حوال", "حوالة", "حوالات", // transfer / transfer(s)
      "رسوم", // fee
      "شراء", "مشتريات", // purchase(s)
      "ايداع", "إيداع", // deposit
      "سحب", // withdrawal
      "transfer", "payment", "fee", "purchase", "deposit", "withdrawal",
      "-", "—", "/", "*", "**", // punctuation that gets split as "words"
    ]);
    const words = opts.txn.description
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !stop.has(w.toLowerCase()) && !stop.has(w));
    matchText = words.slice(0, 4).join(" ");
    ruleKind = "substring";
  }
  if (!matchText || matchText.length < 3) return;

  // Rules are remembered per CLIENT and resolved by account code / std key in the
  // next file's chart (each file has its own copy of the chart).
  const account = await db.account.findUnique({ where: { id: opts.accountId }, select: { code: true, stdKey: true } });
  const kase = opts.caseId ? await db.case.findUnique({ where: { id: opts.caseId }, select: { clientId: true } }) : null;
  const clientId = kase?.clientId ?? null;

  const existing = await db.classificationRule.findFirst({
    where: { firmId: opts.firmId, clientId, matchText, ruleKind, accountCode: account?.code ?? null },
  });
  if (existing) return;

  await db.classificationRule.create({
    data: {
      firmId: opts.firmId,
      clientId,
      matchText,
      accountId: opts.accountId,
      accountCode: account?.code ?? null,
      accountStdKey: account?.stdKey ?? null,
      ruleKind,
      createdFrom: opts.createdFrom,
    },
  });
}

export async function propagateToPayeeSiblings(
  opts: {
    firmId: string;
    accountId: string;
    reason: string;
    sourceTxn: LearnableTxn;
  },
  db: Db = prisma,
): Promise<number> {
  const { sourceTxn: src } = opts;
  const srcEn = (await db.bankTransaction.findUnique({ where: { id: src.id }, select: { enrichment: true } }))?.enrichment as
    | { merchant?: string; counterparty?: string } | null;
  const nameKey = (v?: string | null) => (v ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const srcName = nameKey(srcEn?.merchant ?? srcEn?.counterparty ?? src.counterparty);
  if (!src.beneficiaryKey && srcName.length < 3) return 0;

  const sameDirection = Number(src.amount) < 0 ? { lt: 0 } : { gt: 0 };
  // Same PAYEE (beneficiary key) or same MERCHANT/counterparty name, in this file,
  // still unresolved — "طبّق على كل العمليات المشابهة" (spec §3, §13.6). Fees keep
  // their own treatment (a payment and its bank fee are different accounts).
  const candidates = await db.bankTransaction.findMany({
    where: {
      caseId: src.caseId,
      firmId: opts.firmId,
      id: { not: src.id },
      amount: sameDirection,
      AND: [
        { OR: [{ categorySource: null }, { categorySource: { not: "MANUAL" } }] },
        { OR: [{ categoryAccountId: null }, { categoryConfidence: { lt: 0.7 } }] },
      ],
    },
    select: { id: true, enrichment: true, beneficiaryKey: true, counterparty: true },
  });
  const isFeeRow = (e: unknown): boolean => {
    if (!e || typeof e !== "object") return false;
    const en = e as { isFee?: boolean; kind?: string };
    return en.isFee === true || en.kind === "FEE";
  };
  const rawSiblings = candidates.filter((c) => {
    if (isFeeRow(c.enrichment)) return false;
    if (src.beneficiaryKey && c.beneficiaryKey === src.beneficiaryKey) return true;
    const en = c.enrichment as { merchant?: string; counterparty?: string } | null;
    const n = nameKey(en?.merchant ?? en?.counterparty ?? c.counterparty);
    return srcName.length >= 3 && n === srcName;
  });
  const ids = rawSiblings.map((s) => s.id);
  if (ids.length === 0) return 0;

  await db.bankTransaction.updateMany({
    where: { id: { in: ids } },
    data: {
      categoryAccountId: opts.accountId,
      categoryConfidence: 1,
      categorySource: "MANUAL",
      categoryReason: `${opts.reason} (same payee as an already-resolved transaction)`,
      categoryReasonSource: "manual",
    },
  });

  const now = new Date();
  await db.exception.updateMany({
    where: {
      caseId: src.caseId,
      bankTransactionId: { in: ids },
      status: "OPEN",
      type: { in: ["NEEDS_CLIENT_CLARIFICATION", "LOW_CONFIDENCE_CATEGORY"] },
    },
    data: { status: "RESOLVED", resolvedAt: now, resolvedBy: "system:payee-propagation" },
  });
  await db.clarification.updateMany({
    where: { caseId: src.caseId, bankTransactionId: { in: ids }, status: "OPEN" },
    data: {
      status: "ANSWERED",
      answer: opts.reason,
      answeredAt: now,
      answeredBy: "system:payee-propagation",
    },
  });
  return ids.length;
}
