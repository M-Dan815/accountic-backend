import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { learnFromDecision } from "@/modules/classification/learning";
import { badRequest, notFound } from "@/lib/http-error";

/**
 * Client / accountant clarification workflow.
 *
 * The client asked for this to be a distinct lane from the accountant's
 * exception queue: a transaction whose nature genuinely cannot be inferred
 * from the bank description goes here, the rest of the case keeps
 * processing, and the eventual answer is recorded without the system ever
 * inventing a classification.
 *
 * Two distinct "problem" lanes exist:
 *
 *   Exception            → accountant has enough context to decide (approve,
 *                          re-categorize, flag missing doc, manual match)
 *   Clarification        → accountant does NOT have enough context; the
 *                          answer must come from the client (or a later
 *                          phone call), and the case keeps moving.
 *
 * The client-facing portal is backed by a per-case bearer token
 * (Case.clientAccessToken). Rotating generates a new value and
 * invalidates the old one. See public-clarifications.routes.ts for the
 * public endpoints that consume this token.
 */

// ─── Accountant-facing ──────────────────────────────────────────────────

export async function openClarification(opts: {
  firmId: string;
  caseId: string;
  bankTransactionId?: string;
  invoiceId?: string;
  question: string;
  questionAr?: string;
}) {
  if (!opts.bankTransactionId && !opts.invoiceId) {
    throw badRequest(
      "A clarification must reference a bank transaction or an invoice",
    );
  }
  return prisma.clarification.create({
    data: {
      firmId: opts.firmId,
      caseId: opts.caseId,
      bankTransactionId: opts.bankTransactionId,
      invoiceId: opts.invoiceId,
      question: opts.question,
      questionAr: opts.questionAr,
      status: "OPEN",
    },
  });
}

