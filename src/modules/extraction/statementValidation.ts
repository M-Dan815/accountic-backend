/**
 * Integrity checks for an extracted bank statement — the thing that makes
 * "AI read the pages" safe. Extraction (deterministic OR vision) can drop a
 * row, swap debit/credit, or misread a digit. Arithmetic catches all three:
 *
 *   • balance continuity — each row's running balance must equal the previous
 *     balance ± its amount (checked in BOTH orderings; banks list newest-first
 *     or oldest-first)
 *   • declared totals    — sum of debits/credits vs the statement footer
 *   • opening/closing    — opening + Σ amounts = closing
 *   • date order         — monotonic in the detected direction
 *
 * A dropped row shows up as a balance gap whose size equals the missing
 * amount, so the report says WHERE and HOW MUCH.
 *
 * Pure functions; no DB, no AI.
 */

import type { ExtractedBankTransaction } from "@/lib/ai-provider";

const EPS = 0.011;

export type StatementIssue = {
  code:
    | "BALANCE_BREAK"
    | "TOTALS_MISMATCH"
    | "OPENING_CLOSING_MISMATCH"
    | "DATE_ORDER"
    | "BALANCE_ORDER"
    | "NO_ROWS";
  /** 0-based index of the row AFTER the break (or the offending row). */
  index?: number;
  /** Short, Arabic, user-facing. Never developer text. */
  message: string;
  /** For BALANCE_BREAK: unexplained amount (≈ a missing row's value). */
  gap?: number;
  /** Last row of a merged group of breaks (BALANCE_ORDER). */
  toIndex?: number;
  /** Buttons the UI must offer next to this issue (spec §3: no error without a button that solves it). */
  actions?: ("fix_row" | "accept_difference" | "reupload")[];
};

export type StatementReport = {
  /**
   * VERIFIED   — arithmetic proves the extraction is complete and consistent
   * UNVERIFIED — nothing to check against (no balance column / no totals)
   * FAILED     — at least one check failed; do not trust the numbers
   */
  status: "VERIFIED" | "UNVERIFIED" | "FAILED";
  rows: number;
  direction: "oldest-first" | "newest-first" | "unknown";
  balanceChecked: number;
  issues: StatementIssue[];
};

export type DeclaredTotals = {
  totalDebits?: number;
  totalCredits?: number;
  openingBalance?: number;
  closingBalance?: number;
};

type Row = Pick<ExtractedBankTransaction, "date" | "amount" | "balance">;

/** Breaks when rows are listed OLDEST first: bal[i] = bal[i-1] + amt[i]. */
function breaksOldestFirst(rows: Row[]): { idx: number; gap: number }[] {
  const out: { idx: number; gap: number }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].balance, b = rows[i].balance;
    if (a == null || b == null) continue;
    const gap = b - (a + rows[i].amount);
    if (Math.abs(gap) > EPS) out.push({ idx: i, gap });
  }
  return out;
}

/** Breaks when rows are listed NEWEST first: bal[i-1] = bal[i] + amt[i-1]. */
function breaksNewestFirst(rows: Row[]): { idx: number; gap: number }[] {
  const out: { idx: number; gap: number }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].balance, b = rows[i].balance;
    if (a == null || b == null) continue;
    const gap = a - (b + rows[i - 1].amount);
    if (Math.abs(gap) > EPS) out.push({ idx: i, gap });
  }
  return out;
}

