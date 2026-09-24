import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { learnFromDecision } from "@/modules/classification/learning";
import { notFound, badRequest } from "@/lib/http-error";

export const casesRouter = Router();

casesRouter.get("/:caseId", async (req, res) => {
  const kase = await prisma.case.findFirst({
    where: { id: req.params.caseId, firmId: req.auth!.firmId },
    include: { client: true, documents: true },
  });
  if (!kase) throw notFound("Case not found");
  res.json(kase);
});

// ─── DELETE /cases/:caseId ─────────────────────────────────────────────
// Removes a case and everything hanging off it. Manual adjustment lines,
// bank-derived journal lines, exceptions, clarifications, extracted
// transactions/invoices, and document rows all go. Storage files are
// left in place — see note at the bottom of this file.
casesRouter.delete("/:caseId", async (req, res) => {
  const kase = await prisma.case.findFirst({
    where: { id: req.params.caseId, firmId: req.auth!.firmId },
  });
  if (!kase) throw notFound("Case not found");

  await prisma.$transaction(async (tx) => {
    // Break self-references first — BankTransaction.duplicateOfId and
    // matchedInvoiceId form a graph Prisma can't order deletions through.
    await tx.bankTransaction.updateMany({
      where: { caseId: kase.id, firmId: req.auth!.firmId },
      data: { duplicateOfId: null, matchedInvoiceId: null },
    });

    // Order matters: children before parents.
    await tx.exception.deleteMany({ where: { caseId: kase.id } });
    await tx.clarification.deleteMany({ where: { caseId: kase.id } });
    await tx.journalLine.deleteMany({ where: { caseId: kase.id } });
    await tx.bankTransaction.deleteMany({ where: { caseId: kase.id } });
    await tx.invoice.deleteMany({ where: { caseId: kase.id } });
    await tx.document.deleteMany({ where: { caseId: kase.id } });
    await tx.account.deleteMany({ where: { caseId: kase.id, firmId: req.auth!.firmId } }); // this file's own chart
    await tx.case.delete({ where: { id: kase.id } });
  });

  res.json({ ok: true });
});

casesRouter.get("/:caseId/transactions", async (req, res) => {
  const transactions = await prisma.bankTransaction.findMany({
    where: { caseId: req.params.caseId, firmId: req.auth!.firmId },
    include: {
      categoryAccount: true,
      matchedInvoice: true,
      document: { select: { fileName: true, id: true } },
      // Include the paired original txn (when this row is a refund) so
      // the reconciliation UI can render "Refund of {date · merchant}".
      // Anas feedback #4.
      pairedWithTxn: {
        select: {
          id: true,
          date: true,
          description: true,
          counterparty: true,
          amount: true,
        },
      },
    },
    orderBy: { date: "asc" },
  });
  res.json(transactions);
});

casesRouter.get("/:caseId/invoices", async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    where: { caseId: req.params.caseId, firmId: req.auth!.firmId },
    include: { document: { select: { fileName: true, id: true } } },
    orderBy: { date: "asc" },
  });
  res.json(invoices);
});

casesRouter.get("/:caseId/exceptions", async (req, res) => {
  const exceptions = await prisma.exception.findMany({
    where: { caseId: req.params.caseId, firmId: req.auth!.firmId },
    orderBy: { createdAt: "asc" },
  });

  const txnIds = exceptions
    .map((e) => e.bankTransactionId)
    .filter((x): x is string => !!x);
  const invIds = exceptions
    .map((e) => e.invoiceId)
    .filter((x): x is string => !!x);
  const [transactions, invoices] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { id: { in: txnIds } },
      include: { categoryAccount: true },
    }),
    prisma.invoice.findMany({ where: { id: { in: invIds } } }),
  ]);
  const txnById = new Map(transactions.map((t) => [t.id, t]));
  const invById = new Map(invoices.map((i) => [i.id, i]));

  res.json(
    exceptions.map((e) => ({
      ...e,
      bankTransaction: e.bankTransactionId
        ? txnById.get(e.bankTransactionId)
        : null,
      invoice: e.invoiceId ? invById.get(e.invoiceId) : null,
    })),
  );
});

