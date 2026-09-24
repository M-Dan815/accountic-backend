import seed from "@/data/coa_seed.json";

/** Typed view over coa_seed.json (the standard tree + system rules + merchants + questions). */
export type SeedAccount = {
  code: string; parent_code: string | null; level: number; name_ar: string; name_en: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense"; nature: "debit" | "credit";
  statement: "balance_sheet" | "income_statement"; fs_line_ar: string | null; fs_line_en: string | null;
  cf_class: string | null; postable: boolean; std_key: string | null; is_contra: boolean;
  system_locked: boolean; vat_default: string | null; keywords_ar: string[]; keywords_en: string[]; active: boolean;
};
export type SeedRule = {
  rule_id: string; match_type: string; patterns: string[]; direction: "debit" | "credit" | "any";
  code: string | null; confidence: number | null; needs_question: boolean; note_ar?: string;
  regex?: string; resolve_via?: string; question_id?: string;
};
export type SeedMerchant = {
  patterns: string[]; match: string; merchant_ar: string; category_ar: string; code: string;
  confidence: number; needs_confirm: boolean; note_ar?: string;
};
export type SeedOption = {
  label: string; code?: string; code_by_activity?: Record<string, string>; choose_from?: string[];
  next_question?: string; split?: unknown; pick_account?: Record<string, unknown>;
};
export type SeedQuestion = { question_id: string; case_ar: string; text_ar: string; options: SeedOption[] };

const S = seed as unknown as {
  version: string; accounts: SeedAccount[]; system_accounts: Record<string, string>;
  system_rules: SeedRule[]; merchant_directory: SeedMerchant[]; questions: SeedQuestion[];
  universal_options: SeedOption[]; thresholds: { auto: number; auto_with_review: number; materiality_default_sar: number };
};

export const STANDARD = S;
export const SYS = S.system_accounts as {
  suspense: string; internal_transfers: string; reconciliation_differences: string; opening_unallocated: string;
  current_year_profit: string; retained_earnings: string; vat_input: string; vat_output: string; bank_charges: string;
};
export const THRESHOLDS = S.thresholds;

const TYPE = { asset: "ASSET", liability: "LIABILITY", equity: "EQUITY", revenue: "REVENUE", expense: "EXPENSE" } as const;
export const toDbType = (t: SeedAccount["type"]) => TYPE[t];

/** Standard code → account, for translating seed rules/merchants/questions into any file's chart. */
export const STD_BY_CODE = new Map(S.accounts.map((a) => [a.code, a]));

/** Client activity → revenue account (question option `code_by_activity`). */
export function codeForActivity(map: Record<string, string>, activity: string): string {
  return map[activity] ?? map.default;
}
