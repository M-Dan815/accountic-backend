import type { Account, Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import {
  getAiProvider,
  type AiProvider,
  type BatchCategoryItem,
  type BatchCategorySuggestion,
  type CandidateAccount,
} from "@/lib/ai-provider";
import {
  configureClientIdentity,
  enrichStatementRow,
  normalizeForSearch,
  type Enrichment,
} from "@/modules/extraction/statementEnricher";
import { getChartScope, listChart } from "@/modules/chart/chart.service";
import { resolveStd } from "@/modules/chart/resolve";
import { STD_BY_CODE, SYS, THRESHOLDS } from "@/modules/chart/standard";
import {
  classifyRow,
  defaultQuestion,
  type EngineContext,
  type EngineRule,
  type Outcome,
  type Target,
} from "./engine";
import { detectPattern } from "./patternDetector";

const AI_BATCH_SIZE = 20;
const AI_CONCURRENCY = 3;
const AI_MAX_CONFIDENCE = 0.85;
const MIN_ASSIGN = THRESHOLDS.auto_with_review; // 0.70

type Pending = {
  reason: string;
  questionId: string;
  suggestedCode?: string;
  suggestedConfidence?: number;
};
type Final =
  | {
      kind: "assign";
      account: Account;
      confidence: number;
      source: "RULE" | "AI";
      reasonSource: string;
      reason: string;
      needsConfirm?: boolean;
    }
  | { kind: "pending"; pending: Pending };

const isPurchase = (k: string) =>
  k === "POS_PURCHASE" || k === "ONLINE_PURCHASE" || k === "PURCHASE_REFUND";
const isRefund = (k: string) => k === "PURCHASE_REFUND" || k === "SADAD_REFUND";

function signatureOf(e: Enrichment, amount: number): string {
  let party = normalizeForSearch(e.merchant ?? e.counterparty ?? "");

  // FIX: Force all ATM transactions to group together, ignoring the specific branch name.
  if (e.kind === "ATM_DEPOSIT" || e.kind === "ATM_WITHDRAWAL") {
    party = "atm_machine";
  }

  const genericMemo = (e.memo ?? "")
    .replace(/\d+/g, "")
    .replace(/[()\-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return [e.kind, amount < 0 ? "out" : "in", party, genericMemo].join("|");
}

function customerNames(
  invoices: { counterparty: string | null; direction: string }[],
) {
  const out = new Set<string>();
  const noise = new Set([
    "شركه",
    "مؤسسه",
    "للخدمات",
    "اللوجستيه",
    "التجاريه",
    "ال",
  ]);
  for (const inv of invoices) {
    if (inv.direction !== "RECEIVABLE" || !inv.counterparty) continue;
    const full = normalizeForSearch(inv.counterparty);
    out.add(full);
    const core = full
      .split(" ")
      .filter((w) => !noise.has(w))
      .join(" ")
      .trim();
    if (core.length >= 4) out.add(core);
  }
  return [...out];
}

export type ClassifyDeps = {
  db?: Prisma.TransactionClient;
  provider?: AiProvider;
};

function toEngineRule(
  r: {
    id: string;
    matchText: string;
    ruleKind: string;
    accountId: string | null;
    accountCode: string | null;
    accountStdKey: string | null;
    direction: string | null;
    minAmount: unknown;
    maxAmount: unknown;
  },
  chart: Account[],
): EngineRule | null {
  const acct =
    (r.accountStdKey
      ? chart.find(
          (a) =>
            a.stdKey === r.accountStdKey &&
            a.postable &&
            (r.accountStdKey !== "cash.bank" || a.code === r.accountCode),
        )
      : undefined) ??
    (r.accountCode
      ? chart.find((a) => a.code === r.accountCode && a.postable)
      : undefined) ??
    (r.accountId ? chart.find((a) => a.id === r.accountId) : undefined);
  if (!acct) return null;
  return {
    id: r.id,
    kind: r.ruleKind,
    matchText: r.matchText,
    target: { accountId: acct.id },
    direction: (r.direction as "debit" | "credit" | null) ?? null,
    minAmount: r.minAmount != null ? Number(r.minAmount) : null,
    maxAmount: r.maxAmount != null ? Number(r.maxAmount) : null,
  };
}

export function aiCandidates(chart: Account[]): CandidateAccount[] {
  const blocked = new Set([
    "other_exp.misc",
    "system.suspense",
    "system.recon_diff",
    "equity.opening_unallocated",
    "equity.current_year",
  ]);
  return chart
    .filter((a) => a.postable && a.active && !blocked.has(a.stdKey ?? ""))
    .map((a) => ({
      code: a.code,
      name: a.name,
      nameAr: a.nameAr,
      type: a.type as CandidateAccount["type"],
    }));
}

export async function classifyCase(
  caseId: string,
  firmId: string,
  deps: ClassifyDeps = {},
) {
  const db = deps.db ?? defaultPrisma;
  const scope = await getChartScope(caseId, firmId, db);
  const chart = await listChart(scope, db);
  const kase = await db.case.findFirst({
    where: { id: caseId, firmId },
    include: { client: true },
  });
  const client = kase?.client;
  configureClientIdentity(client?.name);

  const [transactions, rules, invoices] = await Promise.all([
    db.bankTransaction.findMany({
      where: { caseId, firmId, categoryAccountId: null },
      orderBy: { date: "asc" },
    }),
    db.classificationRule.findMany({
      where: {
        firmId,
        OR: [{ clientId: null }, ...(client ? [{ clientId: client.id }] : [])],
      },
    }),
    db.invoice.findMany({
      where: { caseId, firmId },
      select: { counterparty: true, direction: true },
    }),
  ]);
  const byId = new Map(chart.map((a) => [a.id, a]));

  const isSeed = (r: { createdFrom: string | null }) =>
    !!r.createdFrom?.startsWith("seed");
  const clientRules: EngineRule[] = [],
    memoryRules: EngineRule[] = [];
  const sadadBillers = new Map<string, Target>();
  for (const r of rules) {
    if (isSeed(r)) continue;
    const er = toEngineRule(r as never, chart);
    if (!er) continue;
    if (r.ruleKind === "sadad_biller") {
      sadadBillers.set(r.matchText, er.target);
      continue;
    }
    (r.createdFrom?.startsWith("client-rule") && r.clientId
      ? clientRules
      : memoryRules
    ).push(er);
  }
  const ctx: EngineContext = {
    activity: client?.activity ?? "services",
    clientRules,
    memoryRules,
    knownCustomers: customerNames(invoices),
    sadadBillers,
  };

  const outcome = new Map<string, Outcome | null>();
  const enrichments = new Map<string, Enrichment>();
  const queue = new Map<string, string[]>();
  const items = new Map<string, BatchCategoryItem>();
  const unclassifiedByCounterparty = new Map<string, typeof transactions>();

  for (const txn of transactions) {
    const amount = Number(txn.amount);
    const e = enrichStatementRow(txn.description, amount);

    // ─── PATCH: Extract counterparty from "حوالة فورية" (Instant Transfer) memos ──
    // The bank puts the beneficiary name in the memo for instant transfers.
    // Extracting it ensures they group with internal transfers to the same person.
    if (!e.counterparty && txn.description.includes("حوالة فورية")) {
      const parts = txn.description.split("/");
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i].trim();
        if (
          /[\u0600-\u06FF]/.test(part) &&
          !part.includes("سداد") &&
          !part.includes("نظام") &&
          !part.includes("رسوم") &&
          !part.includes("شركة نخلة الخليج") &&
          part.length > 2
        ) {
          e.counterparty = part;
          break;
        }
      }
    }

    enrichments.set(txn.id, e);
    const o = classifyRow(
      {
        description: txn.description,
        amount,
        e,
        beneficiaryKey: e.beneficiaryKey ?? null,
        counterparty: txn.counterparty ?? e.counterparty ?? null,
      },
      ctx,
    );
    outcome.set(txn.id, o);

    if (o) continue;

    const cpKey = (e.counterparty || e.merchant || "unknown")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (!unclassifiedByCounterparty.has(cpKey)) {
      unclassifiedByCounterparty.set(cpKey, []);
    }
    unclassifiedByCounterparty.get(cpKey)!.push(txn);

    const sig = signatureOf(e, amount);
    const ids = queue.get(sig);
    if (ids) {
      ids.push(txn.id);
      items.get(sig)!.occurrences = ids.length;
    } else {
      queue.set(sig, [txn.id]);
      items.set(sig, {
        id: sig,
        date: txn.date.toISOString().slice(0, 10),
        amount,
        kind: e.kind,
        description: txn.description.replace(/\s+/g, " ").slice(0, 300),
        merchant: e.merchant,
        counterparty: e.counterparty,
        counterpartyType: e.counterpartyType,
        memo: e.memo,
        occurrences: 1,
      });
    }
  }

  for (const [cpKey, txns] of unclassifiedByCounterparty.entries()) {
    if (txns.length >= 2) {
      const pattern = detectPattern(
        txns.map((t) => ({
          id: t.id,
          date: t.date,
          amount: Number(t.amount),
          enrichment: enrichments.get(t.id) ?? undefined,
          counterparty: t.counterparty,
          description: t.description,
        })),
      );

      if (pattern) {
        for (const txn of txns) {
          const sig = signatureOf(enrichments.get(txn.id)!, Number(txn.amount));
          const item = items.get(sig);
          if (item) {
            item.description = `[Pattern: ${pattern.summary}] ${item.description}`;
          }
        }
      }
    }
  }

  const provider = deps.provider ?? getAiProvider();
  const candidates = aiCandidates(chart);
  const queued = [...queue.entries()].map(([sig, txnIds], i) => ({
    sig,
    txnIds,
    item: { ...items.get(sig)!, id: `t${i}` },
  }));
  const suggestions = new Map<string, BatchCategorySuggestion>();
  let aiFailed = 0;
  if (provider.name !== "none" && queued.length > 0) {
    const batches: (typeof queued)[] = [];
    for (let i = 0; i < queued.length; i += AI_BATCH_SIZE)
      batches.push(queued.slice(i, i + AI_BATCH_SIZE));
    let cursor = 0;
    const worker = async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor++];
        try {
          const res = await provider.suggestCategoryBatch(
            batch.map((b) => b.item),
            candidates,
          );
          const map = new Map(res.map((r) => [r.id, r]));
          for (const b of batch) {
            const r = map.get(b.item.id);
            if (r) suggestions.set(b.sig, r);
          }
        } catch (err) {
          aiFailed += batch.length;
          console.warn(
            `[classify] AI batch of ${batch.length} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: AI_CONCURRENCY }, worker));
  }
  const candidateCodes = new Set(candidates.map((c) => c.code));

  const misc = resolveStd(chart, "530901");
  const finals = new Map<string, Final>();
  const stats: Record<string, number> = {
    assigned: 0,
    ai: 0,
    pending: 0,
    review: 0,
  };

  const resolveTarget = (t: Target): Account | undefined =>
    t.accountId
      ? byId.get(t.accountId)
      : t.stdCode
        ? resolveStd(chart, t.stdCode)
        : undefined;
  const pendingFor = (
    e: Enrichment,
    amount: number,
    o: Extract<Outcome, { decision: "question" }> | null,
    reason: string,
    aiSug?: BatchCategorySuggestion,
  ): Pending => {
    const dir = amount < 0 ? "debit" : "credit";
    const qid = o?.questionId ?? defaultQuestion(e, dir);
    let suggested = o?.suggested ? resolveTarget(o.suggested) : undefined;
    if (
      !suggested &&
      aiSug?.accountCode &&
      candidateCodes.has(aiSug.accountCode)
    )
      suggested = chart.find((a) => a.code === aiSug.accountCode);
    if (!suggested && isPurchase(e.kind) && misc) suggested = misc;
    return {
      reason,
      questionId: qid,
      suggestedCode: suggested?.code,
      suggestedConfidence: o?.confidence,
    };
  };

  for (const txn of transactions) {
    const e = enrichments.get(txn.id)!;
    const amount = Number(txn.amount);
    const o = outcome.get(txn.id) ?? null;

    if (o?.decision === "assign") {
      const acct = resolveTarget(o.target);
      if (acct && acct.stdKey !== "other_exp.misc") {
        stats.assigned++;
        if (o.confidence < THRESHOLDS.auto) stats.review++;
        finals.set(txn.id, {
          kind: "assign",
          account: acct,
          confidence: o.confidence,
          source: "RULE",
          reasonSource: o.stage,
          reason: o.reason,
          needsConfirm: o.needsConfirm,
        });
        continue;
      }
      finals.set(txn.id, {
        kind: "pending",
        pending: pendingFor(
          e,
          amount,
          null,
          `${o.reason} — لا يوجد حساب مقابل في شجرة هذا الملف، اختر حسابًا أو أنشئ حسابًا جديدًا`,
        ),
      });
      stats.pending++;
      continue;
    }
    if (o?.decision === "question") {
      finals.set(txn.id, {
        kind: "pending",
        pending: pendingFor(e, amount, o, o.reason),
      });
      stats.pending++;
      continue;
    }
    const sig = signatureOf(e, amount);
    const sug = suggestions.get(sig);
    const acct =
      sug?.accountCode && candidateCodes.has(sug.accountCode)
        ? chart.find((a) => a.code === sug.accountCode)
        : undefined;
    if (sug && acct && !sug.needsClient && sug.confidence >= MIN_ASSIGN) {
      stats.assigned++;
      stats.ai++;
      finals.set(txn.id, {
        kind: "assign",
        account: acct,
        confidence: Math.min(AI_MAX_CONFIDENCE, sug.confidence),
        source: "AI",
        reasonSource: "ai",
        reason: sug.reason,
      });
      continue;
    }
    const why =
      sug?.reason ??
      (provider.name === "none"
        ? "لا توجد قاعدة مطابقة ولم يُضبط مزود الذكاء الاصطناعي"
        : aiFailed
          ? "تعذّر الاتصال بالذكاء الاصطناعي"
          : "لم نستطع تحديد الغرض من نص الكشف");
    finals.set(txn.id, {
      kind: "pending",
      pending: pendingFor(e, amount, null, why, sug),
    });
    stats.pending++;
  }

  for (const txn of transactions) {
    const e = enrichments.get(txn.id)!;
    const paired = (txn as { pairedWithTxnId?: string | null }).pairedWithTxnId;
    if (!isRefund(e.kind) || !paired) continue;
    const orig =
      finals.get(paired) ??
      (() => {
        const t = transactions.find((x) => x.id === paired);
        return t?.categoryAccountId
          ? ({
              kind: "assign",
              account: byId.get(t.categoryAccountId)!,
            } as Final)
          : undefined;
      })();
    if (orig?.kind === "assign" && orig.account)
      finals.set(txn.id, {
        kind: "assign",
        account: orig.account,
        confidence: 0.9,
        source: "RULE",
        reasonSource: "auto_match",
        reason: "استرداد يعكس عملية سابقة — نفس حساب العملية الأصلية",
      });
  }

  for (const txn of transactions) {
    const e = enrichments.get(txn.id)!;
    const { searchText: _omit, ...storable } = e;
    const f = finals.get(txn.id);
    const common = {
      beneficiaryKey: e.beneficiaryKey ?? null,
      counterparty: txn.counterparty ?? e.merchant ?? e.counterparty ?? null,
    };
    if (!f || f.kind === "pending") {
      const p =
        f?.kind === "pending"
          ? f.pending
          : {
              reason: "غير مصنف",
              questionId: defaultQuestion(
                e,
                Number(txn.amount) < 0 ? "debit" : "credit",
              ),
            };
      await db.bankTransaction.update({
        where: { id: txn.id },
        data: {
          ...common,
          enrichment: {
            ...storable,
            pending: true,
            pendingReason: p.reason,
            questionId: p.questionId,
            suggestedCode: p.suggestedCode,
          } as unknown as Prisma.InputJsonObject,
          categoryConfidence: 0,
          categoryReason: p.reason,
          categoryReasonSource: "pending",
        },
      });
      continue;
    }
    await db.bankTransaction.update({
      where: { id: txn.id },
      data: {
        ...common,
        enrichment: {
          ...storable,
          needsConfirm: f.needsConfirm ?? false,
        } as unknown as Prisma.InputJsonObject,
        categoryAccountId: f.account.id,
        categoryConfidence: f.confidence,
        categorySource: f.source,
        categoryReason: f.reason,
        categoryReasonSource: f.reasonSource,
      },
    });
  }

  console.log(
    `[classify] rows=${transactions.length} assigned=${stats.assigned} (ai=${stats.ai}, quick-review=${stats.review}) ` +
      `pending=${stats.pending} · AI signatures=${queued.length} failed=${aiFailed}`,
  );
  return { rows: transactions.length, ...stats };
}

export { SYS, STD_BY_CODE };