// ─── Exceptions: resolve ───────────────────────────────────────────────

const resolveSchema = z.object({
  action: z.enum([
    "approve",
    "flag_missing_doc",
    "manual_category",
    "manual_match",
  ]),
  accountId: z.string().optional(),
  invoiceId: z.string().optional(),
  ruleScope: z.enum(["none", "description", "merchant"]).default("description"),
  ruleText: z.string().optional(),
});

casesRouter.post(
  "/:caseId/exceptions/:exceptionId/resolve",
  async (req, res) => {
    const exception = await prisma.exception.findFirst({
      where: {
        id: req.params.exceptionId,
        caseId: req.params.caseId,
        firmId: req.auth!.firmId,
      },
    });
    if (!exception) throw notFound("Exception not found");

    const body = resolveSchema.parse(req.body);

    if (body.action === "manual_category") {
      if (!body.accountId || !exception.bankTransactionId)
        throw badRequest("accountId and a bound transaction are required");

      // Validate the account against the firm's CoA before writing.
      // (The old code used findUnique without a firm scope — this closes
      // that gap and lets us build a meaningful reason string.)
      const account = await prisma.account.findFirst({
        where: {
          id: body.accountId,
          firmId: req.auth!.firmId,
          postable: true,
        },
      });
      if (!account)
        throw badRequest(
          "Account not found in this firm's chart of accounts (or not postable)",
        );

      const txn = await prisma.bankTransaction.update({
        where: { id: exception.bankTransactionId },
        data: {
          categoryAccountId: account.id,
          categoryConfidence: 1,
          categorySource: "MANUAL",
          // FIX: populate the audit-trail reason so the UI's reason
          // column isn't blank after an accountant override.
          categoryReason: `Manually categorized as ${account.code} — ${account.name}`,
          categoryReasonSource: "manual",
        },
      });

      await learnFromDecision({
        firmId: req.auth!.firmId,
        accountId: account.id,
        createdFrom: `accountant-approval:${txn.id}`,
        scope: body.ruleScope,
        ruleText: body.ruleText,
        reason: `Manually categorized as ${account.code} — ${account.name}`,
        txn,
      });
    }

    if (body.action === "manual_match") {
      if (!body.invoiceId || !exception.bankTransactionId)
        throw badRequest("invoiceId and a bound transaction are required");
      await prisma.bankTransaction.update({
        where: { id: exception.bankTransactionId },
        data: {
          matchedInvoiceId: body.invoiceId,
          matchStatus: "MATCHED",
          matchConfidence: 1,
        },
      });
    }

    const status =
      body.action === "flag_missing_doc" ? "FLAGGED_MISSING_DOC" : "RESOLVED";
    const updated = await prisma.exception.update({
      where: { id: exception.id },
      data: { status, resolvedAt: new Date(), resolvedBy: req.auth!.userId },
    });

    res.json(updated);
  },
);

// ─── Transactions: direct categorization and manual match ──────────────

const categorySchema = z.object({
  accountId: z.string().min(1),
  ruleScope: z.enum(["none", "description", "merchant"]).optional(),
  ruleText: z.string().optional(),
});

casesRouter.post("/:caseId/transactions/:txnId/category", async (req, res) => {
  const txn = await prisma.bankTransaction.findFirst({
    where: {
      id: req.params.txnId,
      caseId: req.params.caseId,
      firmId: req.auth!.firmId,
    },
  });
  if (!txn) throw notFound("Transaction not found");

  const body = categorySchema.parse(req.body);
  const account = await prisma.account.findFirst({
    where: { id: body.accountId, firmId: req.auth!.firmId, postable: true },
  });
  if (!account)
    throw badRequest(
      "Account not found in this firm's chart of accounts (or not postable)",
    );

  await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      categoryAccountId: account.id,
      categoryConfidence: 1,
      categorySource: "MANUAL",
      // FIX: same audit-trail reason as the exception path, so the
      // reconciliation reason column stays populated after an override.
      categoryReason: `Manually categorized as ${account.code} — ${account.name}`,
      categoryReasonSource: "manual",
    },
  });

  await learnFromDecision({
    firmId: req.auth!.firmId,
    accountId: account.id,
    createdFrom: `manual-category:${txn.id}`,
    scope: body.ruleScope ?? "description",
    ruleText: body.ruleText,
    reason: `Manually categorized as ${account.code} — ${account.name}`,
    txn,
  });

  await prisma.exception.updateMany({
    where: {
      caseId: req.params.caseId,
      bankTransactionId: txn.id,
      type: "LOW_CONFIDENCE_CATEGORY",
      status: "OPEN",
    },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
      resolvedBy: req.auth!.userId,
    },
  });

  res.json({ ok: true });
});

