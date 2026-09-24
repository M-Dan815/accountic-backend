import type {
  AiProvider,
  ExtractedBankTransaction,
  InvoiceImage,
} from "@/lib/ai-provider";
import {
  joinsUp,
  validateStatement,
  type DeclaredTotals,
  type StatementReport,
} from "./statementValidation";

/**
 * Read a bank statement from page IMAGES with a vision model — any bank, any
 * layout, scanned or digital. Because a model can drop or misread rows, the
 * result is never trusted on its own:
 *
 *   • pages go in small chunks (default 3) so output stays complete
 *   • every chunk is checked arithmetically (running balances) and must join
 *     up with the previous chunk
 *   • a chunk that fails is re-read page by page; the better attempt wins
 *   • the merged statement is validated once more (opening/closing, order)
 *
 * Whatever still fails is REPORTED (status FAILED + where/how much), never
 * silently accepted.
 */

export type VisionStatementResult = {
  transactions: ExtractedBankTransaction[];
  declared: DeclaredTotals;
  report: StatementReport;
  chunks: number;
  retried: number;
};

const CHUNK_PAGES = 3;

export async function extractStatementFromPages(
  provider: Pick<AiProvider, "extractBankStatementFromImages" | "name">,
  pages: Buffer[],
  opts: { chunkPages?: number; log?: (m: string) => void } = {},
): Promise<VisionStatementResult> {
  const log = opts.log ?? (() => {});
  const size = opts.chunkPages ?? CHUNK_PAGES;
  const img = (b: Buffer): InvoiceImage => ({ data: b, mimeType: "image/png" });

  const rows: ExtractedBankTransaction[] = [];
  let direction: StatementReport["direction"] = "unknown";
  let opening: number | undefined;
  let closing: number | undefined;
  let singleChunkTotals: { d?: number; c?: number } = {};
  let retried = 0;
  let chunks = 0;

  const read = async (from: number, to: number) => {
    const range = from === to ? `page ${from + 1}` : `pages ${from + 1}-${to + 1}`;
    const prev = rows[rows.length - 1];
    return provider.extractBankStatementFromImages(
      pages.slice(from, to + 1).map(img),
      { pageRange: range, previousBalance: prev?.balance },
    );
  };

  /** A chunk is acceptable if it is internally consistent and joins the previous one. */
  const acceptable = (r: { transactions: ExtractedBankTransaction[] }) => {
    if (r.transactions.length === 0) return false;
    const v = validateStatement(r.transactions, {}, direction === "unknown" ? undefined : direction);
    const joins = joinsUp(rows[rows.length - 1], r.transactions[0], direction);
    return v.status !== "FAILED" && joins;
  };

  for (let from = 0; from < pages.length; from += size) {
    const to = Math.min(from + size - 1, pages.length - 1);
    chunks++;
    let result = await read(from, to);
    let chosen = result.transactions;
    let chosenMeta = result;

    if (!acceptable(result)) {
      log(`chunk pages ${from + 1}-${to + 1}: failed verification → re-reading page by page`);
      retried++;
      const merged: ExtractedBankTransaction[] = [];
      let firstMeta: typeof result | undefined;
      let lastMeta: typeof result | undefined;
      for (let p = from; p <= to; p++) {
        const one = await read(p, p);
        merged.push(...one.transactions);
        firstMeta ??= one;
        lastMeta = one;
      }
      const alt = { ...(firstMeta ?? result), transactions: merged, closingBalance: lastMeta?.closingBalance };
      // keep whichever attempt is more consistent (fewer issues; more rows on ties)
      const score = (t: ExtractedBankTransaction[]) => {
        const rep = validateStatement(t, {}, direction === "unknown" ? undefined : direction);
        const join = joinsUp(rows[rows.length - 1], t[0], direction) ? 0 : 1;
        return rep.issues.length + join;
      };
      const sa = score(alt.transactions), so = score(result.transactions);
      if (sa < so || (sa === so && alt.transactions.length > result.transactions.length)) {
        chosen = alt.transactions;
        chosenMeta = alt as typeof result;
      }
    }

    if (direction === "unknown") {
      const v = validateStatement(chosen);
      if (v.direction !== "unknown") direction = v.direction;
    }
    if (from === 0) opening = chosenMeta.openingBalance;
    closing = chosenMeta.closingBalance ?? closing;
    if (pages.length <= size) singleChunkTotals = { d: chosenMeta.totalDebits, c: chosenMeta.totalCredits };
    rows.push(...chosen);
    log(`chunk pages ${from + 1}-${to + 1}: ${chosen.length} rows`);
  }

  const declared: DeclaredTotals = {
    openingBalance: opening,
    closingBalance: closing,
    totalDebits: singleChunkTotals.d,
    totalCredits: singleChunkTotals.c,
  };
  // Opening/closing only make sense when both were read.
  if (declared.openingBalance == null || declared.closingBalance == null) {
    declared.openingBalance = undefined;
    declared.closingBalance = undefined;
  }
  const report = validateStatement(rows, declared);
  return { transactions: rows, declared, report, chunks, retried };
}
