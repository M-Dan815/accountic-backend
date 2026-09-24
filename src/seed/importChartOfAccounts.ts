import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { AccountType } from "@prisma/client";

/**
 * Parses the firm's real Qoyod chart-of-accounts export. The export's own
 * "النوع" column is a free-text label, not a fixed enum, so account type is
 * derived from the standard Saudi/GCC leading-digit convention this firm's
 * own numbering already follows (1=Asset, 2=Liability, 3=Equity, 4=Revenue,
 * 5=Expense).
 *
 * `requiresSupportingDoc` is set true for accounts where a supporting
 * document (invoice/receipt/contract) is genuinely expected before the
 * classification can be trusted — receivables, capital, loans. Bank fees,
 * fuel, government fees, telecom subscriptions, etc. do not require one,
 * and marking them would flood a statement-only case with false
 * MISSING_SUPPORTING_DOC exceptions. See processing.service.ts.
 */

export type ParsedAccount = {
  code: string;
  name: string;
  nameAr: string;
  type: AccountType;
  parentCode: string | null;
  postable: boolean;
  requiresSupportingDoc: boolean;
};

const TYPE_BY_LEADING_DIGIT: Record<string, AccountType> = {
  "1": "ASSET",
  "2": "LIABILITY",
  "3": "EQUITY",
  "4": "REVENUE",
  "5": "EXPENSE",
};

/**
 * Prefixes of accounts that should be flagged as needing a supporting
 * document. Kept here (rather than hard-coded in the pipeline) so a firm
 * can adjust the list by editing this file once and re-seeding.
 */
const REQUIRES_SUPPORTING_DOC_PREFIXES = [
  "1103", // المدينون (receivables) — customer collections need a receipt
  "3101", // رأس المال (capital)
  "2201", // قرض بنك الرياض (loans)
  "2202",
  "2203",
  "2204",
];

function requiresSupportingDoc(code: string): boolean {
  return REQUIRES_SUPPORTING_DOC_PREFIXES.some((p) => code.startsWith(p));
}

export function parseChartOfAccountsWorkbook(buffer: Buffer): ParsedAccount[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
  });

  // Row 0: title, row 1: blank, row 2: header — data starts at row 3 (index 3).
  const dataRows = rows
    .slice(3)
    .filter((r) => r[0] !== "" && r[0] !== undefined && r[0] !== null);

  // ── Pre-compute the set of codes that have children ──────────────────────
  // A code "1103" has children iff there's another code that starts with
  // "1103" and is longer (e.g. "110301"). Parent/section accounts (like
  // "11 - أصول متداولة" or "1 - الأصول") should NOT be postable — you
  // don't post journal entries directly to a section header. Leaf accounts
  // (no children) should be postable.
  //
  // Why we can't just trust the XLSX's "قابل للحجز" / postable column:
  // the firm's real Qoyod export marks many leaf accounts (1103
  // receivables, 5102 salaries, 5213 bank fees, 5214 other expenses, …)
  // as "No" — even though they ARE leaf accounts that should accept direct
  // postings. Trusting that column literally made those accounts invisible
  // to the classifier (the heuristic's role-account lookup returned
  // undefined for RECEIVABLES/SALARIES/BANK_FEE/etc., and the AI candidate
  // list didn't include them either). The AI ended up classifying a bank
  // fee as "government fees" because 5213 wasn't in its candidate list —
  // 520802 was the closest expense account it could see. Bug #5.
  const allCodes = dataRows.map((r) => String(r[0]).trim());
  const hasChild = (code: string) =>
    allCodes.some((c) => c !== code && c.length > code.length && c.startsWith(code));
  const isLeafAccount = (code: string) => !hasChild(code);

  return dataRows.map((r) => {
    const code = String(r[0]).trim();
    const name = String(r[1] ?? "").trim();
    const parentRaw = String(r[4] ?? "").trim();
    const parentCode = parentRaw ? parentRaw.split(" - ")[0].trim() : null;

    // Postable rules:
    //   • Parent/section accounts (have children) → NEVER postable, even if
    //     the XLSX says "Yes" (which would be a data error in the export).
    //   • Leaf accounts → ALWAYS postable, even if the XLSX says "No"
    //     (the firm's export marks leaf accounts inconsistently).
    // The XLSX's "قابل للحجز" column is no longer the source of truth; the
    // parent/leaf structure is. This matches how Saudi/GCC CoAs actually
    // work: you post to the leaf, never to the section header.
    const postable = isLeafAccount(code);

    return {
      code,
      name,
      nameAr: name,
      type: TYPE_BY_LEADING_DIGIT[code[0]] ?? "ASSET",
      parentCode: parentCode || null,
      postable,
      requiresSupportingDoc: requiresSupportingDoc(code),
    };
  });
}

export function loadDefaultChartOfAccountsFixture(): ParsedAccount[] {
  const fixturePath = path.join(
    __dirname,
    "fixtures",
    "chart-of-accounts.xlsx",
  );
  const buffer = fs.readFileSync(fixturePath);
  return parseChartOfAccountsWorkbook(buffer);
}
