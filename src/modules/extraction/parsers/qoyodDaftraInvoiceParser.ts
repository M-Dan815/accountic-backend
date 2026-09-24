import { ExtractedInvoice } from "@/lib/ai-provider";

const MARKER_WORDS = new Set(["شركة", "شركه", "مؤسسة", "مؤسسه", "شرکة"]);

function looksLikeRealCompanyName(name: string): boolean {
  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  // Only the FIRST token may be a company marker.
  for (let i = 1; i < tokens.length; i++) {
    if (MARKER_WORDS.has(tokens[i])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

const DEBUG = true;
const log = (...args: unknown[]) => {
  if (DEBUG) console.log("[invoice-parse]", ...args);
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function looksLikeQoyodOrDaftraInvoice(text: string): boolean {
  return /فاتورة|المرجع|Invoice/.test(text);
}

function normalizeSpacing(s: string): string {
  return s
    .replace(/[\u200B-\u200D\uFEFF]/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/[\u060C\u061B\u061F]/g, " ");
}

// ---------------------------------------------------------------------------
// Low-level value extractors
// ---------------------------------------------------------------------------

function firstNumberAfter(
  text: string,
  label: string,
  window = 60,
): number | undefined {
  const idx = text.indexOf(label);
  if (idx === -1) return undefined;
  const slice = text.slice(idx + label.length, idx + label.length + window);
  const m = slice.match(/([\d,]+)\s*\.\s*(\d{1,2})/);
  if (!m) return undefined;
  return Number(`${m[1].replace(/,/g, "")}.${m[2]}`);
}

function firstDateAfter(
  text: string,
  label: string,
  format: "dmy" | "ymd",
  window = 40,
): string | undefined {
  const idx = text.indexOf(label);
  if (idx === -1) return undefined;
  const slice = text.slice(idx, idx + label.length + window);
  if (format === "dmy") {
    const m = slice.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return undefined;
    return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])).toISOString();
  }
  const m = slice.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return undefined;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString();
}

/**
 * Daftra places the value ABOVE the label. Scan backwards and return
 * the date CLOSEST to the label (last one in the window).
 */
function firstDateBefore(
  text: string,
  label: string,
  format: "dmy" | "ymd",
  window = 150,
): string | undefined {
  const idx = text.indexOf(label);
  if (idx === -1) return undefined;
  const slice = text.slice(Math.max(0, idx - window), idx);
  const re =
    format === "dmy"
      ? /(\d{2})\/(\d{2})\/(\d{4})/g
      : /(\d{4})-(\d{2})-(\d{2})/g;
  const matches = [...slice.matchAll(re)];
  if (matches.length === 0) return undefined;
  const m = matches[matches.length - 1];
  return format === "dmy"
    ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])).toISOString()
    : new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString();
}

/** Tokens that are themselves invoice-document labels, not values. */
const LABEL_NOISE = new Set([
  "الفاتورة",
  "فاتورة",
  "المرجع",
  "رقم",
  "التاريخ",
  "تاريخ",
  "الاجمالي",
  "الاجمالى",
  "الإجمالي",
  "المجموع",
  "الضريبة",
  "الضريبه",
  "الخصم",
  "الكمية",
  "الكميه",
  "السعر",
  "سعر",
  "الوصف",
  "وصف",
  "المبلغ",
  "المستحق",
  "الاصدار",
  "الإصدار",
  "الاستحقاق",
  "مبيعات",
  "مشتريات",
  "ضريبة",
  "قيمة",
  "شامل",
  "قبل",
  "بعد",
]);

const stripPunct = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
const isLabelNoise = (t: string) => {
  const k = stripPunct(t);
  return !k || LABEL_NOISE.has(k);
};

function firstTextAfter(
  text: string,
  label: string,
  window = 20,
): string | undefined {
  const idx = text.indexOf(label);
  if (idx === -1) return undefined;
  const slice = text.slice(idx + label.length, idx + label.length + window);
  const re = /([A-Za-z0-9\u0600-\u06FF][A-Za-z0-9\u0600-\u06FF-]{1,})/g;
  for (const m of slice.matchAll(re)) {
    if (!isLabelNoise(m[1])) return m[1];
  }
  return undefined;
}

