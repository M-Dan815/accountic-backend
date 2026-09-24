import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";
import { getAiProvider, type InvoiceImage } from "@/lib/ai-provider";
import { pdfToPngPages } from "@/lib/pdf-to-images";
import {
  looksLikeAlRajhiStatement,
  parseAlRajhiStatement,
} from "./parsers/alRajhiStatementParser";
import {
  looksLikeQoyodOrDaftraInvoice,
  parseQoyodOrDaftraInvoice,
} from "./parsers/qoyodDaftraInvoiceParser";
import { ExtractedBankTransaction, ExtractedInvoice } from "@/lib/ai-provider";
import { extractStatementFromPages } from "./statementVision";
import {
  validateStatement,
  type StatementReport,
} from "./statementValidation";

export type ExtractionResult =
  | {
      kind: "bank_transactions";
      method: string;
      transactions: ExtractedBankTransaction[];
      /** Arithmetic verification of the extraction (see statementValidation.ts). */
      report: StatementReport;
    }
  | { kind: "invoice"; method: string; invoice: ExtractedInvoice };

const log = (...a: unknown[]) => console.log("[extraction]", ...a);
const warn = (...a: unknown[]) => console.warn("[extraction]", ...a);

/** Below this many characters, the text layer is not worth parsing. */
const MIN_USABLE_TEXT_LEN = 20;

function missingInvoiceFields(inv: ExtractedInvoice): string[] {
  const missing: string[] = [];
  if (!inv.amountTotal || inv.amountTotal <= 0) missing.push("amountTotal");
  if (!inv.invoiceNumber) missing.push("invoiceNumber");
  if (!inv.date) missing.push("date");
  if (!inv.counterparty || inv.counterparty.trim().length < 3)
    missing.push("counterparty");
  return missing;
}

function validateAiInvoice(
  ai: ExtractedInvoice,
  rawText: string,
): { ok: boolean; reason: string } {
  if (!ai.amountTotal || ai.amountTotal <= 0) {
    return { ok: false, reason: "AI returned zero/missing amountTotal" };
  }
  if (
    ai.amountBeforeVat != null &&
    ai.vatAmount != null &&
    ai.amountTotal != null
  ) {
    const sum = ai.amountBeforeVat + ai.vatAmount;
    if (Math.abs(sum - ai.amountTotal) > 0.05) {
      return {
        ok: false,
        reason: `beforeVat(${ai.amountBeforeVat}) + vat(${ai.vatAmount}) = ${sum.toFixed(2)} ≠ total(${ai.amountTotal})`,
      };
    }
  }
  // amountTotal should appear somewhere in raw text — warn, don't reject.
  if (rawText.length > 0) {
    const tot = ai.amountTotal;
    const variants = [
      tot.toFixed(2),
      tot.toFixed(2).replace(".", ","),
      tot.toFixed(2).replace(".", " . "),
      String(Math.round(tot)),
    ];
    if (!variants.some((v) => rawText.includes(v))) {
      warn(`AI amountTotal ${tot} not found verbatim in raw text (suspicious)`);
    }
  }
  return { ok: true, reason: "ok" };
}

/** Max pages rendered for vision. If a statement hits this, it is flagged as possibly truncated. */
const MAX_STATEMENT_PAGES = 300;

type Candidate = {
  method: string;
  transactions: ExtractedBankTransaction[];
  report: StatementReport;
};

const rank = (c: Candidate) =>
  (c.report.status === "VERIFIED" ? 0 : c.report.status === "UNVERIFIED" ? 1 : 2) * 1e6 +
  c.report.issues.length * 1e3 -
  Math.min(c.transactions.length, 999);

/**
 * Bank statement extraction, cheapest-trustworthy-first:
 *
 *   1. deterministic parser (known layout)   — free, exact
 *   2. text-layer AI      (unknown layout)   — when the PDF has selectable text
 *   3. vision AI, chunked (any layout/scan)  — page images, verified per chunk
 *
 * EVERY candidate is validated arithmetically (running balances, totals,
 * date order). The first VERIFIED/UNVERIFIED candidate wins; if all fail, the
 * least-broken one is returned with status FAILED and an itemised report so
 * the pipeline raises a blocking exception instead of silently posting
 * wrong numbers.
 */
