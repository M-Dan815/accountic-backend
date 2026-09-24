/**
 * Statement ENRICHMENT — the "AI reads the statement" step's deterministic
 * half.
 *
 * The Al Rajhi parser gets us rows (date / amount / raw text). That is only
 * *copying* the statement. What the accountant (and the client's ChatGPT
 * reference workbook) actually does next is INTERPRET each row:
 *
 *   • what kind of movement is this?  (POS purchase, instant transfer,
 *     SADAD bill, ATM cash, bank fee, refund …)
 *   • who is on the other side?       (merchant / company / person / us)
 *   • did the sender type a purpose?  ("راتب", "بنزين", "قسط البنك" …)
 *   • which fee row belongs to which transfer?
 *
 * Those facts are what classification consumes. Producing them here, once,
 * means the rule engine, the heuristic classifier and the LLM all read the
 * SAME structured evidence instead of re-parsing a scrambled string.
 *
 * Pure functions, no DB, no network — unit-testable against the client's
 * reference workbook (scripts/eval-against-reference.ts).
 */

export type TxnKind =
  | "POS_PURCHASE"
  | "ONLINE_PURCHASE"
  | "PURCHASE_REFUND"
  | "TRANSFER_OUT"
  | "TRANSFER_IN"
  | "INTERNAL_TRANSFER_IN" // "عملية تحويل داخلية" — from an Al Rajhi account holder
  | "FEE"
  | "SADAD_PAYMENT"
  | "SADAD_REFUND"
  | "ATM_WITHDRAWAL"
  | "ATM_DEPOSIT"
  | "OTHER";

export type CounterpartyType =
  | "company"
  | "person"
  | "self" // the client's own name → movement between its own accounts
  | "government"
  | "unknown";

export type Enrichment = {
  kind: TxnKind;
  /** Best-effort merchant (POS / online) — Latin or Arabic, as printed. */
  merchant?: string;
  /** Best-effort other party for transfers. */
  counterparty?: string;
  counterpartyType: CounterpartyType;
  /** Free-text purpose the sender typed, e.g. "راتب", "قيمه شراء بطاريه". */
  memo?: string;
  /** 16-digit instant-transfer reference; shared by a transfer and its fee. */
  transferRef?: string;
  /** Last 16 digits of the card token on POS rows (identifies the card). */
  cardRef?: string;
  /**
   * Stable identity of the OTHER party, used to group rows so that ONE
   * clarification / ONE learned rule covers every payment to the same payee:
   * beneficiary account number (TOACCT/FRACCT) when the bank prints it,
   * otherwise the normalised counterparty or merchant name.
   */
  beneficiaryKey?: string;
  isFee: boolean;
  /** Movement between the client's own accounts (e.g. Rajhi → Riyad Bank). */
  isSelfTransfer: boolean;
  /** Short human label for UI lists, e.g. "POS purchase · Curve Roastery Co". */
  summary: string;
  /** Lower-cased, Arabic-normalised text used by keyword matchers. */
  searchText: string;
};

const KIND_LABEL: Record<TxnKind, string> = {
  POS_PURCHASE: "POS purchase",
  ONLINE_PURCHASE: "Online purchase",
  PURCHASE_REFUND: "Purchase refund",
  TRANSFER_OUT: "Transfer out",
  TRANSFER_IN: "Transfer in",
  INTERNAL_TRANSFER_IN: "Internal transfer in",
  FEE: "Bank fee",
  SADAD_PAYMENT: "SADAD payment",
  SADAD_REFUND: "SADAD refund",
  ATM_WITHDRAWAL: "ATM withdrawal",
  ATM_DEPOSIT: "ATM deposit",
  OTHER: "Other",
};

let CLIENT_NAME_RE =
  /نخل[ةه]\s*ال[خح]ل[يى]ج|nakhal?a?\s+al[- ]?khaleej|nakhla\s+al[- ]?khaleej/i;

/** Client's own name after normalizeForSearch() (ة→ه). */
export let CLIENT_NAME_NORM_RE = /((ال)?شركه\s+)?نخل[هة]\s*ال[خح]ل[يى]ج(\s+للخدمات(\s+اللوجستيه)?)?/g;

let CLIENT_NAME_STRIP_RE =
  /((ال)?شرك[ةه]\s+)?نخل[ةه]\s*ال[خح]ل[يى]ج(\s+للخدمات(\s+اللوجستي[ةه])?)?/g;

const TIME_MARKER_RE = /:?\s*,?\s*ملاحظة\s*\d{1,2}:\d{2}:\d{2}\s*:?\s*الوقت/;

export function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

function splitHeadTail(text: string): { head: string; tail: string } {
  const m = text.match(TIME_MARKER_RE);
  if (!m || m.index === undefined) return { head: text, tail: "" };
  return {
    head: text.slice(0, m.index).trim(),
    tail: text.slice(m.index + m[0].length).trim(),
  };
}

