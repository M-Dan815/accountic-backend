/**
 * Pure matching logic — no DB access here on purpose, so it's independently
 * testable and the scoring rules are auditable in one place.
 */

export type MatchCandidateTransaction = {
  id: string;
  date: Date;
  description: string;
  amount: number;
};

export type MatchCandidateInvoice = {
  id: string;
  date: Date | null;
  invoiceNumber: string | null;
  counterparty: string | null;
  amountTotal: number;
  direction: "PAYABLE" | "RECEIVABLE";
};

export type MatchResult = {
  invoiceId: string;
  confidence: number;
  components: {
    amount: number;
    date: number;
    text: number;
  };
};

const AMOUNT_WEIGHT = 0.55;
const DATE_WEIGHT = 0.2;
const TEXT_WEIGHT = 0.25;

const NO_TEXT_MIN_AMOUNT_SCORE = 0.9;
const NO_TEXT_HIGH_CONFIDENCE_MIN_AMOUNT_SCORE = 0.6;

export function normalizeArabic(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\u0640/g, "")
    .replace(/\u06CC/g, "\u064A")
    .replace(/\u06A9/g, "\u0643")
    .replace(/[أإآٱا]/g, "\u0627")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064A")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function amountScore(txnAmount: number, invoiceAmount: number): number {
  if (invoiceAmount <= 0) return 0;
  const diff = Math.abs(Math.abs(txnAmount) - invoiceAmount);
  const relDiff = diff / invoiceAmount;
  if (relDiff <= 0.005) return 1;
  if (relDiff >= 0.25) return 0;
  return 1 - relDiff / 0.25;
}

function dateScore(txnDate: Date, invoiceDate: Date | null): number {
  if (!invoiceDate) return 0.3;
  const diffDays = Math.abs(
    (txnDate.getTime() - invoiceDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays <= 3) return 1;
  if (diffDays >= 45) return 0;
  return 1 - diffDays / 45;
}

function textScore(
  description: string,
  invoice: MatchCandidateInvoice,
): number {
  const desc = normalizeArabic(description);
  let score = 0;

  if (invoice.invoiceNumber) {
    const invNum = normalizeArabic(invoice.invoiceNumber);
    if (invNum && desc.includes(invNum)) {
      score += 0.6;
    }
    const numeric = invNum.replace(/\D/g, "");
    if (numeric.length >= 4 && desc.includes(numeric)) {
      score += 0.2;
    }
  }

  if (invoice.counterparty) {
    const tokens = [
      ...new Set(
        normalizeArabic(invoice.counterparty)
          .split(/\s+/)
          .filter((t) => t.length > 2),
      ),
    ];
    if (tokens.length > 0) {
      const matched = tokens.filter((t) => desc.includes(t));
      score += 0.4 * (matched.length / tokens.length);
    }
  }

  return Math.min(1, score);
}

function directionCompatible(
  txnAmount: number,
  invoice: MatchCandidateInvoice,
): boolean {
  return txnAmount < 0
    ? invoice.direction === "PAYABLE"
    : invoice.direction === "RECEIVABLE";
}

export function scoreBestMatch(
  txn: MatchCandidateTransaction,
  invoices: MatchCandidateInvoice[],
): MatchResult | null {
  let best: MatchResult | null = null;

  for (const inv of invoices) {
    if (!directionCompatible(txn.amount, inv)) continue;

    const a = amountScore(txn.amount, inv.amountTotal);
    const d = dateScore(txn.date, inv.date);
    const t = textScore(txn.description, inv);

    if (t < 0.05 && a < NO_TEXT_MIN_AMOUNT_SCORE) continue;

    const confidence = AMOUNT_WEIGHT * a + DATE_WEIGHT * d + TEXT_WEIGHT * t;

    if (!best || confidence > best.confidence) {
      best = {
        invoiceId: inv.id,
        confidence,
        components: { amount: a, date: d, text: t },
      };
    }
  }

  if (best && best.confidence < 0.2) return null;

  if (
    best &&
    best.components.text < 0.05 &&
    best.components.amount < NO_TEXT_HIGH_CONFIDENCE_MIN_AMOUNT_SCORE &&
    best.confidence < 0.85
  ) {
    return null;
  }

  return best;
}

export const MATCH_THRESHOLDS = {
  matched: 0.85,
  needsReview: 0.4,
} as const;

export function statusForConfidence(
  confidence: number,
): "MATCHED" | "NEEDS_REVIEW" | "UNMATCHED" {
  if (confidence >= MATCH_THRESHOLDS.matched) return "MATCHED";
  if (confidence >= MATCH_THRESHOLDS.needsReview) return "NEEDS_REVIEW";
  return "UNMATCHED";
}