const matchSchema = z.object({ invoiceId: z.string().min(1).optional() });

casesRouter.post("/:caseId/transactions/:txnId/match", async (req, res) => {
  const txn = await prisma.bankTransaction.findFirst({
    where: {
      id: req.params.txnId,
      caseId: req.params.caseId,
      firmId: req.auth!.firmId,
    },
  });
  if (!txn) throw notFound("Transaction not found");

  const body = matchSchema.parse(req.body);
  if (body.invoiceId) {
    const invoice = await prisma.invoice.findFirst({
      where: {
        id: body.invoiceId,
        caseId: req.params.caseId,
        firmId: req.auth!.firmId,
      },
    });
    if (!invoice) throw badRequest("Invoice not found in this case");
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: {
        matchedInvoiceId: invoice.id,
        matchStatus: "MATCHED",
        matchConfidence: 1,
      },
    });
  } else {
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: { matchStatus: "MATCHED", matchConfidence: 1 },
    });
  }

  await prisma.exception.updateMany({
    where: {
      caseId: req.params.caseId,
      bankTransactionId: txn.id,
      type: "UNMATCHED_TRANSACTION",
      status: "OPEN",
    },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
      resolvedBy: req.auth!.userId,
    },
  });

  res.json({ ok: true });
});

// ─── Similar transactions (Anas feedback #1) ─────────────────────────────
// Returns existing transactions in this case that look "similar" to the
// given source transaction, so the accountant can pick a subset to apply
// the same account to. "Similar" = same enrichment.kind (movement kind,
// e.g. POS_PURCHASE / TRANSFER_OUT) AND same normalised counterparty OR
// memo keyword. Excludes the source txn itself.

casesRouter.get(
  "/:caseId/transactions/:txnId/similar",
  async (req, res) => {
    const src = await prisma.bankTransaction.findFirst({
      where: {
        id: req.params.txnId,
        caseId: req.params.caseId,
        firmId: req.auth!.firmId,
      },
    });
    if (!src) throw notFound("Transaction not found");

    const srcEn = (src.enrichment ?? {}) as {
      kind?: string;
      counterparty?: string;
      merchant?: string;
      memo?: string;
    };
    const srcKey = srcEn.merchant ?? srcEn.counterparty ?? src.counterparty ?? "";
    const kind = srcEn.kind;
    if (!kind || !srcKey) {
      res.json([]);
      return;
    }
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\u0600-\u06FF\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const srcKeyNorm = normalize(srcKey);

    const candidates = await prisma.bankTransaction.findMany({
      where: {
        caseId: req.params.caseId,
        firmId: req.auth!.firmId,
        id: { not: src.id },
      },
      include: { categoryAccount: true },
      orderBy: { date: "asc" },
    });

    const similar = candidates.filter((t) => {
      const en = (t.enrichment ?? {}) as {
        kind?: string;
        counterparty?: string;
        merchant?: string;
      };
      if (en.kind !== kind) return false;
      const tKey = en.merchant ?? en.counterparty ?? t.counterparty ?? "";
      return normalize(tKey) === srcKeyNorm;
    });

    res.json(
      similar.map((t) => ({
        id: t.id,
        date: t.date,
        amount: Number(t.amount),
        description: t.description,
        counterparty: t.counterparty,
        categoryAccountId: t.categoryAccountId,
        categoryAccount: t.categoryAccount,
        categoryConfidence: Number(t.categoryConfidence),
        categorySource: t.categorySource,
      })),
    );
  },
);

// ─── Bulk categorize (Anas feedback #1) ────────────────────────────────
// Apply one account to a list of specific transactions at once.