function cleanMemo(raw: string): string | undefined {
  const s = raw
    .replace(/\b[A-Z]{2,}[A-Z0-9]*\b/g, " ") // glued Latin codes / names
    .replace(/[0-9]{6,}/g, " ")
    .replace(/[\/\-–_:()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length >= 2 ? s : undefined;
}

function counterpartyKind(name: string | undefined): CounterpartyType {
  if (!name) return "unknown";
  if (CLIENT_NAME_RE.test(name)) return "self";
  if (/(^|\s)(شركة|شركه|مؤسسة|مؤسسه|company|co\b|est\b|llc|corp|trading|logistics|services)/i.test(name))
    return "company";
  if (/(وزارة|هيئة|هيئه|بلدية|مرور|gov)/i.test(name)) return "government";
  return "person";
}

export function enrichStatementRow(
  rawDescription: string,
  amount: number,
): Enrichment {
  const e = enrichCore(rawDescription, amount);
  e.beneficiaryKey = beneficiaryKeyFor(rawDescription, e);
  // ── Counterparty cleanup ──────────────────────────────────────────────
  // Anas feedback: counterparty values were showing up in the UI with
  // timestamps, "ملاحظة" suffixes, and internal noise glued on. This makes
  // them useless as display labels and confuses the AI prompt. Sanitise the
  // final value: strip leading "الوقت:HH:MM:SS" timestamps, trailing
  // "**ملاحظة:…" noise, internal SADAD reference codes, and stray
  // punctuation. Do this AFTER beneficiaryKey is computed (which uses the
  // raw name) so the propagation key stays stable.
  e.counterparty = cleanCounterpartyForDisplay(e.counterparty);
  e.merchant = cleanCounterpartyForDisplay(e.merchant);
  e.summary = [KIND_LABEL[e.kind], e.merchant ?? e.counterparty, e.memo]
    .filter(Boolean)
    .join(" · ");
  return e;
}

/**
 * Strip the noise that ends up glued to counterparty / merchant values when
 * the bank text layout doesn't match the parser's expectations. The cleaned
 * value is what the UI displays and what the AI prompt sees.
 */
function cleanCounterpartyForDisplay(name: string | undefined): string | undefined {
  if (!name) return name;
  let s = name;
  // Strip leading "الوقت:HH:MM:SS" or "الوقت: HH:MM:SS" timestamps.
  s = s.replace(/الوقت\s*:?\s*\d{1,2}:\d{2}(?::\d{2})?/g, " ");
  // Strip "**ملاحظة" / "ملاحظة:" + anything after it (these are note markers,
  // never part of a counterparty name).
  s = s.replace(/\*{0,2}\s*ملاحظة[^*]*/g, " ");
  // Strip standalone "ملاحظة:" prefixes too.
  s = s.replace(/\bملاحظة\s*:?\s*/g, " ");
  // Collapse "**" separators that Al Rajhi uses to glue fields together.
  s = s.replace(/\*+/g, " ");
  // Strip any internal SADAD reference codes (long digit runs glued to names).
  s = s.replace(/\d{6,}\S*/g, " ");
  // Collapse whitespace and trim.
  s = s.replace(/\s+/g, " ").trim();
  // If what's left is too short to be a real name, return undefined so the
  // caller falls back to merchant or null — better to show no counterparty
  // than to show "الوقت:" or "ملاحظة".
  return s.length >= 2 ? s : undefined;
}

function beneficiaryKeyFor(raw: string, e: Enrichment): string | undefined {
  const acct = raw.match(/(?:TOACCT|FRACCT)\/(\d{10,})/)?.[1];
  if (acct) return `acct:${acct}`;
  const name = e.counterparty ?? e.merchant;
  if (!name) return undefined;
  const n = normalizeForSearch(name).replace(/[^\p{L}\p{N} ]/gu, "").trim();
  return n.length >= 3 ? `name:${n}` : undefined;
}

function enrichCore(
  rawDescription: string,
  amount: number,
): Enrichment {
  // Some exports prefix a stray single letter ("ا حوالات …", "م التحويل …").
  const text = rawDescription
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\u0621-\u064A]\s+(?=\S{3,})/, "");
  const searchText = normalizeForSearch(text);
  const { head, tail } = splitHeadTail(text);
  const transferRef = text.match(/(?<!\d)(\d{16})(?!\d)/)?.[1];

  const base = {
    summary: "",
    isFee: false,
    isSelfTransfer: false,
    counterpartyType: "unknown" as CounterpartyType,
    searchText,
  };

  // ── Bank fee on an instant transfer ────────────────────────────────────
  if (/^رسوم\s+حوال/.test(text) || /^رسوم\s+(طبع|خدمة|تحويل)/.test(text)) {
    const cp = extractTransferCounterparty(head);
    return {
      ...base,
      kind: "FEE",
      isFee: true,
      transferRef,
      counterparty: cp,
      counterpartyType: counterpartyKind(cp),
      isSelfTransfer: counterpartyKind(cp) === "self",
      memo: cleanMemo(tail),
    };
  }

  // ── POS purchase ────────────────────────────────────────────────────────
  if (/شراء\s+عبر\s+نقاط\s+البيع/.test(text)) {
    const pre = head.match(/محلي\s+([^()]*?)\s*\(/)?.[1]?.trim() ?? "";
    const cardRef = head.match(/\(\s*\d+-(\d{16})\s*\)/)?.[1];
    const post = tail.split(",")[0].trim();
    const merchant = [pre, post].filter(Boolean).join(" ").trim() || undefined;
    return { ...base, kind: "POS_PURCHASE", merchant, cardRef };
  }

  // ── Online purchase / refund ───────────────────────────────────────────
  if (/شراء\s+انترنت/.test(text) || /Online Purchase/i.test(text)) {
    const from = text.match(/Online Purchase(?: Refund)? from\s+([^,:]+)/i)?.[1];
    const tailMerchant = tail.split(",").slice(-3)[0]?.trim();
    const merchant = (from ?? tailMerchant)?.trim() || undefined;
    return { ...base, kind: "ONLINE_PURCHASE", merchant };
  }
  if (/استرداد\s+مبلغ\s+شراء|Purchase Refund/i.test(text)) {
    const from = text.match(/from\s+([^,:]+)/i)?.[1]?.trim();
    return { ...base, kind: "PURCHASE_REFUND", merchant: from };
  }

  // ── "عملية تحويل داخلية <name>W-/FRACCT/…" ─────────────────────────────
  if (/عملية\s+تحويل\s+داخلية/.test(text)) {
    const name = head.match(/داخلية\s*([^\s]*?)\s*W-/)?.[1]?.trim();
    return {
      ...base,
      kind: "INTERNAL_TRANSFER_IN",
      counterparty: name,
      counterpartyType: "person",
      transferRef,
    };
  }

  // ── Traffic fines paid by transfer ("Violation Number … Traffic Law") ──
  if (/Violation Number|Traffic Law/i.test(text)) {
    return { ...base, kind: "SADAD_PAYMENT", counterpartyType: "government" };
  }

  // ── Instant transfers (حوالة فورية / حوالات فورية / حوالة محلية) ────────
  if (/حوال(ة|ات)\s+(فورية|محلية)/.test(text)) {
    const outgoing = /صادرة/.test(head) || (amount < 0 && !/واردة/.test(head));
    // On INCOMING rows the client's own name is the RECEIVER, not the
    // counterparty — strip it before looking for the sender.
    const strip = (x: string) => (outgoing ? x : x.replace(CLIENT_NAME_STRIP_RE, " "));
    const cp = extractTransferCounterparty(strip(head), strip(tail));
    const type = counterpartyKind(cp);
    return {
      ...base,
      kind: outgoing ? "TRANSFER_OUT" : "TRANSFER_IN",
      counterparty: cp,
      counterpartyType: type,
      isSelfTransfer: type === "self" && outgoing,
      memo: cleanMemo(tail),
      transferRef,
    };
  }

  // ── "تحويل <name|memo>E-/TOACCT|FRACCT/…" ──────────────────────────────
  if (/^تحويل|\bتحويل\b/.test(text) && /(TOACCT|FRACCT)/.test(text)) {
    const outgoing = /TOACCT/.test(text);
    const between = head.match(/تحويل\s*-?\s*([^E]*?)\s*-?\s*E-?/)?.[1]?.trim();
    const latinName = text.match(/(?:TO|FR)([A-Z][A-Z ]{2,})\s*$/)?.[1]?.trim();
    const isEntity = /^(شركة|شركه|مؤسسة|مؤسسه)/.test(between ?? "");
    // Words typed before E- can be either the beneficiary or a memo; the
    // memo keywords (راتب, بنزين …) are resolved later by the classifier
    // through `searchText`, so we keep the raw remainder in `memo`.
    const memoCandidate = cleanMemo(`${between ?? ""} ${tail}`);
    return {
      ...base,
      kind: outgoing ? "TRANSFER_OUT" : "TRANSFER_IN",
      counterparty: isEntity ? between : (latinName ?? between),
      counterpartyType: isEntity ? "company" : "person",
      memo: memoCandidate,
      transferRef,
    };
  }

  // ── SADAD family ────────────────────────────────────────────────────────
  if (/^[إا]سترداد\s+مدفوعات\s+س[ـ]?داد/.test(text)) {
    return { ...base, kind: "SADAD_REFUND", counterpartyType: "government" };
  }
  if (
    /^(فواتير\s+نظام\s+سداد|خدمات\s+المقيمين|المخالفات\s+المرورية)/.test(text) ||
    /^[^\d]{0,40}مدفوعات\s+س[ـ]?داد/.test(text)
  ) {
    return { ...base, kind: "SADAD_PAYMENT", counterpartyType: "government" };
  }

  // ── ATM ─────────────────────────────────────────────────────────────────
  if (/الصراف\s+ال[آا]لي-?\s*سحب/.test(text)) {
    return { ...base, kind: "ATM_WITHDRAWAL" };
  }
  if (/الصراف\s+ال[آا]لي-?\s*[إا]يداع|عمليات\s+صراف\s+[آا]لي\s+دائنة/.test(text)) {
    return { ...base, kind: "ATM_DEPOSIT" };
  }

  return {
    ...base,
    kind: "OTHER",
    memo: cleanMemo(tail || head),
  };
}

/** "/الشركة نخلة الخليج9108…" → "الشركة نخلة الخليج" */
function extractTransferCounterparty(
  head: string,
  tail = "",
): string | undefined {
  // Pattern 0 (HIGHEST PRIORITY): Al Rajhi's explicit beneficiary marker
  // "**المستفيد:" — the actual counterparty is printed after it, free of
  // SADAD reference numbers and time stamps. This is the most reliable
  // signal we have for incoming instant transfers, where the previous
  // greedy `\d{6,}.*$` regex was eating everything from the SADAD date
  // stamp onwards and leaving us with garbage like "الوقت:**ملاحظة:" as
  // the counterparty.
  const fullText = `${head} ${tail}`;
  const beneficiary = fullText.match(/\*\*المستفيد[:\s]*([^\n*]{3,100})/);
  if (beneficiary) {
    const cleaned = beneficiary[1]
      .replace(/[\dA-Z]{3,}.*$/, "") // cut at first CAPS/digit run (SADAD ref, NCBK…)
      .replace(/[\/\-–_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 3) return cleaned;
  }

  const afterLabel = head
    .replace(/^.*?(صادرة|واردة)/, "")
    .replace(/Payment-[^\s]*/i, " ")
    .replace(/^[\s:/\-–]+/, "");
  const noRef = afterLabel
    // FIX: `\d{6,}.*$` was too greedy — it matched from the first 6+ digit
    // run (the SADAD date stamp like "20240222") all the way to end of
    // string, eating the actual counterparty name. `\d{6,}\S*` only
    // consumes the digits + the immediately following non-whitespace
    // token (the SADAD reference number itself), preserving the
    // counterparty name that follows on the rest of the line.
    .replace(/\d{6,}\S*/, "")
    .replace(/[\/:\-]+$/, "")
    .replace(/^[\s\-–:/]+/, "")
    .trim();
  const candidate = noRef.split("/")[0].trim();
  if (candidate.length >= 2) return candidate;
  // Incoming transfers print the sender inside the tail.
  const fromTail = tail
    .replace(/^[\s\-–:/]+/, "")
    .replace(/\d{6,}\S*/, "") // ← same greedy-regex fix
    .replace(/[\s\-–:/]+$/, "")
    .trim();
  return fromTail.length >= 2 ? fromTail : undefined;
}


// ─── The client's own name ────────────────────────────────────────────────
// "Payee is the client" (spec R060 / own-account transfers) needs the NAME OF
// THE CLIENT WHOSE FILE IS BEING PROCESSED — it used to be one hard-coded
// company. Call once per case before enriching; the loop that follows is
// synchronous, so concurrent cases cannot interleave.
const GENERIC_NAME_WORDS = new Set(["شركه", "شركة", "مؤسسه", "مؤسسة", "للخدمات", "اللوجستيه", "اللوجستية", "التجاريه", "التجارية", "المحدوده", "المحدودة", "co", "llc", "ltd", "est", "company", "trading", "services", "logistics"]);

export function configureClientIdentity(clientName: string | null | undefined): void {
  const words = normalizeForSearch(clientName ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !GENERIC_NAME_WORDS.has(w));
  if (words.length === 0) return; // keep the legacy pattern
  const core = words.slice(0, 3).map((w) =>
    w.replace(/ا/g, "[اأإآ]").replace(/[ةه]/g, "[هة]").replace(/[يى]/g, "[يى]").replace(/[خح]/g, "[خح]"),
  ).join("\\s*");
  CLIENT_NAME_RE = new RegExp(core, "i");
  CLIENT_NAME_STRIP_RE = new RegExp(`((ال)?شرك[ةه]\\s+)?${core}(\\s+للخدمات(\\s+اللوجستي[ةه])?)?`, "g");
  CLIENT_NAME_NORM_RE = new RegExp(`((ال)?شركه\\s+)?${core}(\\s+للخدمات(\\s+اللوجستيه)?)?`, "g");
}
