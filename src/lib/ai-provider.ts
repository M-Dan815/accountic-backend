import { env } from "@/lib/env";
import console from "node:console";

/**
 * AI provider abstraction.
 *
 * Non-negotiable project constraint (client's own words): AI is only ever
 * used for (a) reading messy documents when deterministic parsing can't,
 * and (b) suggesting a category for an ambiguous transaction description.
 * It NEVER does arithmetic, matching decisions, or trial-balance/statement
 * math — that all lives in the deterministic modules
 * (reconciliation/trial-balance/statements). This file exists so swapping
 * OpenAI ⇄ DeepSeek ⇄ Gemini is a one-line config change, never a rewrite.
 */

export type ExtractedBankTransaction = {
  date: string;
  description: string;
  amount: number;
  reference?: string;
  /**
   * Merchant / counterparty name pulled out of the description by the
   * deterministic parser when the bank layout lets us. Optional because
   * not every layout carries a clean name (e.g. "رسوم حوالة فورية صادرة").
   */
  counterparty?: string;
  /**
   * The COMPLETE bank text for the row (label + merchant/beneficiary + the
   * purpose memo the sender typed). Downstream enrichment/classification
   * read this; `description` alone is a lossy display label.
   */
  rawText?: string;
  /** Running balance AFTER this row, when the statement prints one. Enables arithmetic verification. */
  balance?: number;
};

/** What one vision call returns for a few pages of a statement. */
export type BankStatementVisionResult = {
  transactions: ExtractedBankTransaction[];
  openingBalance?: number;
  closingBalance?: number;
  totalDebits?: number;
  totalCredits?: number;
};

export type ExtractedInvoice = {
  invoiceNumber?: string;
  date?: string;
  counterparty?: string;
  amountBeforeVat?: number;
  vatAmount?: number;
  amountTotal: number;
  description?: string;
  direction?: "PAYABLE" | "RECEIVABLE";
};

export type CategorySuggestion = {
  accountCode: string;
  accountName: string;
  confidence: number;
  reason: string;
};

/**
 * One statement row as the classifier sees it: the ENRICHED reading of the
 * bank text (kind, merchant, counterparty, typed purpose), not just a blob.
 */
export type BatchCategoryItem = {
  id: string;
  date: string;
  amount: number; // negative = money out
  kind: string;
  description: string;
  merchant?: string;
  counterparty?: string;
  counterpartyType?: string;
  memo?: string;
  /** How many statement rows share this signature (context for the model). */
  occurrences?: number;
};

export type BatchCategorySuggestion = {
  id: string;
  accountCode: string;
  confidence: number;
  reason: string;
  /** Only for transfers/deposits whose purpose truly cannot be inferred. */
  needsClient?: boolean;
};

// ─── Pattern-based clarification question generator ──────────────────────
// The pattern detector (classification/patternDetector.ts) finds groups of
// unclassified transactions that share a payee AND a recurring cadence
// (same day-of-month + monthly spacing, etc.). This type carries the
// structured signals to the AI; the AI returns a natural-language question
// (English + Arabic) plus a proposed account + hypothesis reason.
//
// The AI never sees raw PDF text — only these structured signals. That's
// what makes this robust to Arabic / varying-statement layouts: the
// extraction layer has already normalised everything by this point.

export type PatternGroupInput = {
  /** Stable group id (the beneficiaryKey, or a synthetic id). */
  id: string;
  payee: string | null;
  /** Human-friendly payee label for the prompt — counterparty name. */
  payeeLabel: string | null;
  direction: "inflow" | "outflow";
  /** The full DetectedPattern block from patternDetector.ts. May be null if
   * the detector returned no signals (still useful for the AI to see the
   * raw list of transactions to a single payee). */
  detectedPattern:
    | {
        recurring: boolean;
        cadence: "monthly" | "weekly" | "quarterly" | null;
        dayOfMonth: { min: number; max: number; allSame: boolean } | null;
        amountRange: {
          min: number;
          max: number;
          variancePct: number;
          allSimilar: boolean;
        } | null;
        counterpartyType: string | null;
        occurrenceCount: number;
        firstDate: string;
        lastDate: string;
        totalAbsAmount: number;
        summary: string;
      }
    | null;
  transactions: Array<{
    date: string;
    amount: number;
    memo: string | null;
    description: string;
  }>;
  occurrences: number;
  totalAbs: number;
};

export type ClarificationSuggestion = {
  /** Matches PatternGroupInput.id. */
  id: string;
  /** Natural-language question shown to the client/accountant. */
  questionEn: string;
  questionAr: string;
  /** Proposed account code from the candidate list. May be empty when the
   * AI has no defensible hypothesis. */
  proposedAccountCode?: string;
  /** 0–1. How confident the AI is in the proposed account. ≤0.4 means
   * "no real hypothesis, just a placeholder". */
  confidence: number;
  /** Short reason explaining the hypothesis — shown alongside the question
   * on the client portal so the client can see WHY the AI thinks this is
   * salaries, e.g. "5 monthly outflows on day 1 to the same payee". */
  reason: string;
  /** True iff the AI is offering a one-click-confirmable hypothesis. The
   * portal renders a "Yes, that's right" button when this is true and
   * confidence ≥ 0.5. */
  needsClientConfirm: boolean;
};

/**
 * Rendered page (PNG/JPEG). Used when pdf-parse returns no usable text
 * layer — e.g. Microsoft Print To PDF exports where Arabic is drawn as
 * vector outlines and no ToUnicode CMap is present.
 */