const bulkCategorizeSchema = z.object({
  accountId: z.string().min(1),
  txnIds: z.array(z.string().min(1)).min(1),
  reason: z.string().optional(),
  ruleScope: z.enum(["none", "description", "merchant"]).default("description"),
  ruleText: z.string().optional(),
});

casesRouter.post("/:caseId/transactions/bulk-categorize", async (req, res) => {
  const kase = await prisma.case.findFirst({
    where: { id: req.params.caseId, firmId: req.auth!.firmId },
  });
  if (!kase) throw notFound("Case not found");

  const body = bulkCategorizeSchema.parse(req.body);
  const account = await prisma.account.findFirst({
    where: { id: body.accountId, firmId: req.auth!.firmId, postable: true },
  });
  if (!account) throw badRequest("Account not found (or not postable)");

  const reason =
    body.reason ?? `Bulk-categorized as ${account.code} — ${account.name}`;

  const txns = await prisma.bankTransaction.findMany({
    where: {
      id: { in: body.txnIds },
      caseId: kase.id,
      firmId: req.auth!.firmId,
    },
  });
  if (txns.length === 0) throw badRequest("No matching transactions found");

  await prisma.$transaction(async (tx) => {
    await tx.bankTransaction.updateMany({
      where: { id: { in: txns.map((t) => t.id) } },
      data: {
        categoryAccountId: account.id,
        categoryConfidence: 1,
        categorySource: "MANUAL",
        categoryReason: reason,
        categoryReasonSource: "manual",
      },
    });
    await tx.exception.updateMany({
      where: {
        caseId: kase.id,
        bankTransactionId: { in: txns.map((t) => t.id) },
        status: "OPEN",
        type: { in: ["NEEDS_CLIENT_CLARIFICATION", "LOW_CONFIDENCE_CATEGORY", "UNMATCHED_TRANSACTION"] },
      },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolvedBy: req.auth!.userId,
      },
    });
    // Create a reusable rule from the first txn (representative).
    if (body.ruleScope !== "none") {
      const src = txns[0];
      const srcEn = (src.enrichment ?? {}) as {
        counterparty?: string;
        beneficiaryKey?: string;
      };
      let matchText: string | undefined;
      let ruleKind: "substring" | "merchant" | "beneficiary" = "substring";
      if (body.ruleText) {
        matchText = body.ruleText;
        ruleKind = body.ruleScope === "merchant" ? "merchant" : "substring";
      } else if (srcEn.beneficiaryKey) {
        matchText = srcEn.beneficiaryKey;
        ruleKind = "beneficiary";
      } else if (body.ruleScope === "merchant" && (src.counterparty ?? srcEn.counterparty)) {
        matchText = (src.counterparty ?? srcEn.counterparty)!.slice(0, 60);
        ruleKind = "merchant";
      } else {
        const stop = new Set(["تحويل", "حوال", "حوالة", "حوالات", "رسوم", "شراء", "مشتريات", "ايداع", "إيداع", "سحب", "transfer", "payment", "fee", "purchase", "deposit", "withdrawal", "-", "—", "/", "*", "**"]);
        const words = src.description.split(/\s+/).filter((w) => w.length >= 3 && !stop.has(w.toLowerCase()) && !stop.has(w));
        matchText = words.slice(0, 4).join(" ");
      }
      if (matchText && matchText.length >= 3) {
        const existing = await tx.classificationRule.findFirst({
          where: { firmId: req.auth!.firmId, matchText, accountId: account.id },
        });
        if (!existing) {
          await tx.classificationRule.create({
            data: {
              firmId: req.auth!.firmId,
              matchText,
              accountId: account.id,
              ruleKind,
              createdFrom: `bulk-categorize:${src.id}`,
            },
          });
        }
      }
    }
  });

  res.json({ ok: true, applied: txns.length });
});

// ─── Split categorization (Anas feedback #2) ───────────────────────────
// Stores a split allocation for a transaction: an array of
// {accountId, amount} pairs whose amounts sum to |txn.amount|.

