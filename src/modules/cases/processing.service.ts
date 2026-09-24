import { prisma } from "@/lib/prisma";
import { readFile } from "@/lib/storage";
import {
  extractBankStatement,
  extractInvoice,
} from "@/modules/extraction/extraction.service";
import {
  scoreBestMatch,
  statusForConfidence,
  MatchCandidateInvoice,
} from "@/modules/reconciliation/reconciliation.engine";
import { aiCandidates, classifyCase } from "@/modules/classification/classify-case";
import { enrichStatementRow } from "@/modules/extraction/statementEnricher";
import {
  getAiProvider,
  type CandidateAccount,
  type PatternGroupInput,
  type ClarificationSuggestion,
} from "@/lib/ai-provider";
import { detectPattern } from "@/modules/classification/patternDetector";
import { accountWhere, ensureBankAccount, getChartScope, listChart } from "@/modules/chart/chart.service";
import { buildQuestion } from "@/modules/classification/questions";
import { statementBalances } from "@/modules/extraction/statementValidation";
import type { ExceptionType, Prisma } from "@prisma/client";

/**
 * The full pipeline for a case, in the order the client's own workflow
 * requires:
 *
 *   1. extract every UPLOADED document
 *   2. CLASSIFY every bank transaction — INDEPENDENT of invoices.
 *      Tiers: human rules → statement evidence → seeded rules → batched
 *      LLM → policy fallback (see classification/classify-case.ts).
 *      A bank statement on its own must reach a classified,
 *      confidence-scored list; only genuinely unexplained transfers /
 *      deposits are held back, and they are asked about once per PAYEE.
 *   3. reconcile bank transactions against invoices (deterministic scoring)
 *      — corroborating evidence, not a gate.
 *   4. raise exceptions — split into two lanes:
 *        · blocking   → cannot approve the Trial Balance until resolved
 *                       (low-confidence classification, needs client
 *                        clarification, missing info)
 *        · non-blocking → informational (missing supporting doc, unmatched
 *                       invoice, possible duplicate). These do NOT gate
 *                       the TB — the client's own reference Excel treats
 *                       them as a status column, not a stop-the-pipeline.
 *   5. move the case into EXCEPTIONS (if blocking exceptions were raised)
 *      or IN_REVIEW.
 */

/**
 * Exception types that actually block Trial Balance generation.
 * Everything else is a note for the accountant.
 */
const BLOCKING_EXCEPTIONS: ExceptionType[] = [
  "LOW_CONFIDENCE_CATEGORY",
  "NEEDS_CLIENT_CLARIFICATION",
  "MISSING_INFO",
];