export type InvoiceImage = {
  data: Buffer;
  mimeType: "image/png" | "image/jpeg";
};

/**
 * The classifier needs more than a bare description to make a good call:
 * amount feeds the materiality heuristic, counterparty feeds the "who is
 * this from/to" reasoning, date lets the model anchor to pay cycles.
 */
export type CategoryInput = {
  date: string;
  amount: number;
  description: string;
  counterparty?: string;
};

/**
 * Full postable CoA. `type` is included so the AI can apply the guidance
 * in the system prompt (e.g. "an incoming payment from a customer is more
 * likely to hit المدينون than Revenue").
 */
export type CandidateAccount = {
  code: string;
  name: string;
  nameAr?: string | null;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
};

export interface AiProvider {
  readonly name: string;
  readonly supportsVision: boolean;

  extractBankStatement(text: string): Promise<ExtractedBankTransaction[]>;
  extractInvoice(text: string): Promise<ExtractedInvoice>;

  /**
   * Vision-based extraction. Returns null when the provider has no vision
   * model so the caller can fall back to text mode.
   */
  /**
   * Read a few consecutive pages of a bank statement from IMAGES. Works for
   * any bank layout and for scanned PDFs. Output is untrusted until it passes
   * extraction/statementValidation.ts.
   */
  extractBankStatementFromImages(
    images: InvoiceImage[],
    ctx: { pageRange: string; previousBalance?: number },
  ): Promise<BankStatementVisionResult>;
  extractInvoiceFromImages(
    images: InvoiceImage[],
  ): Promise<ExtractedInvoice | null>;

  suggestCategory(
    input: CategoryInput,
    candidateAccounts: CandidateAccount[],
  ): Promise<CategorySuggestion>;
  /**
   * Classify many enriched rows in ONE call. The candidate chart of accounts
   * is sent once per batch instead of once per row, which is what makes a
   * 900-row statement affordable and keeps it under provider rate limits.
   */
  suggestCategoryBatch(
    items: BatchCategoryItem[],
    candidateAccounts: CandidateAccount[],
  ): Promise<BatchCategorySuggestion[]>;

