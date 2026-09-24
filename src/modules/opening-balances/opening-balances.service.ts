import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { badRequest } from "@/lib/http-error";
import { readTrialBalance } from "@/modules/import-reader/readTrialBalance";
import type { ColumnTemplate, ParsedAccount, ReadResult } from "@/modules/import-reader/types";
import { accountWhere, addChildAccount, ensureSystemAccount, getChartScope, listChart } from "@/modules/chart/chart.service";
import { matchToTree, type MapResult } from "@/modules/chart/mapping";

/**
 * Step 4 of the journey (spec §4.4) — MANDATORY to decide, optional to upload. One of four modes:
 *   uploaded    a prior-year trial balance in ANY format (read by the universal reader)
 *   manual      typed account by account
 *   first_year  the entity's first year: no opening balances
 *   unavailable "not available now": each bank's opening balance comes from its first statement, the
 *               other side sits in 330103 "أرصدة افتتاحية غير موزعة"; drafts work, final release needs the real TB
 *
 * Opening balances live on Account.openingBalance of THIS file's chart, DEBIT-POSITIVE for every account.
 */

export type OpeningMode = "uploaded" | "manual" | "first_year" | "unavailable";
const r2 = (n: number) => Math.round(n * 100) / 100;

// ── reading + mapping ────────────────────────────────────────────────────

export async function loadTemplate(firmId: string, sourceName?: string | null): Promise<ColumnTemplate | undefined> {
  if (!sourceName) return undefined;
  const t = await prisma.importTemplate.findUnique({ where: { firmId_kind_sourceName: { firmId, kind: "trial_balance", sourceName } } });
  return (t?.template as unknown as ColumnTemplate) ?? undefined;
}

export async function saveTemplate(firmId: string, sourceName: string, template: ColumnTemplate, kind = "trial_balance") {
  const name = sourceName.trim();
  if (!name) throw badRequest("اكتب اسم النظام المصدر (مثل: قيود، دفترة) لحفظ القالب.");
  return prisma.importTemplate.upsert({
    where: { firmId_kind_sourceName: { firmId, kind, sourceName: name } },
    create: { firmId, kind, sourceName: name, template: template as unknown as Prisma.InputJsonObject },
    update: { template: template as unknown as Prisma.InputJsonObject },
  });
}

export type MappingRow = {
  key: string;                      // stable id of the source row
  source: { code: string | null; name: string; balance: number; sourceRow: number };
  status: MapResult["status"];
  targetAccountId: string | null;   // proposed (green/yellow) — null for red
  confidence: number;
  why?: string;
  alternatives: { accountId: string; code: string; name: string; nameAr: string | null; confidence: number }[];
  suggestedParentCode?: string;
};

export async function readAndMap(caseId: string, firmId: string, buf: Buffer, fileName: string, template?: ColumnTemplate) {
  const read = readTrialBalance(buf, fileName, template);
  if (read.status !== "OK") return { read, mapping: [] as MappingRow[], summary: null };
  const mapping = await mapRows(caseId, firmId, read.accounts);
  const g = mapping.filter((m) => m.status === "green").length, y = mapping.filter((m) => m.status === "yellow").length;
  return { read, mapping, summary: { total: mapping.length, green: g, yellow: y, red: mapping.length - g - y } };
}

export async function mapRows(caseId: string, firmId: string, rows: ParsedAccount[]): Promise<MappingRow[]> {
  const scope = await getChartScope(caseId, firmId);
  const chart = await listChart(scope);
  const tree = chart.map((a) => ({ ...a, keywordsAr: a.keywordsAr, keywordsEn: a.keywordsEn }));
  return rows.map((r, i) => {
    const m = matchToTree({ code: r.code, name: r.name }, tree);
    const best = m.best?.account as (typeof chart)[number] | undefined;
    return {
      key: `${r.sourceRow}:${i}`,
      source: { code: r.code, name: r.name, balance: r.balance, sourceRow: r.sourceRow },
      status: m.status,
      targetAccountId: best?.id ?? null,
      confidence: m.best?.confidence ?? 0,
      why: m.best?.why,
      alternatives: m.alternatives.map((c) => ({ accountId: (c.account as { id: string }).id, code: c.account.code, name: c.account.name, nameAr: c.account.nameAr ?? null, confidence: c.confidence })),
      suggestedParentCode: m.suggestedParentCode,
    };
  });
}

export type Decision = {
  key: string;
  action: "map" | "create" | "ignore";
  accountId?: string;
  parentCode?: string;
  newName?: string;
};