export async function extractBankStatement(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<ExtractionResult> {
  const text = await textFromFile(fileBuffer, mimeType);
  const textUsable = text.trim().length >= 200;
  log(`bank: textLength=${text.length} usable=${textUsable}`);

  const candidates: Candidate[] = [];
  const accept = (c: Candidate): ExtractionResult | null => {
    candidates.push(c);
    log(`bank: ${c.method} → ${c.transactions.length} rows, ${c.report.status}` +
      (c.report.issues.length ? ` (${c.report.issues.length} issue(s))` : ""));
    return c.report.status !== "FAILED"
      ? { kind: "bank_transactions", method: c.method, transactions: c.transactions, report: c.report }
      : null;
  };

  // 1 ─ deterministic parser
  if (textUsable && looksLikeAlRajhiStatement(text)) {
    const rows = parseAlRajhiStatement(text);
    if (rows.length > 0) {
      const done = accept({ method: "deterministic:al-rajhi", transactions: rows, report: validateStatement(rows) });
      if (done) return done;
    }
  } else {
    log("bank: layout not recognised by a deterministic parser");
  }

  const provider = getAiProvider();

  // 2 ─ text-layer AI
  if (provider.name !== "none" && textUsable) {
    try {
      const rows = await provider.extractBankStatement(text);
      if (rows.length > 0) {
        const done = accept({ method: `ai-text:${provider.name}`, transactions: rows, report: validateStatement(rows) });
        if (done) return done;
      }
    } catch (err) {
      warn(`bank: text-AI failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3 ─ vision AI over page images
  const canRender =
    mimeType === "application/pdf" || mimeType === "image/png" || mimeType === "image/jpeg";
  if (provider.name !== "none" && provider.supportsVision && canRender) {
    try {
      const pages =
        mimeType === "application/pdf"
          ? await pdfToPngPages(fileBuffer, { maxPages: MAX_STATEMENT_PAGES })
          : [fileBuffer];
      log(`bank: vision over ${pages.length} page(s) with "${provider.name}"`);
      const v = await extractStatementFromPages(provider, pages, { log: (m) => log(`vision: ${m}`) });
      const report = v.report;
      if (pages.length >= MAX_STATEMENT_PAGES) {
        report.status = "FAILED";
        report.issues.push({ code: "NO_ROWS", message: `Statement has ${MAX_STATEMENT_PAGES}+ pages; extraction may be truncated.` });
      }
      const done = accept({ method: `ai-vision:${provider.name}`, transactions: v.transactions, report });
      if (done) return done;
    } catch (err) {
      warn(`bank: vision failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Nothing verified. Return the least-broken candidate, flagged FAILED, so
  // the pipeline raises a blocking exception — never post silently.
  if (candidates.length > 0) {
    const best = candidates.sort((x, y) => rank(x) - rank(y))[0];
    warn(`bank: no candidate verified; returning best (${best.method}) as FAILED`);
    return { kind: "bank_transactions", method: `${best.method}:unverified`, transactions: best.transactions, report: best.report };
  }

  throw new Error(
    provider.name === "none"
      ? "Bank statement layout not recognised and no AI provider is configured to read it."
      : "Bank statement could not be extracted by the parser, the text AI or the vision AI.",
  );
}

export async function extractInvoice(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<ExtractionResult> {
  const text = await textFromFile(fileBuffer, mimeType);
  log(
    `invoice: textLength=${text.length} first200=${JSON.stringify(text.slice(0, 200))}`,
  );

  const textUsable = text.trim().length >= MIN_USABLE_TEXT_LEN;

  // --- 1. Deterministic pass (only when the text layer is meaningful) ------
  let parserInvoice: ExtractedInvoice | null = null;
  let parserMissing: string[] = [];

  if (textUsable && looksLikeQoyodOrDaftraInvoice(text)) {
    log(`invoice: layout matches Qoyod/Daftra → running deterministic parser`);
    parserInvoice = parseQoyodOrDaftraInvoice(text);
    parserMissing = missingInvoiceFields(parserInvoice);
    log(
      `invoice: parser result number=${parserInvoice.invoiceNumber ?? "∅"} ` +
        `date=${parserInvoice.date ?? "∅"} total=${parserInvoice.amountTotal} ` +
        `cp="${parserInvoice.counterparty ?? "∅"}" ` +
        `direction=${parserInvoice.direction ?? "∅"} ` +
        `missing=[${parserMissing.join(",") || "none"}]`,
    );

    if (parserMissing.length === 0) {
      log(`invoice: parser result is COMPLETE → accepting`);
      return {
        kind: "invoice",
        method: "deterministic:qoyod-daftra",
        invoice: parserInvoice,
      };
    }
    log(
      `invoice: parser result INCOMPLETE (missing ${parserMissing.join(",")})`,
    );
  } else if (!textUsable) {
    log(
      `invoice: text layer too short (${text.trim().length} chars) → deterministic parser skipped`,
    );
  } else {
    log(`invoice: layout not recognized → deterministic parser skipped`);
  }

  // --- 2. AI pass -----------------------------------------------------------
  const provider = getAiProvider();
  if (provider.name === "none") {
    warn(`invoice: no AI provider configured`);
    if (parserInvoice) {
      log(`invoice: returning incomplete parser result (no AI available)`);
      return {
        kind: "invoice",
        method: "deterministic:qoyod-daftra:incomplete",
        invoice: parserInvoice,
      };
    }
    throw new Error(
      "Invoice extraction failed: no deterministic layout matched and no AI provider is configured.",
    );
  }

  // 2a. Vision pass — the ONLY thing that works for "Microsoft: Print To PDF"
  // exports where pdf-parse returns 0-4 characters.
  const canRender =
    mimeType === "application/pdf" ||
    mimeType === "image/png" ||
    mimeType === "image/jpeg";

  if (provider.supportsVision && canRender) {
    try {
      log(`invoice: rendering pages for vision provider "${provider.name}"`);
      const images: InvoiceImage[] =
        mimeType === "application/pdf"
          ? (await pdfToPngPages(fileBuffer)).map((data) => ({
              data,
              mimeType: "image/png" as const,
            }))
          : [
              {
                data: fileBuffer,
                mimeType: mimeType as "image/png" | "image/jpeg",
              },
            ];

      log(`invoice: sending ${images.length} image(s) to vision provider`);
      const aiInvoice = await provider.extractInvoiceFromImages(images);
      if (aiInvoice) {
        log(`invoice: vision AI returned ${JSON.stringify(aiInvoice)}`);
        const v = validateAiInvoice(aiInvoice, text);
        if (v.ok) {
          log(`invoice: vision validation PASSED → accepting`);
          return {
            kind: "invoice",
            method: `ai-vision:${provider.name}`,
            invoice: aiInvoice,
          };
        }
        warn(`invoice: vision validation FAILED: ${v.reason}`);
      } else {
        log(`invoice: vision call returned null (provider has no vision?)`);
      }
    } catch (err) {
      warn(
        `invoice: vision path threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (provider.supportsVision && !canRender) {
    log(
      `invoice: provider has vision but mimeType=${mimeType} can't be rendered`,
    );
  } else {
    log(
      `invoice: provider "${provider.name}" has no vision → skipping vision pass`,
    );
  }

  // 2b. Text-mode AI pass — last attempt. Useless when text layer is empty,
  // so skip it in that case rather than burning a call that will return {}.
  if (textUsable) {
    log(`invoice: calling text-mode AI "${provider.name}"`);
    try {
      const aiInvoice = await provider.extractInvoice(text);
      log(`invoice: text AI returned ${JSON.stringify(aiInvoice)}`);
      const v = validateAiInvoice(aiInvoice, text);
      if (v.ok) {
        log(`invoice: text-AI validation PASSED → accepting`);
        return {
          kind: "invoice",
          method: `ai-text:${provider.name}`,
          invoice: aiInvoice,
        };
      }
      warn(`invoice: text-AI validation FAILED: ${v.reason}`);
    } catch (err) {
      warn(
        `invoice: text-AI threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    log(`invoice: skipping text-mode AI (text layer empty)`);
  }

  // --- 3. Last resort: return the incomplete parser result -----------------
  if (parserInvoice) {
    warn(`invoice: all paths failed → returning incomplete parser result`);
    return {
      kind: "invoice",
      method: "deterministic:qoyod-daftra:incomplete",
      invoice: parserInvoice,
    };
  }

  throw new Error(
    "Invoice extraction failed: no usable text layer, no deterministic layout " +
      "matched, and the AI provider could not produce a validated result.",
  );
}

async function textFromFile(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") {
    const parsed = await pdfParse(buffer);
    log(
      `pdf-parse: pages=${parsed.numpages} chars=${parsed.text.length} ` +
        `producer=${JSON.stringify(parsed.info?.Producer ?? "")}`,
    );
    return parsed.text;
  }
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel"
  ) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    return wb.SheetNames.map((name) =>
      XLSX.utils.sheet_to_csv(wb.Sheets[name]),
    ).join("\n\n");
  }
  if (mimeType.startsWith("text/")) {
    return buffer.toString("utf-8");
  }
  // Images have no text layer; the caller routes to vision.
  return "";
}