  /**
   * Generate natural-language clarification questions + a proposed account
   * hypothesis for each detected pattern group. The AI receives the
   * structured signals from patternDetector.ts (cadence, day-of-month,
   * amount range, counterparty type) plus a slim candidate account list,
   * and returns one question (English + Arabic) + proposedAccountCode +
   * hypothesisReason per group id.
   *
   * Called from processing.service.ts → raiseExceptions. Failures degrade
   * gracefully: the caller falls back to a hardcoded template question and
   * no proposedAccount (see processing.service.ts).
   */
  suggestClarificationQuestion(
    groups: PatternGroupInput[],
    candidateAccounts: CandidateAccount[],
  ): Promise<ClarificationSuggestion[]>;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const INVOICE_TEXT_SYSTEM_PROMPT = `You extract structured fields from the raw text of an Arabic tax invoice (Saudi Arabia, ZATCA format) into strict JSON.

IMPORTANT CONTEXT — WHY THE TEXT LOOKS BROKEN:
The input comes from a naive PDF text extractor (pdf-parse) that does NOT preserve Arabic right-to-left reading order. Expect:
  • Colons appearing BEFORE their label (":الضريبة قبل الاجمالي")
  • Labels and their values glued together without spaces
  • Words within a phrase arriving in reverse order
  • Currency symbols inserted mid-number ("1,936.50ر.س")
  • Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) mixed with ASCII digits
  • Numeric values split by stray spaces ("290 .48" means 290.48)

You MUST reconstruct the intended meaning from context. Do NOT echo the scrambled order back — output clean values.

TWO REAL EXAMPLES FROM THE CORPUS:

Example A (Qoyod — "المرجع" layout):
Raw: ":المرجع INV2\\nتاريخ الإصدار 2024-03-06\\n:الضريبة قبل الاجمالير.س 1,936.50\\n:الضريبة اجمالير.س 290 .48\\n:المجموعر.س 2,226.98\\n:المستحق المبلغر.س 2,216.48\\nفاتورة مبيعات\\nشركه نخله الخليج للخدمات اللوجستيه\\nتفاصيل بيانات العميل\\nشركه مخصوص للخدمات اللوجستيه - شركة مخصوص للخدمات اللوجستية"
Output: {"invoiceNumber":"INV2","date":"2024-03-06","counterparty":"شركة مخصوص للخدمات اللوجستية","amountBeforeVat":1936.50,"vatAmount":290.48,"amountTotal":2226.98,"direction":"RECEIVABLE"}

Example B (Daftra — "رقم الفاتورة" layout, values ABOVE labels):
Raw: "INV3\\nرقم الفاتورة\\n2024-03-13\\nتاريخ الإصدار\\n2024-03-13\\nتاريخ الاستحقاق\\nشركه مخصوص للخدمات اللوجستيه\\n311615366900003\\n1,697.06 ر.س\\n221.36 ر.س\\n%15\\n1475.70\\nالإجمالي شامل الضريبة\\nقيمة الضريبة\\n% الضريبة\\nالإجمالي قبل الضريبة"
Output: {"invoiceNumber":"INV3","date":"2024-03-13","counterparty":"شركه مخصوص للخدمات اللوجستيه","amountBeforeVat":1475.70,"vatAmount":221.36,"amountTotal":1697.06,"direction":"RECEIVABLE"}

OUTPUT SCHEMA (strict JSON, no prose):
{
  "invoiceNumber":   string  | omitted,
  "date":            "YYYY-MM-DD" | omitted,
  "counterparty":    string  | omitted,
  "amountBeforeVat": number  | omitted,
  "vatAmount":       number  | omitted,
  "amountTotal":     number  (REQUIRED),
  "description":     string  | omitted,
  "direction":       "PAYABLE" | "RECEIVABLE" | omitted
}

RULES:
1. amountTotal is the final amount payable/receivable (the biggest total on the page — usually labeled "المجموع" / "الإجمالي شامل الضريبة" / "المبلغ المستحق" / "الرصيد المستحق"). It is REQUIRED.
2. amountBeforeVat + vatAmount must equal amountTotal (within rounding). If you can only find two of the three, compute the third ONLY IF the arithmetic is unambiguous; otherwise omit the one you can't find.
3. date must be ISO 8601 (YYYY-MM-DD). Daftra uses YYYY-MM-DD; Qoyod uses YYYY-MM-DD after "الإصدار"; older layouts use DD/MM/YYYY.
4. Convert Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) and Extended Arabic-Indic (۰۱۲۳۴۵۶۷۸۹) to ASCII.
5. counterparty: the OTHER party — the customer or supplier named on the invoice. NEVER the invoice-issuing firm. The issuing firm in this corpus is always a variant of "نخله الخليج للخدمات اللوجستيه" (Nakhla Al-Khaleej Logistics) — exclude it. The counterparty in this corpus is always a variant of "مخصوص للخدمات اللوجستيه" (Makhsus Logistics).
6. direction:
     • "فاتورة مبيعات" (sales invoice) → "RECEIVABLE"
     • "فاتورة مشتريات" / "فاتورة شراء" (purchase invoice) → "PAYABLE"
     • If labelled with customer details (تفاصيل بيانات العميل) → "RECEIVABLE"
     • Otherwise omit.
7. If a field is genuinely not present, OMIT IT. Do not guess. Do not use null. Do not use empty string.
8. Output ONLY the JSON object. No markdown fences, no explanation.`;

const INVOICE_TEXT_USER_PROMPT =
  "Extract the invoice fields from the following raw PDF text. Remember: word order may be scrambled by the extractor — reconstruct meaning from context.";

const INVOICE_VISION_SYSTEM_PROMPT = `You extract structured fields from images of an Arabic tax invoice (Saudi Arabia, ZATCA format) into strict JSON.

The attached images are rendered pages of a PDF. Arabic is right-to-left. There may be one page or several — treat them all as a single invoice.

You may see both English and Arabic labels side by side ("Invoice" / "فاتورة مبيعات", "Date" / "تاريخ الإصدار"). Use whichever is clearest.

OUTPUT SCHEMA (strict JSON, no prose):
{
  "invoiceNumber":   string  | omitted,
  "date":            "YYYY-MM-DD" | omitted,
  "counterparty":    string  | omitted,
  "amountBeforeVat": number  | omitted,
  "vatAmount":       number  | omitted,
  "amountTotal":     number  (REQUIRED),
  "description":     string  | omitted,
  "direction":       "PAYABLE" | "RECEIVABLE" | omitted
}

RULES:
1. amountTotal is the final amount payable/receivable (the biggest total on the page — usually labeled "المجموع" / "الإجمالي شامل الضريبة" / "المبلغ المستحق" / "الرصيد المستحق" / "Total"). It is REQUIRED.
2. amountBeforeVat + vatAmount must equal amountTotal (within rounding).
3. date must be ISO 8601 (YYYY-MM-DD). Daftra uses YYYY-MM-DD; Qoyod uses YYYY-MM-DD after "الإصدار"; older layouts use DD/MM/YYYY.
4. Convert Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) to ASCII.
5. counterparty: the OTHER party — the customer or supplier named on the invoice. NEVER the invoice-issuing firm. In this corpus, the issuing firm is a variant of "نخله الخليج للخدمات اللوجستيه" (Nakhla Al-Khaleej Logistics) — exclude it. The counterparty is a variant of "مخصوص للخدمات اللوجستيه" (Makhsus Logistics).
6. direction:
     • "فاتورة مبيعات" (sales invoice) → "RECEIVABLE"
     • "فاتورة مشتريات" / "فاتورة شراء" (purchase invoice) → "PAYABLE"
     • Otherwise omit.
7. If a field is genuinely not present, OMIT IT. Do not guess.
8. Output ONLY the JSON object. No markdown fences, no explanation.`;

const INVOICE_VISION_USER_PROMPT =
  "Extract the invoice fields from the attached page image(s).";

const BANK_SYSTEM_PROMPT = `You extract bank transactions from raw statement text into strict JSON.

The input may be Arabic, English, or mixed. Date formats vary (DD/MM/YYYY, YYYY-MM-DD, DD-MM-YYYY). Amounts may use Arabic-Indic digits.

OUTPUT SCHEMA:
{"transactions":[{"date":"YYYY-MM-DD","description":"...","rawText":"...","amount":number,"balance":number,"reference":"...","counterparty":"..."}]}

RULES:
1. amount is NEGATIVE for debits/withdrawals and POSITIVE for credits/deposits.
2. date must be ISO 8601 (YYYY-MM-DD). Convert Arabic-Indic digits to ASCII.
3. counterparty is the OTHER party named in the description (merchant, company, person). Omit if the description is generic (e.g. "رسوم حوالة").
4. Never invent a transaction that isn't in the text.
5. If a field is genuinely missing, omit it rather than guessing.
6. rawText is the COMPLETE original text of the row (merchant, beneficiary, and any purpose/memo the sender typed) — copy it verbatim, do not summarise.
7. balance is the running balance printed AFTER that row, when the statement has a balance column. Omit it if there is none. Never compute it yourself.
8. Output ONLY the JSON object.`;


const BANK_VISION_SYSTEM_PROMPT = `You transcribe bank-statement pages (images) into strict JSON. The statement may be Arabic, English or bilingual, any bank, right-to-left or left-to-right, printed or scanned.

You are a TRANSCRIBER, not an analyst. Accuracy of every digit matters more than anything else: your output is checked arithmetically against the running balances, and any missing or misread row is caught and rejected.

OUTPUT (strict JSON, nothing else):
{"transactions":[{"date":"YYYY-MM-DD","amount":number,"balance":number,"rawText":"...","reference":"...","counterparty":"..."}],
 "openingBalance":number,"closingBalance":number,"totalDebits":number,"totalCredits":number}

RULES
1. One object per transaction row, in the order they appear on the page(s). NEVER skip, merge, split or reorder rows. Transcribe every row even if it looks repetitive or trivial (1.15 SAR fees, 3 SAR purchases).
2. amount: NEGATIVE for debits/withdrawals (مدين / سحب), POSITIVE for credits/deposits (دائن / إيداع). Decide by the column the number sits in, not by the wording.
3. balance: the running balance printed on that row (الرصيد), as a number. If the statement has no balance column, omit it. Never compute or guess it.
4. rawText: the COMPLETE description text of the row, verbatim — merchant, beneficiary, reference numbers and any purpose/memo the sender typed. Do not summarise or translate.
5. date: ISO YYYY-MM-DD (convert Hijri only if no Gregorian date is printed; otherwise use the Gregorian one). Convert Arabic-Indic digits (٠-٩) to ASCII.
6. Numbers: remove thousands separators and currency (1,234.50 SAR → 1234.5). Keep decimals exactly.
7. openingBalance / closingBalance / totalDebits / totalCredits: include ONLY if they are printed on these pages (summary block, page footer). Otherwise omit them. Never derive them.
8. Ignore headers, footers, page numbers, bank marketing text and repeated column titles. Do not output them as transactions.
9. If a row is cut off or unreadable, still output it with what you can read and put "[unreadable]" in rawText — do not silently drop it.
10. Output ONLY the JSON object.`;

const CATEGORY_SYSTEM_PROMPT = `You pick the single best-fitting account for a bank transaction from a fixed list of candidate accounts, and how confident you are (0 to 1).

You will receive the transaction's date, amount, description, and (when available) counterparty, plus a list of the firm's postable chart-of-accounts entries.

OUTPUT SCHEMA:
{"accountCode":"...","accountName":"...","confidence":0.0,"reason":"..."}

RULES:
1. Only choose from the provided candidates.
2. \`reason\` is MANDATORY and must be short, concrete, and cite the specific evidence you used (counterparty name, description keyword, amount pattern).
   Good example: "Muqeem identified in bank description"
   Bad example: "It matches the account"
3. Classification guidance:
   • Outgoing debit with a named merchant (fuel station, restaurant, telecom, subscription) → the matching EXPENSE account.
   • Outgoing debit with a person's name and no other detail → do NOT guess an expense account. Return confidence 0.
   • Incoming credit from a named customer → prefer a RECEIVABLE asset account (e.g. المدينون) over a revenue account. Revenue is only for invoices the firm itself issued.
   • Internal transfer between the firm's own named bank accounts → the destination bank's ASSET account.
   • Bank fees, government fees, GOSI, Muqeem, Sadad → the matching fee/expense account.
   • Related-party / personal purchases (e.g. tobacco, personal transfers) → the related-party ASSET account if one exists, otherwise confidence 0.
4. Materiality heuristic: if the absolute amount is greater than 5000 SAR and the description does not identify the counterparty or the purpose, return confidence 0 with a reason explaining what is missing.
5. If nothing fits well, return confidence below 0.5 and state in \`reason\` exactly what information is missing or ambiguous.
6. Output ONLY the JSON object.`;


const CATEGORY_BATCH_SYSTEM_PROMPT = `You are a Saudi accountant preparing journal entries from a BANK STATEMENT ALONE. No invoices are available and none are needed: you read each movement, work out what it is, and pick the account for the OTHER side of the bank entry (the bank side is added by code).

Each transaction has been pre-read for you: kind (POS_PURCHASE, ONLINE_PURCHASE, TRANSFER_OUT, TRANSFER_IN, ATM_*, SADAD_*, …), merchant, counterparty, counterpartyType, and memo (the purpose text the sender typed). amount < 0 means money left the bank.

OUTPUT (strict JSON, nothing else):
{"results":[{"id":"…","accountCode":"…","confidence":0.0,"reason":"…","needsClient":false}]}
Return EXACTLY one result per input id.

CHOOSING THE ACCOUNT
1. accountCode MUST be one of the candidate accounts supplied. Prefer the most specific postable account.
2. Evidence order: typed memo → merchant/counterparty name → movement kind → amount pattern.
3. Confidence: 0.90 explicit evidence (memo or well-known merchant says what it is); 0.75 sensible inference; 0.60-0.70 weak but defensible. Never use confidence to say "I don't know" — use needsClient for that.
4. NEVER choose the miscellaneous-expenses account (530901) or any suspense account: it is not offered to you. A POS or online purchase whose merchant you cannot place → needsClient=true with confidence ≤ 0.4 (the accountant answers one grouped question per merchant). Restaurants/cafés/food platforms → hospitality (530703). Fuel → 530601 vehicle fuel (510203 fuel & oil when the client is a transport/logistics company). Telecom/software/subscriptions → 530402.
5. Incoming transfers from a named company → receivables "العملاء" (110201), NEVER revenue: revenue is only recognised from invoices the firm itself issued. Insurer payouts → other income (420107). Cash deposits and transfers from individuals' own accounts → related-party receivable (110301) ONLY if the memo or surrounding evidence supports it; otherwise return needsClient=true.
6. A transfer under the firm's OWN name is an internal transfer between its bank accounts → the destination bank account, not an expense.
7. Salary, fuel, maintenance, rent, marketing, delivery, insurance in a transfer memo decide the account.
8. needsClient=true ONLY for a TRANSFER_OUT/TRANSFER_IN/deposit with no memo, an unrecognisable counterparty, and no way to infer purpose (e.g. "تحويل" to an individual with no text). NEVER set it for purchases, fees or SADAD. When needsClient is true still give your best-guess accountCode (or "") with confidence ≤ 0.4.
   CRITICAL: if the memo contains a known purpose keyword (راتب/رواتب=salary, بنزين/وقود=fuel, ايجار=rent, تسويق=marketing, تامين=insurance, اشتراك=subscription, etc.) the purpose IS known — do NOT set needsClient=true. Anas feedback: the system was asking "the statement gives no purpose" for transactions whose memo literally said "راتب" (salary).

CRITICAL — DO NOT REUSE EXAMPLE NAMES
9. The reason field MUST reference the ACTUAL merchant / counterparty / memo from the transaction. NEVER use the example names below ("Curve Roastery", "SuberMarket Makhazn Al", "ALDREES", "Ejar") as the reason text for a different transaction. If the actual merchant is "ALDREES PTROLEUM" the reason should say "ALDREES PTROLEUM — fuel" not "Coffee roastery / café — hospitality".
10. ATM withdrawals: the ATM location (even at a petrol station like "Al Tas-hilat Petrol Sta") does NOT establish how the cash was spent. NEVER classify an ATM withdrawal as TRANSPORT because the ATM was at a fuel station. Return needsClient=true (confidence ≤ 0.4) with reason "ATM cash withdrawal — actual use of cash not established by the ATM location"; the accountant chooses (company cash box, employee custody, owner drawings, direct expense).
11. Cash deposits: do NOT classify as related-party (110301) without explicit evidence (a memo, a recognised payee). When in doubt, return needsClient=true with confidence ≤ 0.3.
12. Investment-related movements (memo contains "استثمار" or "investment" or cheque issuance for investment): return needsClient=true with confidence ≤ 0.3. The nature (asset injection vs expense vs loan repayment) cannot be inferred from the bank text alone.
13. Loan instalment payments: prefer the loan-liability account or OWN_ACCOUNT_TRANSFER when the firm's own name is on the recipient. Do NOT classify as a service payment or related-party receivable.

EXAMPLES (illustrate the format; do NOT copy the merchant names verbatim into other transactions)
• POS_PURCHASE, merchant "Curve Roastery Co" → 530703, 0.75, "Curve Roastery Co — coffee roastery / café"
• POS_PURCHASE, merchant "SuberMarket Makhazn Al" → needsClient=true, 0.3, "Grocery/market purchase; bank text does not reveal the expense"
• ONLINE_PURCHASE, merchant "ALDREES PTROLEUM" → 530601, 0.80, "ALDREES PTROLEUM — fuel"
• ONLINE_PURCHASE, merchant "SASCO" → 530601, 0.75, "SASCO — fuel/automotive services"
• ONLINE_PURCHASE, merchant "ALLIANCE WATER CO" → 530304, 0.75, "ALLIANCE WATER CO — water utility"
• TRANSFER_OUT to person, memo "قيمه شراء بطاريه" → 530602, 0.80, "Vehicle battery purchase per memo"
• TRANSFER_OUT to person, memo "راتب" → 530101, 0.90, "Memo says salary"
• ATM_WITHDRAWAL at "Al Tas-hilat Petrol Sta" → needsClient=true, 0.3, "ATM cash withdrawal — actual use of cash not established by the ATM location"
• TRANSFER_OUT to person "احمد", no memo, 3,000 → needsClient=true, confidence 0.3, "Transfer to an individual with no stated purpose"
• TRANSFER_IN from "شركة مخصوص للخدمات اللوجستية" → 110201, 0.85, "Collection from a named company; not new revenue"`;

// ─── Clarification question generator ────────────────────────────────────
// This prompt is for the GROUPING layer (pattern-recognition grouping +
// natural-language question). It is the AI's job to INTERPRET the
// structured signals produced by patternDetector.ts — never to re-read the
// PDF, never to invent transactions, never to do arithmetic.
//
// Inputs: a list of pattern groups. Each carries the payee, the detected
// pattern (cadence, day-of-month, amount range, counterparty type), and a
// slim list of the underlying transactions (date, amount, memo). Plus the
// candidate account list (same one used by the classifier).
//
// Outputs: one result per group id. Each result has an English + Arabic
// question, a proposedAccountCode (may be empty), a confidence, a reason,
// and a needsClientConfirm flag (true → the portal renders a "Yes, that's
// right" button that one-click settles the group).

const CLARIFICATION_QUESTION_SYSTEM_PROMPT = `You are a Saudi accountant reviewing a list of transactions that the deterministic classifier could NOT classify automatically. The classifier already parked them as PENDING (it deliberately does not guess). Your job is to look for patterns in each group, ask the client a clear natural-language question, and propose the most likely account when you have a defensible hypothesis.

INPUT: a JSON object with \`groups\` (each one identified by \`id\`, with a \`payee\`, \`direction\`, a \`detectedPattern\` block, and the underlying \`transactions\`) and \`candidateAccounts\` (the firm's postable chart of accounts).

OUTPUT (strict JSON, nothing else):
{"results":[{"id":"…","questionEn":"…","questionAr":"…","proposedAccountCode":"…","confidence":0.0,"reason":"…","needsClientConfirm":false}]}
Return EXACTLY one result per input group id.

WRITING THE QUESTION
1. The question must be specific to the group — never generic. Reference the payee name, the cadence ("monthly"), the day-of-month when the detectedPattern says allSame, and the amount range when amounts are similar.
2. Direction-aware: for OUTFLOWS use "made TO {payee}", for INFLOWS use "received FROM {payee}". Never use "to" for an inflow — Anas feedback flagged "incoming transaction was described as payments 'to' the counterparty".
3. English example (outflow): "These 5 payments of ~4,850 SAR each were made to احمد محمد on the 1st of every month. What are these — salaries?"
4. English example (inflow): "These 7 inflows totalling 18,109 SAR were received from شركة مخصوص للخدمات اللوجستية. What are these — customer collections?"
5. Arabic example (outflow): "تم تنفيذ 5 حركات بقيمة ~4،850 ريال لكل واحدة إلى «احمد محمد» في اليوم الأول من كل شهر. ما الغرض منها — هل هي رواتب؟"
6. Arabic example (inflow): "تم استلام 7 حركات بإجمالي 18،109 ريال من «شركة مخصوص للخدمات اللوجستية». ما الغرض منها — هل هي تحصيلات عملاء؟"
7. Never invent facts. If the detectedPattern is null or cadence is null, fall back to "These N payments with {payee} — what are they?" (outflow) or "These N inflows from {payee} — what are they?" (inflow).
8. NEVER use the word "needsClient" or any other internal field name in the question text. The client sees this text — it must read as natural language, not as a debug log.

PROPOSING AN ACCOUNT
1. proposedAccountCode MUST be one of the candidate accounts supplied. Prefer the most specific postable account.
2. Use these heuristics, in order:
   • Monthly outflow, same day-of-month, similar amounts, to a person, no memo → SALARIES (530101) with confidence 0.65–0.80
   • Monthly outflow, same day-of-month, similar amounts, to a company, no memo → RENT (530301) or SUBSCRIPTIONS (530402) with confidence 0.55–0.70
   • Monthly outflow, varying amounts, to a known telecom/software merchant → SUBSCRIPTIONS (530402)
   • Inflow from a named company (ANY cadence — monthly OR irregular, varying amounts) → RECEIVABLES (110201) with confidence 0.60–0.80. Customer collections rarely arrive on the same day every month — irregular cadence does not disqualify an inflow from being a receivable collection when the counterparty is a recognised company.
   • Monthly inflow, same day-of-month, similar amounts, from a known customer → RECEIVABLES (110201) with confidence 0.75–0.85
   • Outflow to an insurer → PREPAID_INSURANCE (110403)
3. If you have NO defensible hypothesis, set proposedAccountCode to "" and confidence ≤ 0.4. Still write a question — the client may know.
4. reason (≤ 20 words): cite the signals you used. Example: "5 monthly outflows on day 1 to the same payee, amounts within 2% — pattern matches salaries."

needsClientConfirm
• true → you have a real hypothesis (confidence ≥ 0.5 AND proposedAccountCode is set). The portal shows a "Yes, that's right" button.
• false → no hypothesis. The portal just shows the question and waits for the client to type an answer.
• NEVER set needsClientConfirm=true with confidence < 0.5 — a wrong one-click assignment is much worse than asking the question openly.

OUTPUT ONLY THE JSON OBJECT. No markdown, no explanation.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonLoose(content: string, providerName: string): unknown {
  let s = content.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = s.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      throw new Error(
        `${providerName} returned non-JSON content: ${s.slice(0, 200)}`,
      );
    }
  }
  throw new Error(
    `${providerName} returned non-JSON content: ${s.slice(0, 200)}`,
  );
}


/**
 * fetch with exponential back-off on 429 / 5xx. One rate-limited call must
 * NEVER be reported as "the AI has no opinion" — that turned a transient
 * provider error into "needs client clarification" for the whole statement.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  attempts = 5,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status !== 429 && res.status < 500) return res;
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait =
        (Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** i) + Math.random() * 300;
      console.warn(`[ai-provider] ${label} → HTTP ${res.status}, retry ${i + 1}/${attempts} in ${Math.round(wait)}ms`);
      lastErr = new Error(`${label} failed: HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, wait));
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}