export async function applyImport(
  caseId: string,
  firmId: string,
  rows: { key: string; code: string | null; name: string; balance: number }[],
  opts: { decisions?: Decision[]; autoAccept?: boolean; addDifference?: boolean },
) {
  const scope = await getChartScope(caseId, firmId);
  const mapping = await mapRows(caseId, firmId, rows.map((r, i) => ({ code: r.code, name: r.name, balance: r.balance, debit: 0, credit: 0, sourceRow: Number(r.key.split(":")[0]) || i })));
  const byKey = new Map(rows.map((r, i) => [r.key, { row: r, map: mapping[i] }]));
  const decided = new Map((opts.decisions ?? []).map((d) => [d.key, d]));
  const totals = new Map<string, number>();
  const unresolved: string[] = [];
  const created: { code: string; name: string }[] = [];

  for (const [key, { row, map }] of byKey) {
    if (r2(row.balance) === 0) continue;
    let d = decided.get(key);
    if (!d && opts.autoAccept) {
      d = map.status === "green" || map.status === "yellow" || map.targetAccountId
        ? { key, action: "map", accountId: map.targetAccountId ?? undefined }
        : { key, action: "create", parentCode: map.suggestedParentCode, newName: row.name };
    }
    if (!d) { unresolved.push(`${row.code ?? ""} ${row.name}`.trim()); continue; }
    if (d.action === "ignore") continue;
    let accountId = d.accountId;
    if (d.action === "create" || !accountId) {
      const parent = d.parentCode ?? map.suggestedParentCode;
      if (!parent) { unresolved.push(`${row.code ?? ""} ${row.name}`.trim()); continue; }
      const acc = await addChildAccount(scope, { parentCode: parent, name: d.newName ?? row.name });
      accountId = acc.id;
      created.push({ code: acc.code, name: acc.nameAr ?? acc.name });
    }
    totals.set(accountId!, (totals.get(accountId!) ?? 0) + row.balance);
  }
  if (unresolved.length) throw badRequest(`اختر حسابًا مقابلًا لكل حساب في الميزان أولًا. المتبقي: ${unresolved.slice(0, 5).join("، ")}${unresolved.length > 5 ? " …" : ""}`);

  let net = r2([...totals.values()].reduce((s, v) => s + v, 0));
  let differenceAccount: string | null = null;
  if (Math.abs(net) > 0.01) {
    if (!opts.addDifference) {
      return { applied: false as const, difference: net, message: `الميزان المرفوع غير متوازن (الفرق ${Math.abs(net).toLocaleString("en-US")}). أضف الفرق إلى «فروقات التسوية» أو راجع الأسطر.` };
    }
    const diff = await ensureSystemAccount(scope, "reconciliation_differences");
    totals.set(diff.id, (totals.get(diff.id) ?? 0) - net);
    differenceAccount = diff.code;
    net = 0;
  }

  await prisma.$transaction(async (tx) => {
    await tx.account.updateMany({ where: accountWhere(scope), data: { openingBalance: 0 } });
    for (const [id, v] of totals) await tx.account.update({ where: { id }, data: { openingBalance: r2(v) } });
    await tx.case.update({ where: { id: caseId }, data: { openingMode: "uploaded", openingBalancesConfirmed: true, isFirstYear: false } });
  });
  return { applied: true as const, accounts: totals.size, created, differenceAccount };
}

// ── the four modes ───────────────────────────────────────────────────────