/**
 * Daftra places the value ABOVE the label. Scan backwards for the closest
 * non-label token.
 */
function firstTextBefore(
  text: string,
  label: string,
  window = 120,
): string | undefined {
  const idx = text.indexOf(label);
  if (idx === -1) return undefined;
  const slice = text.slice(Math.max(0, idx - window), idx);
  const tokens =
    slice.match(/[A-Za-z0-9\u0600-\u06FF][A-Za-z0-9\u0600-\u06FF-]{1,}/g) ?? [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!isLabelNoise(tokens[i])) return tokens[i];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Counterparty extraction
// ---------------------------------------------------------------------------

/** Every plausible ordering of the "customer details" header. */
const CUSTOMER_LABEL_VARIANTS = [
  "تفاصيل بيانات العميل",
  "بيانات تفاصيل العميل",
  "العميل بيانات تفاصيل",
  "العميل تفاصيل بيانات",
];

const LABEL_WORDS = new Set(["تفاصيل", "بيانات", "العميل"]);

const BOUNDARY_WORDS = new Set([
  "فاتوره",
  "فاتورة",
  "ضريبيه",
  "ضريبية",
  "مبسطه",
  "مبسطة",
  "الفاتوره",
  "الفاتورة",
  "الرياض",
  "جده",
  "جدة",
  "الدمام",
  "مکه",
  "مكة",
  "المدينه",
  "المدينة",
  "السعوديه",
  "السعودية",
  "شارع",
  "الحي",
  "الربوه",
  "الربوة",
  "نجد",
  "من",
  "الى",
  "إلى",
  "الرقم",
  "رقم",
  "التاريخ",
  "تاريخ",
  "الاجمالي",
  "الاجمالى",
  "الإجمالي",
  "الاجماليه",
  "الاجمالية",
]);

function boundaryKey(word: string): string {
  return word
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\u0640/g, "")
    .replace(/\u06CC/g, "\u064A")
    .replace(/\u06A9/g, "\u0643")
    .replace(/[أإآٱا]/g, "\u0627")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0649/g, "\u064A");
}

function trimToCompanyName(raw: string): string {
  const tokens = raw.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const tok of tokens) {
    // Stop at pure-digit tokens (tax IDs, phone numbers, etc.).
    if (/^\d+$/.test(tok)) break;
    const key = boundaryKey(tok);
    const stripped = key.replace(/[^\p{L}\p{N}]/gu, "");
    if (BOUNDARY_WORDS.has(stripped)) break;
    out.push(tok);
    if (out.length >= 8) break;
  }
  return out.join(" ").trim();
}

function firstRealSegmentAfter(
  text: string,
  label: string,
  window = 200,
): string | undefined {
  const idx = text.indexOf(label);
  if (idx === -1) return undefined;
  const raw = text.slice(idx + label.length, idx + label.length + window);

  const segments = raw.split(/[\n\r:؛,،]|\d{4,}/);
  for (const seg of segments) {
    const cleaned = seg
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length < 3) continue;
    const words = cleaned.split(/\s+/);
    if (words.every((w) => LABEL_WORDS.has(w))) continue;
    return trimToCompanyName(cleaned).slice(0, 80);
  }
  return undefined;
}

/**
 * Company-marker scan.
 *
 *  1. NATURAL order:  "شركة <following words>"  — how Daftra emits names.
 *  2. RTL-flipped:    "شركة <reversed preceding words>"  — Qoyod workaround.
 *
 * Natural-order candidates are pushed first, so results[0] is preferred.
 */
