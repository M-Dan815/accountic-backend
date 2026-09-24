import type { Cell } from "./grid";

export type Role =
  | "code" | "name" | "code_name"
  | "opening_debit" | "opening_credit" | "opening_balance"
  | "movement_debit" | "movement_credit"
  | "net_debit" | "net_credit"
  | "closing_debit" | "closing_credit" | "closing_balance"
  | "debit" | "credit" | "balance"
  | "type" | "parent" | "ignore";

/** What the "تحديد الأعمدة" screen produces and what "احفظ هذا القالب" stores. */
export type ColumnTemplate = {
  sheet?: string;
  /** 0-based row indexes that make up the header (informational for the UI). */
  headerRows?: number[];
  /** 0-based index of the first data row. */
  dataStartRow: number;
  /** role per 0-based column index; missing = ignore */
  roles: Record<string, Role>;
};

export type ParsedAccount = {
  code: string | null;
  name: string;
  /** debit − credit, on the chosen basis */
  balance: number;
  debit: number;
  credit: number;
  /** 1-based row number in the sheet (for traceability back to the file) */
  sourceRow: number;
};

export type ReadResult = {
  status: "OK" | "NEEDS_MAPPING";
  /** Arabic, user-facing. Present when status = NEEDS_MAPPING, or as a hint. */
  message?: string;
  sheet: string;
  headerRows: number[];
  dataStartRow: number;
  columns: { index: number; label: string; role: Role }[];
  accounts: ParsedAccount[];
  structure: { code: string; name: string }[];
  basis: "closing" | "opening+movement" | "signed-balance" | "debit-credit" | "none";
  totals: {
    rows: number;
    debit: number;
    credit: number;
    difference: number;
    balanced: boolean;
    /** null when the file has no grand-total row to compare with */
    matchesFileTotal: boolean | null;
  };
  warnings: string[];
  titleLines: string[];
  period?: { from?: string; to?: string; year?: number };
  /** first 30 rows exactly as in the file — for the manual screen */
  preview: Cell[][];
  usedTemplate: boolean;
};