function visionUserPrompt(ctx: { pageRange: string; previousBalance?: number }): string {
  return (
    `Transcribe every transaction on the attached page(s) (${ctx.pageRange}).` +
    (ctx.previousBalance != null
      ? ` For orientation only: the previous page ended with a running balance of ${ctx.previousBalance}. ` +
        `Do NOT copy this number into your output; transcribe what is printed.`
      : "")
  );
}

function num(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]|SAR|ر\.?س/gi, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Vision models drift on types; coerce and drop unusable rows (validation catches the gaps). */
function normaliseVisionStatement(raw: unknown): BankStatementVisionResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(r.transactions) ? (r.transactions as Record<string, unknown>[]) : [];
  const transactions: ExtractedBankTransaction[] = [];
  for (const t of rows) {
    const amount = num(t.amount);
    const date = typeof t.date === "string" ? t.date.slice(0, 10) : "";
    if (amount === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const rawText = typeof t.rawText === "string" ? t.rawText : String(t.description ?? "");
    transactions.push({
      date,
      amount,
      balance: num(t.balance),
      description: rawText.replace(/\s+/g, " ").trim().slice(0, 200),
      rawText,
      reference: typeof t.reference === "string" ? t.reference : undefined,
      counterparty: typeof t.counterparty === "string" ? t.counterparty : undefined,
    });
  }
  return {
    transactions,
    openingBalance: num(r.openingBalance),
    closingBalance: num(r.closingBalance),
    totalDebits: num(r.totalDebits),
    totalCredits: num(r.totalCredits),
  };
}