const splitSchema = z.object({
  splits: z
    .array(
      z.object({
        accountId: z.string().min(1),
        amount: z.number().positive(),
      }),
    )
    .min(2),
  reason: z.string().optional(),
});

casesRouter.post("/:caseId/transactions/:txnId/split", async (req, res) => {
  const txn = await prisma.bankTransaction.findFirst({
    where: {
      id: req.params.txnId,
      caseId: req.params.caseId,
      firmId: req.auth!.firmId,
    },
  });
  if (!txn) throw notFound("Transaction not found");

  const body = splitSchema.parse(req.body);
  const absAmount = Math.abs(Number(txn.amount));
  const total = body.splits.reduce((a, s) => a + s.amount, 0);
  if (Math.abs(total - absAmount) > 0.01) {
    throw badRequest(
      `Split amounts sum to ${total.toFixed(2)} but the transaction is ${absAmount.toFixed(2)} SAR — they must match.`,
    );
  }

  const accounts = await prisma.account.findMany({
    where: {
      id: { in: body.splits.map((s) => s.accountId) },
      firmId: req.auth!.firmId,
      postable: true,
    },
  });
  if (accounts.length !== body.splits.length) {
    throw badRequest("One or more accounts not found in this firm's CoA (or not postable)");
  }

  const reason =
    body.reason ?? `Split across ${body.splits.length} accounts by the accountant`;

  await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      splits: body.splits as unknown as Prisma.InputJsonValue,
      categoryAccountId: body.splits.reduce((max, s) =>
        s.amount > max.amount ? s : max,
      ).accountId,
      categoryConfidence: 1,
      categorySource: "MANUAL",
      categoryReason: reason,
      categoryReasonSource: "manual",
    },
  });

  res.json({ ok: true });
});

casesRouter.delete("/:caseId/transactions/:txnId/split", async (req, res) => {
  const txn = await prisma.bankTransaction.findFirst({
    where: {
      id: req.params.txnId,
      caseId: req.params.caseId,
      firmId: req.auth!.firmId,
    },
  });
  if (!txn) throw notFound("Transaction not found");

  await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: { splits: Prisma.JsonNull },
  });
  res.json({ ok: true });
});

// ─── Statement extraction verification (Anas feedback #8) ───────────────
// Returns the BALANCE_BREAK issues from the document's extractionReport
// alongside the transactions around each break, so the accountant can
// see exactly which row to compare against the original PDF.

casesRouter.get(
  "/:caseId/documents/:documentId/verification",
  async (req, res) => {
    const doc = await prisma.document.findFirst({
      where: {
        id: req.params.documentId,
        caseId: req.params.caseId,
        firmId: req.auth!.firmId,
      },
      select: {
        id: true,
        fileName: true,
        extractionMethod: true,
        extractionReport: true,
      },
    });
    if (!doc) throw notFound("Document not found");

    const report = (doc.extractionReport ?? null) as {
      status?: string;
      issues?: Array<{
        code?: string;
        index?: number;
        message?: string;
        gap?: number;
      }>;
    } | null;

    const txns = await prisma.bankTransaction.findMany({
      where: {
        documentId: doc.id,
        caseId: req.params.caseId,
        firmId: req.auth!.firmId,
      },
      orderBy: { rawRowIndex: "asc" },
      select: {
        id: true,
        rawRowIndex: true,
        date: true,
        description: true,
        amount: true,
        enrichment: true,
      },
    });

    const issuesWithContext = (report?.issues ?? []).map((issue) => {
      const idx = issue.index ?? 0;
      const context = txns.filter(
        (t) =>
          t.rawRowIndex != null &&
          t.rawRowIndex >= idx - 2 &&
          t.rawRowIndex <= idx + 2,
      );
      return {
        ...issue,
        context: context.map((t) => ({
          id: t.id,
          rawRowIndex: t.rawRowIndex,
          date: t.date,
          description: t.description.slice(0, 120),
          amount: Number(t.amount),
          kind: ((t.enrichment ?? {}) as { kind?: string })?.kind ?? null,
        })),
      };
    });

    res.json({
      document: doc,
      status: report?.status ?? "UNVERIFIED",
      issues: issuesWithContext,
      totalRows: txns.length,
    });
  },
);