export function validateStatement(
  rows: Row[],
  declared: DeclaredTotals = {},
  forceDirection?: "oldest-first" | "newest-first",
): StatementReport {
  const issues: StatementIssue[] = [];
  if (rows.length === 0) {
    return {
      status: "FAILED",
      rows: 0,
      direction: "unknown",
      balanceChecked: 0,
      issues: [{ code: "NO_ROWS", message: "لم نستخرج أي عملية من هذا الكشف. جرّب رفع نسخة أوضح أو أدخل العمليات يدويًا.", actions: ["reupload"] }],
    };
  }

  const withBalance = rows.filter((r) => r.balance != null).length;
  let direction: StatementReport["direction"] = forceDirection ?? "unknown";
  let breaks: { idx: number; gap: number }[] = [];
  let balanceChecked = 0;

  if (withBalance >= 2) {
    balanceChecked = withBalance - 1;
    const asc = breaksOldestFirst(rows);
    const desc = breaksNewestFirst(rows);
    if (forceDirection === "oldest-first") breaks = asc;
    else if (forceDirection === "newest-first") breaks = desc;
    else if (asc.length <= desc.length) {
      direction = "oldest-first";
      breaks = asc;
    } else {
      direction = "newest-first";
      breaks = desc;
    }
    // Consecutive breaks whose gaps cancel out (e.g. +1,839.82 · +2.30 · −1,842.12) are ONE
    // problem — two rows read in the wrong order or one misread balance — not three alerts.
    const money = (n: number) => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 });
    let k = 0;
    while (k < breaks.length) {
      let end = k, sum = breaks[k].gap;
      while (Math.abs(sum) > EPS && end + 1 < breaks.length && breaks[end + 1].idx - breaks[end].idx <= 2) {
        end++;
        sum += breaks[end].gap;
      }
      if (end > k && Math.abs(sum) <= EPS) {
        issues.push({
          code: "BALANCE_ORDER",
          index: breaks[k].idx,
          toIndex: breaks[end].idx,
          message: `خطأ قراءة رصيد أو ترتيب صفوف بين الصف ${breaks[k].idx + 1} والصف ${breaks[end].idx + 1} (الفروقات تلغي بعضها). صحّح الصفوف بجانب صورة الصفحة.`,
          actions: ["fix_row", "accept_difference"],
        });
        k = end + 1;
      } else {
        const b = breaks[k];
        issues.push({
          code: "BALANCE_BREAK",
          index: b.idx,
          gap: Math.round(b.gap * 100) / 100,
          message: `الرصيد ${b.gap > 0 ? "يرتفع" : "ينخفض"} بمقدار ${money(b.gap)} ريال عند الصف ${b.idx + 1} دون عملية تفسّره — غالبًا صف ناقص أو مبلغ مقروء خطأ. قارن بالصفحة الأصلية.`,
          actions: ["fix_row", "accept_difference"],
        });
        k++;
      }
    }
  }

  // Date order (only meaningful once direction is known).
  if (direction !== "unknown") {
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].date.slice(0, 10), cur = rows[i].date.slice(0, 10);
      const bad = direction === "oldest-first" ? cur < prev : cur > prev;
      if (bad) {
        issues.push({
          code: "DATE_ORDER",
          index: i,
          message: `تاريخ الصف ${i + 1} (${cur}) خارج ترتيب الكشف — قد يكون التاريخ مقروءًا خطأ.`, actions: ["fix_row"],
        });
        break; // one is enough to flag the statement
      }
    }
  }

  const debits = rows.filter((r) => r.amount < 0).reduce((a, r) => a + -r.amount, 0);
  const credits = rows.filter((r) => r.amount > 0).reduce((a, r) => a + r.amount, 0);
  let totalsChecked = false;

  if (declared.totalDebits != null && Math.abs(debits - declared.totalDebits) > EPS) {
    totalsChecked = true;
    issues.push({ code: "TOTALS_MISMATCH", message: `مجموع المدين المستخرج ${debits.toFixed(2)} لا يطابق إجمالي الكشف ${declared.totalDebits.toFixed(2)}.`, actions: ["fix_row", "accept_difference"] });
  } else if (declared.totalDebits != null) totalsChecked = true;
  if (declared.totalCredits != null && Math.abs(credits - declared.totalCredits) > EPS) {
    totalsChecked = true;
    issues.push({ code: "TOTALS_MISMATCH", message: `مجموع الدائن المستخرج ${credits.toFixed(2)} لا يطابق إجمالي الكشف ${declared.totalCredits.toFixed(2)}.`, actions: ["fix_row", "accept_difference"] });
  } else if (declared.totalCredits != null) totalsChecked = true;

  if (declared.openingBalance != null && declared.closingBalance != null) {
    totalsChecked = true;
    const expected = declared.openingBalance + credits - debits;
    if (Math.abs(expected - declared.closingBalance) > EPS) {
      issues.push({
        code: "OPENING_CLOSING_MISMATCH",
        message: `الرصيد الافتتاحي ${declared.openingBalance.toFixed(2)} + الدائن − المدين = ${expected.toFixed(2)} بينما يُقفل الكشف عند ${declared.closingBalance.toFixed(2)}.`, actions: ["fix_row", "accept_difference"],
      });
    }
  }

  const status: StatementReport["status"] =
    issues.length > 0 ? "FAILED" : balanceChecked > 0 || totalsChecked ? "VERIFIED" : "UNVERIFIED";

  return { status, rows: rows.length, direction, balanceChecked, issues };
}

/**
 * Do two consecutive chunks (pages N-1 | N) join up? Uses the direction
 * already established by the first chunk.
 */
export function joinsUp(
  prevLast: Row | undefined,
  nextFirst: Row | undefined,
  direction: StatementReport["direction"],
): boolean {
  if (!prevLast || !nextFirst || prevLast.balance == null || nextFirst.balance == null) return true;
  if (direction === "oldest-first")
    return Math.abs(nextFirst.balance - (prevLast.balance + nextFirst.amount)) <= EPS;
  if (direction === "newest-first")
    return Math.abs(prevLast.balance - (nextFirst.balance + prevLast.amount)) <= EPS;
  return true;
}


/** Opening / closing balance of a statement, from the running-balance column of its rows. */
export function statementBalances(
  rows: Pick<ExtractedBankTransaction, "amount" | "balance">[],
  direction: StatementReport["direction"],
): { opening: number | null; closing: number | null } {
  if (rows.length === 0) return { opening: null, closing: null };
  const first = rows[0], last = rows[rows.length - 1];
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (direction === "newest-first") {
    return {
      closing: first.balance != null ? r2(first.balance) : null,
      opening: last.balance != null ? r2(last.balance - last.amount) : null,
    };
  }
  return {
    opening: first.balance != null ? r2(first.balance - first.amount) : null,
    closing: last.balance != null ? r2(last.balance) : null,
  };
}