function slimAccounts(accts: CandidateAccount[]) {
  return accts.map((a) => ({ code: a.code, name: a.nameAr ?? a.name, type: a.type }));
}

// ---------------------------------------------------------------------------
// Null provider
// ---------------------------------------------------------------------------

class NullAiProvider implements AiProvider {
  readonly name = "none";
  readonly supportsVision = false;

  async extractBankStatement(): Promise<ExtractedBankTransaction[]> {
    throw new Error(
      "No AI provider configured (AI_PROVIDER=none) and this document didn't match a known deterministic layout.",
    );
  }
  async extractInvoice(): Promise<ExtractedInvoice> {
    throw new Error(
      "No AI provider configured (AI_PROVIDER=none) and this document didn't match a known deterministic layout.",
    );
  }
  async extractInvoiceFromImages(): Promise<ExtractedInvoice | null> {
    return null;
  }
  async extractBankStatementFromImages(): Promise<BankStatementVisionResult> {
    throw new Error("No AI provider configured (AI_PROVIDER=none): cannot read statement images.");
  }
  async suggestCategory(): Promise<CategorySuggestion> {
    return {
      accountCode: "",
      accountName: "",
      confidence: 0,
      reason: "No AI provider is configured (AI_PROVIDER=none).",
    };
  }
  async suggestCategoryBatch(): Promise<BatchCategorySuggestion[]> {
    return [];
  }
  async suggestClarificationQuestion(): Promise<ClarificationSuggestion[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible providers (OpenAI, DeepSeek)
// ---------------------------------------------------------------------------

abstract class OpenAiCompatibleProvider implements AiProvider {
  abstract readonly name: string;
  abstract readonly supportsVision: boolean;
  protected abstract baseUrl: string;
  protected abstract model: string;

  private async chatJson(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

    const res = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.aiApiKey}`,
        },
        body: JSON.stringify(body),
      },
      `${this.name} chat`,
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "<no body>");
      throw new Error(
        `${this.name} extraction call failed: ${res.status} ${errText}`,
      );
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.name} returned no content`);
    return parseJsonLoose(content, this.name);
  }