export async function setMode(caseId: string, firmId: string, mode: Exclude<OpeningMode, "uploaded">) {
  const scope = await getChartScope(caseId, firmId);
  if (mode === "unavailable") {
    const docs = await prisma.document.findMany({ where: { caseId, firmId, type: "BANK_STATEMENT", bankAccountId: { not: null } }, orderBy: { uploadedAt: "asc" } });
    if (docs.length === 0) throw badRequest("ارفع كشف بنك واحدًا على الأقل ليؤخذ منه الرصيد الافتتاحي.");
    // earliest statement per bank account
    const firstTxn = await prisma.bankTransaction.groupBy({ by: ["documentId"], where: { caseId, firmId }, _min: { date: true } });
    const minDate = new Map(firstTxn.map((f) => [f.documentId, f._min.date?.getTime() ?? Infinity]));
    const earliest = new Map<string, (typeof docs)[number]>();
    for (const d of docs) {
      const cur = earliest.get(d.bankAccountId!);
      if (!cur || (minDate.get(d.id) ?? Infinity) < (minDate.get(cur.id) ?? Infinity)) earliest.set(d.bankAccountId!, d);
    }
    const unallocated = await ensureSystemAccount(scope, "opening_unallocated");
    let total = 0;
    await prisma.$transaction(async (tx) => {
      await tx.account.updateMany({ where: accountWhere(scope), data: { openingBalance: 0 } });
      for (const [bankId, d] of earliest) {
        const ob = Number(d.openingBalance ?? 0);
        total += ob;
        await tx.account.update({ where: { id: bankId }, data: { openingBalance: r2(ob) } });
      }
      await tx.account.update({ where: { id: unallocated.id }, data: { openingBalance: r2(-total) } });
      await tx.case.update({ where: { id: caseId }, data: { openingMode: "unavailable", openingBalancesConfirmed: false } });
    });
    return { mode, banks: earliest.size, unallocated: r2(total), note: "يمكنك المتابعة وتنزيل مسودة القوائم. الإصدار النهائي يتطلب رفع ميزان السنة السابقة أو إدخال الأرصدة." };
  }
  await prisma.$transaction(async (tx) => {
    if (mode === "first_year") await tx.account.updateMany({ where: accountWhere(scope), data: { openingBalance: 0 } });
    await tx.case.update({ where: { id: caseId }, data: { openingMode: mode, openingBalancesConfirmed: true, isFirstYear: mode === "first_year" } });
  });
  return { mode };
}

// ── list / edit / confirm (unchanged contract) ───────────────────────────

export async function listOpeningBalances(caseId: string, firmId: string) {
  const scope = await getChartScope(caseId, firmId);
  const [accounts, kase] = await Promise.all([
    prisma.account.findMany({ where: accountWhere(scope), orderBy: { code: "asc" } }),
    prisma.case.findUnique({ where: { id: caseId } }),
  ]);
  const rows = accounts.filter((a) => a.postable).map((a) => ({ accountId: a.id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, openingBalance: Number(a.openingBalance) }));
  const debit = r2(rows.filter((r) => r.openingBalance > 0).reduce((s, r) => s + r.openingBalance, 0));
  const credit = r2(-rows.filter((r) => r.openingBalance < 0).reduce((s, r) => s + r.openingBalance, 0));
  return {
    mode: (kase?.openingMode ?? null) as OpeningMode | null,
    confirmed: kase?.openingBalancesConfirmed ?? false,
    rows, nonZero: rows.filter((r) => r.openingBalance !== 0).length,
    totals: { debit, credit, difference: r2(debit - credit), balanced: Math.abs(debit - credit) < 0.01 },
  };
}

export async function setOne(caseId: string, firmId: string, accountId: string, balance: number) {
  const scope = await getChartScope(caseId, firmId);
  const acc = await prisma.account.findFirst({ where: { id: accountId, ...accountWhere(scope), postable: true } });
  if (!acc) throw badRequest("الحساب غير موجود أو غير قابل للترحيل.");
  await prisma.account.update({ where: { id: accountId }, data: { openingBalance: r2(balance) } });
  await prisma.case.update({ where: { id: caseId }, data: { openingMode: "manual", openingBalancesConfirmed: false } });
  return listOpeningBalances(caseId, firmId);
}

export async function confirm(caseId: string, firmId: string) {
  const list = await listOpeningBalances(caseId, firmId);
  if (!list.totals.balanced && list.nonZero > 0) {
    throw badRequest(`الأرصدة الافتتاحية غير متوازنة (الفرق ${Math.abs(list.totals.difference).toLocaleString("en-US")}). أضف الفرق إلى «فروقات التسوية» أو راجع الأسطر.`);
  }
  await prisma.case.update({ where: { id: caseId }, data: { openingBalancesConfirmed: true, openingMode: (await prisma.case.findUnique({ where: { id: caseId } }))?.openingMode ?? "manual" } });
  return { confirmed: true };
}

export async function unconfirm(caseId: string, firmId: string) {
  await prisma.case.update({ where: { id: caseId }, data: { openingBalancesConfirmed: false } });
  return { confirmed: false };
}

/** "إضافة الفرق لحساب فروقات": put the imbalance of the typed/uploaded opening balances in 110803. */
export async function addOpeningDifference(caseId: string, firmId: string) {
  const scope = await getChartScope(caseId, firmId);
  const list = await listOpeningBalances(caseId, firmId);
  if (list.totals.balanced) return list;
  const diff = await ensureSystemAccount(scope, "reconciliation_differences");
  const cur = Number(diff.openingBalance);
  await prisma.account.update({ where: { id: diff.id }, data: { openingBalance: r2(cur - list.totals.difference) } });
  return listOpeningBalances(caseId, firmId);
}

export type { ReadResult };