export async function listOpenClarifications(caseId: string, firmId: string) {
  return prisma.clarification.findMany({
    where: { caseId, firmId, status: "OPEN" },
    include: {
      bankTransaction: {
        select: {
          id: true,
          date: true,
          description: true,
          amount: true,
          reference: true,
        },
      },
      // The AI's proposed account + reason — exposed so the accountant-side
      // Clarifications page can render the same teal callout as the client
      // portal and pre-fill the account dropdown. Same pattern as
      // getCaseByClientToken's include. See public-clarifications.routes.ts.
      proposedAccount: {
        select: { id: true, code: true, name: true, nameAr: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function listAnsweredClarifications(
  caseId: string,
  firmId: string,
) {
  return prisma.clarification.findMany({
    where: { caseId, firmId, status: "ANSWERED" },
    include: {
      bankTransaction: {
        select: {
          id: true,
          date: true,
          description: true,
          amount: true,
          reference: true,
        },
      },
      // Keep parity with listOpenClarifications so the answered list can
      // still render the AI hypothesis (useful when the client denied it
      // and the accountant wants to see what was suggested).
      proposedAccount: {
        select: { id: true, code: true, name: true, nameAr: true },
      },
    },
    orderBy: { answeredAt: "desc" },
  });
}

/**
 * Answer a clarification.
 *
 * If `proposedAccountId` is provided, we apply it to the underlying
 * transaction as a MANUAL classification with the human's own words as
 * the reason — confidence is 1 because a human made the call, not the AI.
 * Same reusable-rule behavior as the exceptions resolver.
 *
 * If it's not provided (the client-portal path), we just record the
 * answer text; the accountant still needs to categorize the transaction
 * through the normal endpoint afterwards.
 */
export async function answerClarification(opts: {
  firmId: string;
  clarificationId: string;
  answeredBy: string;
  answer: string;
  proposedAccountId?: string;
  /** "طبّق على كل العمليات المشابهة": statement = this file only · client = and remember for the client's next files */
  applyToSimilar?: "statement" | "client";
}) {
  const c = await prisma.clarification.findFirst({
    where: { id: opts.clarificationId, firmId: opts.firmId },
  });
  if (!c) throw notFound("Clarification not found");
  if (c.status !== "OPEN")
    throw badRequest("Clarification is already answered");

  return prisma.$transaction(async (tx) => {
    if (opts.proposedAccountId && c.bankTransactionId) {
      const account = await tx.account.findFirst({
        where: {
          id: opts.proposedAccountId,
          firmId: opts.firmId,
          postable: true,
        },
      });
      if (!account)
        throw badRequest(
          "Account not found in this firm's chart of accounts (or not postable)",
        );

      await tx.bankTransaction.update({
        where: { id: c.bankTransactionId },
        data: {
          categoryAccountId: account.id,
          categoryConfidence: 1,
          categorySource: "MANUAL",
          categoryReason: opts.answer,
          categoryReasonSource: "manual",
        },
      });

      const txn = await tx.bankTransaction.findUnique({
        where: { id: c.bankTransactionId },
      });
      if (txn) {
        // One answer settles the payee: creates a reusable rule AND applies
        // the decision to every other unresolved payment to the same payee
        // in this case (see classification/learning.ts).
        await learnFromDecision(
          {
            firmId: opts.firmId,
            accountId: account.id,
            createdFrom: `clarification:${c.id}`,
            scope: opts.applyToSimilar === "statement" ? "none" : undefined,
            reason: opts.answer,
            txn,
          },
          tx,
        );
      }
    }

    return tx.clarification.update({
      where: { id: c.id },
      data: {
        answer: opts.answer,
        answeredAt: new Date(),
        answeredBy: opts.answeredBy,
        status: "ANSWERED",
      },
    });
  });
}

// ─── Client-facing portal (token-backed) ────────────────────────────────

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/**
 * Generate (or rotate) the client-facing access token for a case.
 * Rotating invalidates any previous link. The token is URL-safe base64 of
 * 32 random bytes — enough entropy that brute-forcing is infeasible.
 */
export async function generateClientAccessToken(
  caseId: string,
  firmId: string,
) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!kase) throw notFound("Case not found");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await prisma.case.update({
    where: { id: caseId },
    data: {
      clientAccessToken: token,
      clientAccessTokenExpiresAt: expiresAt,
    },
  });

  return { token, expiresAt };
}

export async function revokeClientAccessToken(caseId: string, firmId: string) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!kase) throw notFound("Case not found");

  await prisma.case.update({
    where: { id: caseId },
    data: { clientAccessToken: null, clientAccessTokenExpiresAt: null },
  });
  return { ok: true };
}

/**
 * Look up a case by its client token, enforcing expiry. Returns only
 * open clarifications + minimal case metadata — nothing else about the
 * case is exposed to a public caller.
 *
 * NOTE: `Case` has no `firm` relation in the schema, only `firmId`. So we
 * cannot `include: { firm: true }` — an invalid key inside `include`
 * discards the ENTIRE include (silently stripping `client` and
 * `clarifications` too, which then cascades into downstream type errors).
 * Fetch the firm in a second query and compose it onto the result.
 */
export async function getCaseByClientToken(token: string) {
  if (!token) return null;

  const kase = await prisma.case.findUnique({
    where: { clientAccessToken: token },
    include: {
      client: true,
      clarifications: {
        where: { status: "OPEN" },
        include: {
          bankTransaction: {
            select: {
              date: true,
              description: true,
              amount: true,
              reference: true,
            },
          },
          // The AI's proposed account + reason — exposed on the public
          // GET so the client portal can render "AI suggests: 5102 —
          // Salaries. Is this correct?" with a one-click confirm button.
          // See public-clarifications.routes.ts → confirmHypothesis.
          proposedAccount: {
            select: { id: true, code: true, name: true, nameAr: true },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!kase) return null;
  if (
    !kase.clientAccessTokenExpiresAt ||
    kase.clientAccessTokenExpiresAt.getTime() < Date.now()
  ) {
    return null;
  }

  const firm = await prisma.firm.findUnique({
    where: { id: kase.firmId },
    select: { name: true, nameAr: true },
  });

  return { ...kase, firm };
}