function extractCompanyPhrases(text: string): string[] {
  const MARKERS = ["شركة", "شركه", "مؤسسة", "مؤسسه", "شرکة"];
  const ARABIC_WORD_RE = /[\u0600-\u06FF]{2,}/g;
  const results: string[] = [];

  for (const marker of MARKERS) {
    let from = 0;
    while (true) {
      const idx = text.indexOf(marker, from);
      if (idx === -1) break;

      // (1) Natural order: marker + following words (Daftra layout).
      const afterSlice = text.slice(
        idx + marker.length,
        idx + marker.length + 80,
      );
      const afterWords = (afterSlice.match(ARABIC_WORD_RE) ?? []).slice(0, 6);
      if (afterWords.length >= 1) {
        const name = trimToCompanyName([marker, ...afterWords].join(" "));
        if (looksLikeRealCompanyName(name)) results.push(name);
      }

      // (2) RTL-flipped: marker + reversed preceding words (Qoyod layout).
      const start = Math.max(0, idx - 60);
      const preceding = text.slice(start, idx);
      const words = (preceding.match(ARABIC_WORD_RE) ?? []).filter(
        (w) => w.length >= 2,
      );
      if (words.length >= 1) {
        const name = trimToCompanyName([marker, ...words.reverse()].join(" "));
        if (looksLikeRealCompanyName(name)) results.push(name);
      }

      from = idx + marker.length;
    }
  }

  return [...new Set(results)].filter((s) => s.length > 0);
}

/** Client firm's own name — never the counterparty. */
const CLIENT_NAME_RE = /نخل(ه|ة)\s+الخلیج|نخل(ه|ة)\s+الخليج/i;