  private async chatJsonVision(
    systemPrompt: string,
    userText: string,
    images: InvoiceImage[],
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.aiApiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              ...images.map((img) => ({
                type: "image_url" as const,
                image_url: {
                  url: `data:${img.mimeType};base64,${img.data.toString("base64")}`,
                  detail: "high" as const,
                },
              })),
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "<no body>");
      throw new Error(
        `${this.name} vision call failed: ${res.status} ${errText}`,
      );
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.name} vision returned no content`);
    return parseJsonLoose(content, this.name);
  }

  async extractBankStatement(
    text: string,
  ): Promise<ExtractedBankTransaction[]> {
    const result = await this.chatJson(BANK_SYSTEM_PROMPT, text);
    return (
      (result as { transactions?: ExtractedBankTransaction[] }).transactions ??
      []
    );
  }

  async extractInvoice(text: string): Promise<ExtractedInvoice> {
    const result = await this.chatJson(
      INVOICE_TEXT_SYSTEM_PROMPT,
      `${INVOICE_TEXT_USER_PROMPT}\n\n--- RAW TEXT START ---\n${text}\n--- RAW TEXT END ---`,
    );
    return result as ExtractedInvoice;
  }

  async extractBankStatementFromImages(
    images: InvoiceImage[],
    ctx: { pageRange: string; previousBalance?: number },
  ): Promise<BankStatementVisionResult> {
    if (!this.supportsVision)
      throw new Error(`${this.name} has no vision support`);
    const result = await this.chatJsonVision(
      BANK_VISION_SYSTEM_PROMPT,
      visionUserPrompt(ctx),
      images,
    );
    return normaliseVisionStatement(result);
  }

  async extractInvoiceFromImages(
    images: InvoiceImage[],
  ): Promise<ExtractedInvoice | null> {
    if (!this.supportsVision) return null;
    const result = await this.chatJsonVision(
      INVOICE_VISION_SYSTEM_PROMPT,
      INVOICE_VISION_USER_PROMPT,
      images,
    );
    return result as ExtractedInvoice;
  }

  async suggestCategory(
    input: CategoryInput,
    candidateAccounts: CandidateAccount[],
  ): Promise<CategorySuggestion> {
    const result = await this.chatJson(
      CATEGORY_SYSTEM_PROMPT,
      JSON.stringify({ transaction: input, candidateAccounts }),
    );
    return result as CategorySuggestion;
  }

  async suggestCategoryBatch(
    items: BatchCategoryItem[],
    candidateAccounts: CandidateAccount[],
  ): Promise<BatchCategorySuggestion[]> {
    const result = await this.chatJson(
      CATEGORY_BATCH_SYSTEM_PROMPT,
      JSON.stringify({
        candidateAccounts: slimAccounts(candidateAccounts),
        transactions: items,
      }),
    );
    return (result as { results?: BatchCategorySuggestion[] }).results ?? [];
  }

  async suggestClarificationQuestion(
    groups: PatternGroupInput[],
    candidateAccounts: CandidateAccount[],
  ): Promise<ClarificationSuggestion[]> {
    const result = await this.chatJson(
      CLARIFICATION_QUESTION_SYSTEM_PROMPT,
      JSON.stringify({
        candidateAccounts: slimAccounts(candidateAccounts),
        groups,
      }),
    );
    return (result as { results?: ClarificationSuggestion[] }).results ?? [];
  }
}

class OpenAiProvider extends OpenAiCompatibleProvider {
  readonly name = "openai";
  readonly supportsVision = true;
  protected baseUrl = "https://api.openai.com/v1";
  protected model = "gpt-4o-mini";
}

class DeepSeekProvider extends OpenAiCompatibleProvider {
  readonly name = "deepseek";
  readonly supportsVision = false;
  protected baseUrl = "https://api.deepseek.com/v1";
  protected model = "deepseek-chat";
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  readonly supportsVision = true;
  private model = "gemini-1.5-flash";

  private async generate(
    systemPrompt: string,
    userPrompt: string,
    images: InvoiceImage[] = [],
  ): Promise<unknown> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${env.aiApiKey}`;
    const parts: Record<string, unknown>[] = [
      { text: `${systemPrompt}\n\n${userPrompt}` },
    ];
    for (const img of images) {
      parts.push({
        inline_data: {
          mime_type: img.mimeType,
          data: img.data.toString("base64"),
        },
      });
    }
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
          },
        }),
      },
      "gemini generate",
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "<no body>");
      throw new Error(
        `gemini extraction call failed: ${res.status} ${errText}`,
      );
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("gemini returned no content");
    return parseJsonLoose(text, this.name);
  }

  async extractBankStatement(
    text: string,
  ): Promise<ExtractedBankTransaction[]> {
    const result = await this.generate(BANK_SYSTEM_PROMPT, text);
    return (
      (result as { transactions?: ExtractedBankTransaction[] }).transactions ??
      []
    );
  }

  async extractInvoice(text: string): Promise<ExtractedInvoice> {
    const result = await this.generate(
      INVOICE_TEXT_SYSTEM_PROMPT,
      `${INVOICE_TEXT_USER_PROMPT}\n\n--- RAW TEXT START ---\n${text}\n--- RAW TEXT END ---`,
    );
    return result as ExtractedInvoice;
  }

  async extractBankStatementFromImages(
    images: InvoiceImage[],
    ctx: { pageRange: string; previousBalance?: number },
  ): Promise<BankStatementVisionResult> {
    const result = await this.generate(
      BANK_VISION_SYSTEM_PROMPT,
      visionUserPrompt(ctx),
      images,
    );
    return normaliseVisionStatement(result);
  }

  async extractInvoiceFromImages(
    images: InvoiceImage[],
  ): Promise<ExtractedInvoice | null> {
    const result = await this.generate(
      INVOICE_VISION_SYSTEM_PROMPT,
      INVOICE_VISION_USER_PROMPT,
      images,
    );
    return result as ExtractedInvoice;
  }

  async suggestCategory(
    input: CategoryInput,
    candidateAccounts: CandidateAccount[],
  ): Promise<CategorySuggestion> {
    const result = await this.generate(
      CATEGORY_SYSTEM_PROMPT,
      JSON.stringify({ transaction: input, candidateAccounts }),
    );
    return result as CategorySuggestion;
  }

  async suggestCategoryBatch(
    items: BatchCategoryItem[],
    candidateAccounts: CandidateAccount[],
  ): Promise<BatchCategorySuggestion[]> {
    const result = await this.generate(
      CATEGORY_BATCH_SYSTEM_PROMPT,
      JSON.stringify({
        candidateAccounts: slimAccounts(candidateAccounts),
        transactions: items,
      }),
    );
    return (result as { results?: BatchCategorySuggestion[] }).results ?? [];
  }

  async suggestClarificationQuestion(
    groups: PatternGroupInput[],
    candidateAccounts: CandidateAccount[],
  ): Promise<ClarificationSuggestion[]> {
    const result = await this.generate(
      CLARIFICATION_QUESTION_SYSTEM_PROMPT,
      JSON.stringify({
        candidateAccounts: slimAccounts(candidateAccounts),
        groups,
      }),
    );
    return (result as { results?: ClarificationSuggestion[] }).results ?? [];
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let cached: AiProvider | null = null;

export function getAiProvider(): AiProvider {
  if (cached) return cached;
  switch (env.aiProvider) {
    case "openai":
      cached = new OpenAiProvider();
      break;
    case "deepseek":
      cached = new DeepSeekProvider();
      break;
    case "gemini":
      cached = new GeminiProvider();
      break;
    default:
      cached = new NullAiProvider();
  }
  console.log(
    `[ai-provider] using provider: ${cached.name} (vision=${cached.supportsVision})`,
  );
  return cached;
}