export async function processCase(
  caseId: string,
  firmId: string,
): Promise<void> {
  await prisma.case.update({
    where: { id: caseId },
    data: { status: "PROCESSING" },
  });

  const steps: [string, () => Promise<unknown>][] = [
    ["extract", () => extractPendingDocuments(caseId, firmId)],
    ["pair-refunds", () => pairRefunds(caseId, firmId)],
    ["classify", () => classifyCase(caseId, firmId)],
    ["reconcile", () => reconcileCase(caseId, firmId)],
    ["raise-exceptions", () => raiseExceptions(caseId, firmId)],
  ];

  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Pipeline failed at step "${name}": ${msg}`);
    }
  }

  const blocking = await prisma.exception.count({
    where: { caseId, status: "OPEN", type: { in: BLOCKING_EXCEPTIONS } },
  });
  await prisma.case.update({
    where: { id: caseId },
    data: { status: blocking > 0 ? "EXCEPTIONS" : "IN_REVIEW" },
  });
}

function bankNameFromMethod(method: string | null | undefined): string | null {
  if (!method) return null;
  if (/rajhi/i.test(method)) return "Al Rajhi";
  return null;
}

async function extractPendingDocuments(caseId: string, firmId: string) {
  const documents = await prisma.document.findMany({
    where: { caseId, firmId, status: "UPLOADED" },
  });

  console.log(
    `[extract] found ${documents.length} pending document(s) for case=${caseId}`,
  );

  for (const doc of documents) {
    const label = `[extract] doc=${doc.id} type=${doc.type} name="${doc.fileName}"`;
    console.log(`${label} → status=EXTRACTING`);

    try {
      await prisma.document.update({
        where: { id: doc.id },
        data: { status: "EXTRACTING" },
      });
      const buffer = await readFile({
        storageDriver: doc.storageDriver as "local" | "s3",
        storageKey: doc.storageKey,
      });

      console.log(`${label} → read ${buffer.length} bytes`);

      if (doc.type === "BANK_STATEMENT") {
        const result = await extractBankStatement(buffer, doc.mimeType);
        if (result.kind !== "bank_transactions")
          throw new Error("Unexpected extraction result kind");

        console.log(
          `${label} → bank extraction method=${result.method} rows=${result.transactions.length}`,
        );

        await prisma.bankTransaction.createMany({
          data: result.transactions.map((t, rowIndex) => {
            // Interpret, don't just copy: kind / merchant / payee / typed
            // purpose, plus the stable payee key used for grouping.
            const raw = (t.rawText ?? t.description).replace(/\s+/g, " ").trim();
            const { searchText: _s, ...en } = enrichStatementRow(raw, t.amount);
            return {
              firmId,
              caseId,
              documentId: doc.id,
              date: new Date(t.date),
              // Full bank text, not the parser's lossy label — rules, the LLM,
              // matching and the journal memo all need the merchant / memo.
              description: raw,
              counterparty: t.counterparty ?? en.merchant ?? en.counterparty,
              amount: t.amount,
              reference: t.reference,
              bankLabel: doc.bankName ?? undefined,
              enrichment: en as unknown as Prisma.InputJsonObject,
              beneficiaryKey: en.beneficiaryKey,
              // position in the statement — lets an integrity issue point at a row
              rawRowIndex: rowIndex,
            };
          }),
        });
        // One bank account per statement, under "النقد وما في حكمه" (§4.5), plus the
        // statement's own opening / closing balance for the "unavailable now" opening
        // mode and the release gate (bank = last printed balance).
        const scope = await getChartScope(caseId, firmId);
        const bankAccount = await ensureBankAccount(scope, doc.bankName ?? bankNameFromMethod(result.method));
        const bal = statementBalances(result.transactions, result.report.direction);
        await prisma.document.update({
          where: { id: doc.id },
          data: {
            status: "EXTRACTED",
            extractionMethod: result.method,
            extractionReport: result.report as unknown as Prisma.InputJsonObject,
            bankAccountId: bankAccount.id,
            openingBalance: bal.opening,
            closingBalance: bal.closing,
          },
        });
      } else {
        const result = await extractInvoice(buffer, doc.mimeType);
        if (result.kind !== "invoice")
          throw new Error("Unexpected extraction result kind");

        console.log(
          `${label} → invoice extraction method=${result.method} ` +
            `number=${result.invoice.invoiceNumber ?? "∅"} ` +
            `total=${result.invoice.amountTotal} ` +
            `direction=${result.invoice.direction ?? "∅"} ` +
            `cp="${result.invoice.counterparty ?? "∅"}"`,
        );

        await prisma.invoice.create({
          data: {
            firmId,
            caseId,
            documentId: doc.id,
            invoiceNumber: result.invoice.invoiceNumber,
            date: result.invoice.date
              ? new Date(result.invoice.date)
              : undefined,
            counterparty: result.invoice.counterparty,
            amountBeforeVat: result.invoice.amountBeforeVat,
            vatAmount: result.invoice.vatAmount,
            amountTotal: result.invoice.amountTotal,
            description: result.invoice.description,
            direction: result.invoice.direction ?? "PAYABLE",
          },
        });
        await prisma.document.update({
          where: { id: doc.id },
          data: { status: "EXTRACTED", extractionMethod: result.method },
        });
      }
      console.log(`${label} → status=EXTRACTED`);
    } catch (err) {
      console.error(`${label} → FAILED:`, err);
      await prisma.document.update({
        where: { id: doc.id },
        data: {
          status: "FAILED",
          extractionError: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}

/**
 * Detect refund ↔ original-purchase pairs (Anas feedback #4).
 *
 * A refund (PURCHASE_REFUND / SADAD_REFUND) is paired with the most recent
 * purchase from the same merchant/scheme with a matching amount, within a
 * reasonable time window (default 30 days). The pair is linked via
 * BankTransaction.pairedWithTxnId — when non-null, the reconciliation UI
 * renders the refund as "Refund of {original date · merchant}" instead of
 * treating it as a standalone row.
 *
 * Heuristics:
 *   • Same normalised merchant/counterparty name (or same SADAD bill type)
 *   • |amount| within 1 SAR tolerance (refunds are usually exact)
 *   • Original is within 30 days BEFORE the refund
 *   • Original isn't itself already paired to a different refund
 *
 * Pure detection only — never overwrites an existing pair. Idempotent.
 */
async function pairRefunds(caseId: string, firmId: string): Promise<void> {
  const txns = await prisma.bankTransaction.findMany({
    where: { caseId, firmId },
    orderBy: { date: "asc" },
    select: {
      id: true,
      date: true,
      amount: true,
      description: true,
      counterparty: true,
      enrichment: true,
      pairedWithTxnId: true,
    },
  });

  const normalizeForMatch = (s: string | null | undefined): string =>
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const isRefund = (t: (typeof txns)[number]): boolean => {
    const en = t.enrichment as { kind?: string } | null;
    return en?.kind === "PURCHASE_REFUND" || en?.kind === "SADAD_REFUND";
  };

  const merchantKey = (t: (typeof txns)[number]): string => {
    const en = t.enrichment as { merchant?: string; counterparty?: string } | null;
    return normalizeForMatch(en?.merchant ?? en?.counterparty ?? t.counterparty ?? t.description);
  };

  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  const WINDOW_DAYS = 30;
  const AMOUNT_TOLERANCE = 1.0;

  const refunds = txns.filter(isRefund);
  const purchases = txns.filter((t) => !isRefund(t));

  // Index purchases by merchant key for O(n) lookup.
  const purchasesByMerchant = new Map<string, typeof purchases>();
  for (const p of purchases) {
    const k = merchantKey(p);
    if (!k) continue;
    const arr = purchasesByMerchant.get(k) ?? [];
    arr.push(p);
    purchasesByMerchant.set(k, arr);
  }

  for (const refund of refunds) {
    if (refund.pairedWithTxnId) continue; // already paired — don't overwrite
    const refundAmount = Math.abs(Number(refund.amount));
    const refundMerchant = merchantKey(refund);
    if (!refundMerchant) continue;

    const candidates = purchasesByMerchant.get(refundMerchant) ?? [];
    // Find the closest preceding purchase with matching amount.
    let best: (typeof candidates)[number] | null = null;
    let bestDays = Infinity;
    for (const p of candidates) {
      if (p.pairedWithTxnId) continue; // already paired to another refund
      const pAmount = Math.abs(Number(p.amount));
      if (Math.abs(pAmount - refundAmount) > AMOUNT_TOLERANCE) continue;
      const daysBefore =
        (refund.date.getTime() - p.date.getTime()) / MS_PER_DAY;
      // Original must be BEFORE the refund (daysBefore > 0) and within the window.
      if (daysBefore < 0 || daysBefore > WINDOW_DAYS) continue;
      if (daysBefore < bestDays) {
        bestDays = daysBefore;
        best = p;
      }
    }
    if (best) {
      await prisma.bankTransaction.update({
        where: { id: refund.id },
        data: { pairedWithTxnId: best.id },
      });
    }
  }
}

async function reconcileCase(caseId: string, firmId: string) {
  // Invoice matching is CORROBORATION for the movements that actually
  // belong to a document — customer collections (→ receivables) and the
  // other accounts flagged requiresSupportingDoc. Fees, fuel, POS spend,
  // SADAD, salaries and internal transfers are complete from the statement
  // alone and are never "matched against invoices".
  const scope = await getChartScope(caseId, firmId);
  const docAccounts = await prisma.account.findMany({
    where: { ...accountWhere(scope), requiresSupportingDoc: true },
    select: { id: true },
  });
  const [transactions, invoices] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: {
        caseId,
        firmId,
        matchStatus: "UNMATCHED",
        matchedInvoiceId: null,
        categoryAccountId: { in: docAccounts.map((a) => a.id) },
      },
    }),
    prisma.invoice.findMany({ where: { caseId, firmId } }),
  ]);

  const candidates: MatchCandidateInvoice[] = invoices.map((inv) => ({
    id: inv.id,
    date: inv.date,
    invoiceNumber: inv.invoiceNumber,
    counterparty: inv.counterparty,
    amountTotal: Number(inv.amountTotal),
    direction: inv.direction,
  }));

  for (const txn of transactions) {
    const best = scoreBestMatch(
      {
        id: txn.id,
        date: txn.date,
        description: txn.description,
        amount: Number(txn.amount),
      },
      candidates,
    );

    if (!best) continue;

    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: {
        matchedInvoiceId: best.invoiceId,
        matchConfidence: best.confidence,
        matchStatus: statusForConfidence(best.confidence),
      },
    });
  }
}

const LOW_CONFIDENCE_CUTOFF = 0.7;

const exceptionKey = (
  type: ExceptionType,
  bankTransactionId: string | null,
  invoiceId: string | null,
) => `${type}:${bankTransactionId ?? "-"}:${invoiceId ?? "-"}`;

type StoredEnrichment = {
  kind?: string; isFee?: boolean; pending?: boolean; pendingReason?: string; questionId?: string; suggestedCode?: string;
  merchant?: string; counterparty?: string; memo?: string | null; counterpartyType?: string | null;
};
const nameKey = (v?: string | null) => (v ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function raiseExceptions(caseId: string, firmId: string) {
  const scope = await getChartScope(caseId, firmId);
  const [transactions, invoices, existing, chart, statementDocs, existingClarifications, kase] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { caseId, firmId } }),
    prisma.invoice.findMany({ where: { caseId, firmId } }),
    prisma.exception.findMany({ where: { caseId, firmId }, orderBy: { createdAt: "asc" } }),
    listChart(scope),
    prisma.document.findMany({
      where: { caseId, firmId, type: "BANK_STATEMENT" },
      select: { id: true, fileName: true, extractionReport: true },
    }),
    prisma.clarification.findMany({ where: { caseId, firmId }, select: { bankTransactionId: true, status: true } }),
    prisma.case.findFirst({ where: { id: caseId, firmId }, include: { client: true } }),
  ]);
  const activity = kase?.client.activity ?? "services";
  const materiality = kase?.client.materialityThreshold ?? 200;

  const accounts = chart;
  const requiresDocById = new Map(accounts.map((a) => [a.id, a.requiresSupportingDoc]));
  const accountByCode = new Map(accounts.map((a) => [a.code, a]));
  const existingClarificationTxnIds = new Set(
    existingClarifications.map((c) => c.bankTransactionId).filter((x): x is string => !!x),
  );
  const matchedInvoiceIds = new Set(
    transactions.map((t) => t.matchedInvoiceId).filter((x): x is string => !!x),
  );

  const desired = new Map<
    string,
    {
      type: ExceptionType;
      bankTransactionId?: string;
      invoiceId?: string;
      note?: string;
      questionAr?: string;
      questionId?: string;
      options?: Prisma.InputJsonObject;
      proposedAccountId?: string;
      detectedPattern?: Prisma.InputJsonObject;
      hypothesisReason?: string;
    }
  >();

  // ── 0. Extraction integrity (ONE alert per statement, in Arabic, with a way out) ──
  for (const doc of statementDocs) {
    const rep = doc.extractionReport as
      | { status?: string; acceptedDifference?: unknown; issues?: { index?: number; message: string; messageAr?: string }[] }
      | null;
    if (rep?.status !== "FAILED" || rep.acceptedDifference) continue;
    const issues = rep.issues ?? [];
    const firstIdx = issues.find((i) => i.index != null)?.index;
    const atTxn =
      firstIdx != null ? transactions.find((t) => t.documentId === doc.id && t.rawRowIndex === firstIdx) : undefined;
    desired.set(exceptionKey("MISSING_INFO", atTxn?.id ?? null, null), {
      type: "MISSING_INFO",
      bankTransactionId: atTxn?.id,
      note:
        `الكشف «${doc.fileName}» لم يجتز فحص الأرصدة. ` +
        issues.slice(0, 3).map((i) => i.messageAr ?? i.message).join(" ") +
        (issues.length > 3 ? ` (+${issues.length - 3} تنبيهات أخرى)` : "") +
        " الحلول: صحّح الصف بجانب صورة الصفحة، أو اقبل الفرق في «فروقات التسوية» مع ملاحظة.",
    });
  }

  // ── Unresolved rows → ONE question per (question type × payee/merchant × direction) ──
  const enr = (t: (typeof transactions)[number]) => (t.enrichment ?? {}) as StoredEnrichment;
  const pendingGroups = new Map<string, typeof transactions>();
  for (const txn of transactions) {
    if (txn.categoryAccountId) continue;
    const en = enr(txn);
    if (en.isFee === true || en.kind === "FEE") continue; // fees have their own classification
    const identity = txn.beneficiaryKey ?? nameKey(en.merchant ?? en.counterparty ?? txn.counterparty);
    const key = identity.length >= 3
      ? `g:${en.questionId ?? "Q02"}|${identity}|${Number(txn.amount) < 0 ? "d" : "c"}`
      : `txn:${txn.id}`;
    const g = pendingGroups.get(key) ?? [];
    g.push(txn);
    pendingGroups.set(key, g);
  }
  const groupRep = new Map<string, string>();
  for (const g of pendingGroups.values()) {
    g.sort((x, y) => x.date.getTime() - y.date.getTime());
    for (const t of g) groupRep.set(t.id, g[0].id);
  }
  const groupKeyOfTxn = new Map<string, string>();
  for (const [k, g] of pendingGroups) for (const t of g) groupKeyOfTxn.set(t.id, k);

  // ── Pattern detection + AI question wording for recurring groups (unchanged idea) ──
  const provider = getAiProvider();
  const aiByGroupKey = new Map<string, ClarificationSuggestion>();
  const detectedByGroupKey = new Map<string, Prisma.InputJsonObject>();
  const aiEligibleGroups: PatternGroupInput[] = [];
  for (const [key, group] of pendingGroups) {
    if (key.startsWith("txn:") || group.length < 2) continue;
    const repTxn = group[0];
    if (existingClarificationTxnIds.has(repTxn.id)) continue;
    const detected = detectPattern(
      group.map((t) => ({
        id: t.id, date: t.date, amount: Number(t.amount),
        enrichment: t.enrichment as { kind?: string | null; counterpartyType?: string | null; memo?: string | null } | null,
        counterparty: t.counterparty, description: t.description,
      })),
    );
    if (detected) detectedByGroupKey.set(key, detected as unknown as Prisma.InputJsonObject);
    aiEligibleGroups.push({
      id: key,
      payee: repTxn.beneficiaryKey ?? null,
      payeeLabel: repTxn.counterparty ?? null,
      direction: Number(repTxn.amount) < 0 ? "outflow" : "inflow",
      detectedPattern: detected,
      transactions: group.map((t) => ({
        date: t.date.toISOString().slice(0, 10), amount: Number(t.amount), memo: enr(t).memo ?? null, description: t.description.slice(0, 200),
      })),
      occurrences: group.length,
      totalAbs: group.reduce((a, t) => a + Math.abs(Number(t.amount)), 0),
    });
  }
  if (provider.name !== "none" && aiEligibleGroups.length > 0) {
    const candidates: CandidateAccount[] = aiCandidates(accounts);
    try {
      const suggestions = await provider.suggestClarificationQuestion(aiEligibleGroups, candidates);
      for (const s of suggestions) aiByGroupKey.set(s.id, s);
    } catch (err) {
      console.warn("[raise-exceptions] AI clarification-question call failed:", err instanceof Error ? err.message : err);
    }
  }

  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  for (const txn of transactions) {
    const conf = Number(txn.categoryConfidence);
    const hasCategory = !!txn.categoryAccountId;

    // 1. Unresolved → a multiple-choice question (representative of its group only).
    if (!hasCategory) {
      if (groupRep.get(txn.id) !== txn.id) continue;
      const groupKey = groupKeyOfTxn.get(txn.id) ?? `txn:${txn.id}`;
      const group = pendingGroups.get(groupKey)!;
      const total = group.reduce((a, t) => a + Math.abs(Number(t.amount)), 0);
      const first = group[0].date.toISOString().slice(0, 10);
      const last = group[group.length - 1].date.toISOString().slice(0, 10);
      const en = enr(txn);
      const payee = txn.counterparty ?? en.merchant ?? "طرف غير مسمّى";
      const n = group.length;
      const outflow = Number(txn.amount) < 0;
      const question = buildQuestion(en.questionId ?? "Q02", chart, activity);
      const suggested = en.suggestedCode ? accountByCode.get(en.suggestedCode) : undefined;

      const aiSuggestion = aiByGroupKey.get(groupKey);
      const aiProposed = aiSuggestion?.proposedAccountCode ? accountByCode.get(aiSuggestion.proposedAccountCode) : undefined;
      const useHypothesis = !!(aiSuggestion?.needsClientConfirm && aiSuggestion.confidence >= 0.5 && aiProposed);
      const proposed = useHypothesis ? aiProposed : suggested;
      const small = total < materiality;

      const who = `«${payee}»`;
      const lead = n > 1
        ? `${n} عمليات بإجمالي ${fmt(total)} ريال ${outflow ? "إلى" : "من"} ${who} (${first} – ${last}). `
        : `${fmt(Math.abs(Number(txn.amount)))} ريال ${outflow ? "إلى" : "من"} ${who} بتاريخ ${first}. `;

      desired.set(exceptionKey("NEEDS_CLIENT_CLARIFICATION", txn.id, null), {
        type: "NEEDS_CLIENT_CLARIFICATION",
        bankTransactionId: txn.id,
        note:
          aiSuggestion?.questionEn ??
          (n > 1
            ? `${n} ${outflow ? "payments totalling" : "inflows totalling"} ${fmt(total)} SAR ${outflow ? "to" : "from"} ${payee} (${first} → ${last}). `
            : `${fmt(Math.abs(Number(txn.amount)))} SAR ${outflow ? "paid to" : "received from"} ${payee} on ${first}. `) +
            `${en.pendingReason ?? "The statement gives no purpose."}` + (n > 1 ? " One answer applies to all of them." : ""),
        questionAr: aiSuggestion?.questionAr ?? `${lead}${question.textAr}${n > 1 ? " إجابة واحدة تُطبَّق على الجميع." : ""}`,
        questionId: question.questionId,
        options: {
          question: question as unknown as Prisma.InputJsonObject,
          count: n, total: Math.round(total * 100) / 100, small, suggestedCode: proposed?.code ?? null,
          txnIds: group.map((t) => t.id),
        } as unknown as Prisma.InputJsonObject,
        proposedAccountId: proposed?.id,
        detectedPattern: detectedByGroupKey.get(groupKey),
        hypothesisReason: useHypothesis ? (aiSuggestion?.reason ?? undefined) : en.pendingReason,
      });
      continue;
    }

    // 2. Low confidence → quick review (informational; never stops the Trial Balance).
    if (conf < LOW_CONFIDENCE_CUTOFF) {
      desired.set(exceptionKey("LOW_CONFIDENCE_CATEGORY", txn.id, null), { type: "LOW_CONFIDENCE_CATEGORY", bankTransactionId: txn.id });
    }

    // 3. Missing supporting doc — only for accounts that need one, and only once invoices exist.
    const needsDoc = requiresDocById.get(txn.categoryAccountId!) ?? false;
    if (invoices.length > 0 && needsDoc && txn.matchStatus !== "MATCHED") {
      desired.set(exceptionKey("MISSING_SUPPORTING_DOC", txn.id, null), {
        type: "MISSING_SUPPORTING_DOC",
        bankTransactionId: txn.id,
        note: "Classification is high-confidence, but this account requires a supporting document.",
      });
    }
  }

  for (const inv of invoices) {
    if (!matchedInvoiceIds.has(inv.id)) {
      desired.set(exceptionKey("UNMATCHED_INVOICE", null, inv.id), { type: "UNMATCHED_INVOICE", invoiceId: inv.id });
    }
  }
  const dupSeen = new Map<string, string>();
  for (const inv of invoices) {
    const k = `${inv.counterparty ?? ""}::${Number(inv.amountTotal).toFixed(2)}`;
    const first = dupSeen.get(k);
    if (first !== undefined) {
      desired.set(exceptionKey("POSSIBLE_DUPLICATE", null, inv.id), {
        type: "POSSIBLE_DUPLICATE", invoiceId: inv.id, note: `Same counterparty and amount as invoice ${first}.`,
      });
    } else dupSeen.set(k, inv.invoiceNumber ?? inv.id);
  }

  const everRaised = new Set(existing.map((e) => exceptionKey(e.type, e.bankTransactionId, e.invoiceId)));
  for (const [k, d] of desired) {
    if (everRaised.has(k)) continue;
    await prisma.exception.create({
      data: { firmId, caseId, type: d.type, bankTransactionId: d.bankTransactionId, invoiceId: d.invoiceId, note: d.note, status: "OPEN" },
    });
    everRaised.add(k);

    if (d.type === "NEEDS_CLIENT_CLARIFICATION" && d.bankTransactionId && !existingClarificationTxnIds.has(d.bankTransactionId)) {
      await prisma.clarification.create({
        data: {
          firmId, caseId, bankTransactionId: d.bankTransactionId,
          question: d.note ?? "Please explain what this transaction was for.",
          questionAr: d.questionAr ?? "الرجاء توضيح طبيعة هذه الحركة.",
          questionId: d.questionId ?? null,
          options: d.options ?? undefined,
          proposedAccountId: d.proposedAccountId ?? null,
          detectedPattern: d.detectedPattern ?? undefined,
          hypothesisReason: d.hypothesisReason ?? null,
          status: "OPEN",
        },
      });
    }
  }

  // Collapse duplicate opens, close out-of-date ones.
  const keptOpenByKey = new Map<string, string>();
  for (const e of existing) {
    if (e.status !== "OPEN") continue;
    const k = exceptionKey(e.type, e.bankTransactionId, e.invoiceId);
    if (!keptOpenByKey.get(k)) keptOpenByKey.set(k, e.id);
    else {
      await prisma.exception.update({
        where: { id: e.id },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: "system", note: "Merged — duplicate of an identical open exception." },
      });
    }
  }
  for (const e of existing) {
    if (e.status !== "OPEN") continue;
    if (desired.has(exceptionKey(e.type, e.bankTransactionId, e.invoiceId))) continue;
    await prisma.exception.update({ where: { id: e.id }, data: { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: "system" } });
  }
}


/**
 * "أعد التصنيف": drop every automatic decision (rule / AI) and run the engine again, so client rules
 * added a minute ago apply to the file at once. Rows the accountant decided by hand are left alone.
 */
export async function reclassifyCase(caseId: string, firmId: string) {
  await prisma.bankTransaction.updateMany({
    where: { caseId, firmId, categoryAccountId: { not: null }, OR: [{ categorySource: null }, { categorySource: { not: "MANUAL" } }] },
    data: { categoryAccountId: null, categoryConfidence: 0, categorySource: null },
  });
  const result = await classifyCase(caseId, firmId);
  await raiseExceptions(caseId, firmId);
  return result;
}