function extractCounterparty(text: string): string | undefined {
  for (const label of CUSTOMER_LABEL_VARIANTS) {
    const v = firstRealSegmentAfter(text, label, 300);
    if (v) {
      log(`counterparty via label "${label}": "${v}"`);
      return v;
    }
  }

  const short = firstRealSegmentAfter(text, "العميل", 150);
  if (short) {
    log(`counterparty via short label "العميل": "${short}"`);
    return short;
  }

  const candidates = extractCompanyPhrases(text);
  log(`counterparty candidates: [${candidates.join(" | ")}]`);
  const withoutClient = candidates.filter((c) => !CLIENT_NAME_RE.test(c));
  if (withoutClient.length > 0) {
    log(`counterparty via company-phrase scan: "${withoutClient[0]}"`);
    return withoutClient[0];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Direction inference
// ---------------------------------------------------------------------------

function inferDirection(text: string): "PAYABLE" | "RECEIVABLE" {
  const head = text.slice(0, 2000);

  if (head.includes("مبيعات") || /sales\s*invoice/i.test(head)) {
    return "RECEIVABLE";
  }
  if (head.includes("مشتريات") || /purchase\s*invoice/i.test(head)) {
    return "PAYABLE";
  }
  if (
    head.includes("تفاصيل بيانات العميل") ||
    head.includes("بيانات تفاصيل العميل") ||
    head.includes("العميل بيانات تفاصيل")
  ) {
    return "RECEIVABLE";
  }
  if (head.includes("مفتوّر من") || head.includes("مفتر من")) {
    return "RECEIVABLE";
  }

  return "PAYABLE";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseQoyodOrDaftraInvoice(rawText: string): ExtractedInvoice {
  try {
    log("=== new invoice ===");
    log(`raw length=${rawText.length}`);
    log(`first 200 chars: ${JSON.stringify(rawText.slice(0, 200))}`);

    const text = normalizeSpacing(rawText);
    const direction = inferDirection(text);
    log(`inferred direction=${direction}`);

    const isDaftra =
      text.includes("رقم الفاتورة") ||
      text.includes("الفاتورة رقم") ||
      text.includes("daftra.com");
    log(`isDaftra=${isDaftra}`);

    let parsed: ExtractedInvoice;

    if (isDaftra) {
      // Daftra: value ABOVE label. Try after-label first (in case layout
      // is normal), then before-label.
      const invoiceNumber =
        firstTextAfter(text, "رقم الفاتورة", 12) ??
        firstTextAfter(text, "الفاتورة رقم", 12) ??
        firstTextBefore(text, "رقم الفاتورة", 120) ??
        firstTextBefore(text, "رقم", 120);
      log(`[daftra] invoiceNumber=${invoiceNumber ?? "<none>"}`);

      // Daftra dates are ymd and sit above the label.
      const date =
        firstDateAfter(text, "تاريخ الإصدار", "ymd") ??
        firstDateAfter(text, "تاريخ", "ymd") ??
        firstDateBefore(text, "تاريخ الإصدار", "ymd", 200) ??
        firstDateBefore(text, "تاريخ", "ymd", 200) ??
        firstDateAfter(text, "تاريخ", "dmy") ??
        firstDateBefore(text, "تاريخ", "dmy", 200);
      log(`[daftra] date=${date ?? "<none>"}`);

      const amountBeforeVat =
        firstNumberAfter(text, "الإجمالي") ??
        firstNumberAfter(text, "الاجمالي") ??
        firstNumberAfter(text, "اCجمالي");
      const vatAmount =
        firstNumberAfter(text, "المضافة") ?? firstNumberAfter(text, "اEضافة");
      const allTotals = matchAllNumbersAfterEachOccurrence(text, [
        "الإجمالي",
        "الاجمالي",
        "اCجمالي",
      ]);
      const amountTotal =
        allTotals.length > 0
          ? allTotals[allTotals.length - 1]
          : (amountBeforeVat ?? 0);
      log(
        `[daftra] beforeVat=${amountBeforeVat} vat=${vatAmount} ` +
          `totalCandidates=[${allTotals.join(",")}] chosenTotal=${amountTotal}`,
      );

      const counterparty = extractCounterparty(text);
      log(`[daftra] counterparty="${counterparty ?? "<null>"}"`);

      parsed = {
        invoiceNumber,
        date,
        counterparty,
        amountBeforeVat,
        vatAmount,
        amountTotal: amountTotal ?? 0,
        direction,
      };
    } else {
      const invoiceNumber =
        firstTextAfter(text, "المرجع", 12) ??
        firstTextBefore(text, "المرجع", 120);
      log(`[qoyod] invoiceNumber=${invoiceNumber ?? "<none>"}`);

      const amountBeforeVat =
        firstNumberAfter(text, "الاجمالي قبل الضريبة") ??
        firstNumberAfter(text, "الإجمالي قبل الضريبة") ??
        firstNumberAfter(text, "قبل الاجمالي");
      const vatAmount =
        firstNumberAfter(text, "اجمالي الضريبة") ??
        firstNumberAfter(text, "إجمالي الضريبة") ??
        firstNumberAfter(text, "الضريبة اجمالي");
      const amountTotal =
        firstNumberAfter(text, "المجموع") ??
        firstNumberAfter(text, "الإجمالي") ??
        0;
      const date =
        firstDateAfter(text, "الإصدار", "ymd") ??
        firstDateAfter(text, "تاريخالإصدار", "ymd") ??
        firstDateBefore(text, "الإصدار", "ymd", 200) ??
        firstDateAfter(text, "الإصدار", "dmy");
      log(
        `[qoyod] beforeVat=${amountBeforeVat} vat=${vatAmount} ` +
          `total=${amountTotal} date=${date ?? "<none>"}`,
      );

      const counterparty = extractCounterparty(text);
      log(`[qoyod] counterparty="${counterparty ?? "<null>"}"`);

      parsed = {
        invoiceNumber,
        date,
        counterparty,
        amountBeforeVat,
        vatAmount,
        amountTotal,
        direction,
      };
    }

    log(
      `RESULT number=${parsed.invoiceNumber ?? "<none>"} ` +
        `date=${parsed.date ?? "<none>"} total=${parsed.amountTotal} ` +
        `direction=${parsed.direction} counterparty="${parsed.counterparty ?? "<null>"}"`,
    );

    return parsed;
  } catch (err) {
    console.error("[invoice-parse] THREW on input:", {
      rawLength: rawText.length,
      first500: rawText.slice(0, 500),
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // Fail soft — return a minimal object so the caller doesn't drop
    // the whole batch on one malformed PDF.
    return {
      invoiceNumber: undefined,
      date: undefined,
      counterparty: undefined,
      amountBeforeVat: undefined,
      vatAmount: undefined,
      amountTotal: 0,
      direction: "PAYABLE",
    };
  }
}

function matchAllNumbersAfterEachOccurrence(
  text: string,
  labels: string[],
): number[] {
  const results: number[] = [];
  for (const label of labels) {
    let from = 0;
    while (true) {
      const idx = text.indexOf(label, from);
      if (idx === -1) break;
      const slice = text.slice(idx + label.length, idx + label.length + 40);
      const m = slice.match(/([\d,]+)\s*\.\s*(\d{1,2})/);
      if (m) results.push(Number(`${m[1].replace(/,/g, "")}.${m[2]}`));
      from = idx + label.length;
    }
  }
  return results;
}
