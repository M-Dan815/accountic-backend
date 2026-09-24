import { ExtractedBankTransaction } from "@/lib/ai-provider";

/**
 * Deterministic parser for Al Rajhi Bank "كشف حساب جاري" (current account
 * statement) PDFs, built directly against a real statement sample from
 * this client. No AI call needed for this layout.
 *
 * Layout being matched (as pdf-parse extracts it — columns collapse into
 * reading order: balance, credit(دائن), debit(مدين), description block,
 * then the date "YYYY/MM/DD"), repeating once per transaction row.
 *
 * The description block carries the merchant name inside `ملاحظة:` /
 * `/شركة X` / `from X` patterns. We extract it as a first-class counterparty
 * (rather than gluing it into a free-text description) because both the
 * rule matcher and the AI prompt rely on it being clean.
 */

const ROW_RE =
  /([\d,]+\.\d{2})\s*SAR\s*([\d,]+\.\d{2})\s*SAR\s*([\d,]+\.\d{2})\s*SAR([\s\S]*?)(\d{4}\/\d{2}\/\d{2})/g;

const REFERENCE_RE = /([A-Z]{2,}\/\d{6,}[A-Z0-9\/]*)/;

/** The client firm's own name — never the counterparty. */
const CLIENT_NAME_RE =
  /نخل(ه|ة)\s+الخلیج|نخل(ه|ة)\s+الخليج|nakhla\s+al[- ]?khaleej/i;

export function looksLikeAlRajhiStatement(text: string): boolean {
  return (
    text.includes("alrajhi") ||
    text.includes("مصرف الراجحي") ||
    text.includes("كشف حساب جاري")
  );
}

export function parseAlRajhiStatement(
  text: string,
): ExtractedBankTransaction[] {
  const transactions: ExtractedBankTransaction[] = [];
  let match: RegExpExecArray | null;

  ROW_RE.lastIndex = 0;

  while ((match = ROW_RE.exec(text)) !== null) {
    const [, balanceRaw, creditRaw, debitRaw, descBlockRaw, dateRaw] = match;

    const credit = Number(creditRaw.replace(/,/g, ""));
    const debit = Number(debitRaw.replace(/,/g, ""));
    const amount = credit > 0 ? credit : -debit;
    const balance = Number(balanceRaw.replace(/,/g, ""));

    const descBlock = descBlockRaw.replace(/\s+/g, " ").trim();
    const { description, counterparty } = parseDescriptionBlock(descBlock);
    const reference = descBlock.match(REFERENCE_RE)?.[1];

    const [y, m, d] = dateRaw.split("/").map(Number);
    const iso = new Date(Date.UTC(y, m - 1, d)).toISOString();

    transactions.push({
      date: iso,
      description,
      amount,
      reference,
      counterparty,
      // parseDescriptionBlock() reduces the block to a short label — for POS
      // rows that is just the first 40 chars and the merchant, the sender's
      // memo ("راتب", "بنزين", "قسط البنك") and the beneficiary are LOST.
      // Keep the whole block so classification has the evidence.
      rawText: descBlock,
      // Running balance printed on the row — lets statementValidation prove
      // no row was dropped or misread.
      balance: Number.isFinite(balance) ? balance : undefined,
    });
  }

  return transactions;
}

const KNOWN_LABELS = [
  "حوالات فورية واردة",
  "حوالات فورية صادرة",
  "رسوم طبع كشف الحساب",
  "رسوم حوالة فورية صادرة",
  "حوالة فورية صادرة",
  "حوالة فورية واردة",
  "تحويل",
];

/**
 * Extract the label (for the description) and the merchant name (for
 * `counterparty`) from the Al Rajhi note block.
 *
 * Common shapes we need to survive:
 *   "-شركة مخصوص للخدمات اللوجستيةNCBK9962509…"     → مخصوص للخدمات اللوجستية
 *   "Palm Gulf-شركة ارام ميم للخدمات التجارية شركة" → ارام ميم للخدمات التجارية
 *   "/شركة الدريس للخدمات9109042500…"                → الدريس للخدمات
 *   "Online Purchase from hrsd gov, 0000000000"    → hrsd gov
 */
function parseDescriptionBlock(descBlock: string): {
  description: string;
  counterparty?: string;
} {
  const label =
    KNOWN_LABELS.find((l) => descBlock.includes(l)) ?? descBlock.slice(0, 40);
  const counterparty = extractCounterparty(descBlock);
  return {
    description: counterparty ? `${label} — ${counterparty}` : label,
    counterparty,
  };
}

function extractCounterparty(descBlock: string): string | undefined {
  const s = descBlock;

  // Pattern 0 (HIGHEST PRIORITY): Al Rajhi's explicit beneficiary marker
  // "**المستفيد:" (literally "beneficiary:"). Al Rajhi prints the actual
  // beneficiary name AFTER this marker, free of SADAD reference numbers and
  // other noise. Looking for it FIRST prevents the subsequent patterns from
  // grabbing garbage from the SADAD reference area (which is what happened
  // before this fix — counterparty was being stored as
  // "مخصوص للخدمات اللوجستية**المستفيد:شركة مخصوص للخدمات اللوجست",
  // truncated mid-name, and counterpartyKind failed to recognise it as a
  // company because the "شركة" prefix had been chopped off).
  const beneficiary = s.match(/\*\*المستفيد[:\s]*([^\n*]{3,100})/);
  if (beneficiary) {
    const cleaned = trimCounterparty(beneficiary[1]);
    if (cleaned && !CLIENT_NAME_RE.test(cleaned)) return cleaned;
  }

  // Pattern 1: "-شركة X" or "/شركة X" (delimited + company marker)
  const delimited = s.match(
    /[-/–]\s*(?:شركة|شركه|مؤسسة|مؤسسه)\s+([^\d\n\/–-]{3,80})/,
  );
  if (delimited) {
    const cleaned = trimCounterparty(delimited[1]);
    if (cleaned && !CLIENT_NAME_RE.test(cleaned)) return cleaned;
  }

  // Pattern 2: "/شركة X" as a standalone slash-prefix (outgoing transfers)
  const slash = s.match(/\/\s*(?:شركة|شركه|مؤسسة|مؤسسه)\s+([^\d\/]{3,80})/);
  if (slash) {
    const cleaned = trimCounterparty(slash[1]);
    if (cleaned && !CLIENT_NAME_RE.test(cleaned)) return cleaned;
  }

  // Pattern 3: "from X" in English
  const fromEn = s.match(
    /\bfrom\s+([A-Za-z][A-Za-z0-9\s&'.,-]{3,50}?)(?=[,.]|\s+\d|$)/i,
  );
  if (fromEn) {
    const cleaned = fromEn[1].trim().replace(/[,.]$/, "");
    if (cleaned.length >= 3) return cleaned;
  }

  // Pattern 4: any standalone "شركة X" run
  const standalone = s.match(
    /(?:^|\s)(?:شركة|شركه|مؤسسة|مؤسسه)\s+([^\d\n]{3,60})/,
  );
  if (standalone) {
    const cleaned = trimCounterparty(standalone[1]);
    if (cleaned && !CLIENT_NAME_RE.test(cleaned)) return cleaned;
  }

  return undefined;
}

function trimCounterparty(raw: string): string {
  // Strip trailing punctuation, digits, and any glued English/CAPS codes.
  let s = raw
    .replace(/[\dA-Z]{3,}.*$/, "") // cut at first CAPS/digit run (NCBK…, 996…, etc.)
    .replace(/[\/\-–_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 60 chars was too short — Arabic company names like "شركة مخصوص للخدمات
  // اللوجستية" are ~30 chars on their own, and the truncation was chopping
  // them mid-word which then broke counterpartyKind's company-marker
  // detection. 100 chars is enough for any realistic beneficiary name while
  // still preventing pathological inputs.
  if (s.length > 100) s = s.slice(0, 100).trim();
  return s;
}
