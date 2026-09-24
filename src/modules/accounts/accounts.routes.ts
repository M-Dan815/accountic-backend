import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { notFound, badRequest } from "@/lib/http-error";
import { accountWhere, addChildAccount, getChartScope, listChart } from "@/modules/chart/chart.service";
import { pathOf, searchAccounts } from "@/modules/chart/accountSearch";
import { installClientTree, proposeTreeMapping } from "@/modules/chart/tree-import.service";
import { readChartTree } from "@/modules/import-reader/readChartTree";
import { loadTemplate, saveTemplate } from "@/modules/opening-balances/opening-balances.service";

export const accountsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/** Resolve the chart a request means: ?caseId=… → that file's chart; none → legacy firm-level accounts. */
async function scopeOf(req: { query: Record<string, unknown>; auth?: { firmId: string } }) {
  const firmId = req.auth!.firmId;
  const caseId = typeof req.query.caseId === "string" ? req.query.caseId : null;
  return caseId ? getChartScope(caseId, firmId) : { firmId, caseId: null, mode: "legacy" as const };
}

/**
 * The account picker (spec §4.6). ?caseId=…&q=… — postable accounts only, matched by number, Arabic/English
 * name or keyword with spelling tolerance; `suggested` first when given, then the user's last 5 accounts.
 * Without q it returns the whole chart (never empty: a file's chart is created with it).
 */
accountsRouter.get("/", async (req, res) => {
  const scope = await scopeOf(req);
  const chart = await listChart(scope);
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  if (q === undefined && req.query.picker !== "true") { res.json(chart); return; }
  const byCode = new Map(chart.map((a) => [a.code, a]));
  const withPath = (a: (typeof chart)[number]) => ({ ...a, path: pathOf(a.code, byCode) });
  const found = searchAccounts(chart, q ?? "", 40).map(withPath);
  let recent: ReturnType<typeof withPath>[] = [];
  if (scope.caseId && !q) {
    const last = await prisma.bankTransaction.findMany({
      where: { caseId: scope.caseId, firmId: scope.firmId, categorySource: "MANUAL", categoryAccountId: { not: null } },
      orderBy: [{ reviewedAt: "desc" }, { createdAt: "desc" }], take: 60, select: { categoryAccountId: true },
    });
    const ids = [...new Set(last.map((l) => l.categoryAccountId!))].slice(0, 5);
    recent = ids.map((id) => chart.find((a) => a.id === id)).filter((a): a is (typeof chart)[number] => !!a).map(withPath);
  }
  const suggested = typeof req.query.suggested === "string" ? chart.find((a) => a.code === req.query.suggested && a.postable) : undefined;
  res.json({ suggested: suggested ? withPath(suggested) : null, recent, results: found, canCreate: true });
});

/** Collapsible tree (level, parent, postable) for the "تصفح الشجرة" screen. */
accountsRouter.get("/tree", async (req, res) => {
  const scope = await scopeOf(req);
  const chart = await listChart(scope);
  const used = await prisma.journalLine.groupBy({ by: ["accountId"], where: scope.caseId ? { caseId: scope.caseId, firmId: scope.firmId } : { firmId: scope.firmId } });
  const usedSet = new Set(used.map((u) => u.accountId));
  res.json({ mode: scope.mode, accounts: chart.map((a) => ({ ...a, hasMovements: usedSet.has(a.id) })) });
});

const createSchema = z.object({ caseId: z.string(), parentCode: z.string(), name: z.string().min(2), nameAr: z.string().optional(), keywords: z.array(z.string()).optional() });
/** "+ حساب جديد" — the account exists and is selectable immediately. */
accountsRouter.post("/", async (req, res) => {
  const b = createSchema.parse(req.body);
  const scope = await getChartScope(b.caseId, req.auth!.firmId);
  res.status(201).json(await addChildAccount(scope, b));
});

const patchSchema = z.object({ name: z.string().min(1).optional(), nameAr: z.string().min(1).optional(), active: z.boolean().optional(), fsLine: z.string().min(1).optional(), fsLineEn: z.string().optional() });
/** Rename · disable an unused account · change the statement line. Accounts with movements are never removed. */
accountsRouter.patch("/:accountId", async (req, res) => {
  const acc = await prisma.account.findFirst({ where: { id: req.params.accountId, firmId: req.auth!.firmId } });
  if (!acc) throw notFound("Account not found");
  const b = patchSchema.parse(req.body);
  if (b.active === false) {
    if (acc.systemLocked) throw badRequest("هذا حساب نظام ولا يمكن تعطيله.");
    const [lines, txns] = await Promise.all([
      prisma.journalLine.count({ where: { accountId: acc.id } }),
      prisma.bankTransaction.count({ where: { categoryAccountId: acc.id } }),
    ]);
    if (lines + txns > 0) throw badRequest("لا يمكن تعطيل حساب عليه حركات.");
  }
  res.json(await prisma.account.update({ where: { id: acc.id }, data: b }));
});

/** Download the tree as Excel (any time). */
accountsRouter.get("/export", async (req, res) => {
  const scope = await scopeOf(req);
  const chart = await listChart(scope);
  const ws = XLSX.utils.aoa_to_sheet([
    ["الرقم", "الاسم بالعربي", "Name", "الحساب الأب", "المستوى", "النوع", "الطبيعة", "بند القوائم", "قابل للترحيل"],
    ...chart.map((a) => [a.code, a.nameAr ?? "", a.name, a.parentCode ?? "", a.level ?? "", a.type, a.nature ?? "", a.fsLine ?? "", a.postable ? "نعم" : "لا"]),
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "شجرة الحسابات");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="chart-of-accounts.xlsx"');
  res.send(buf);
});

/** Upload the client's own tree (any Excel/CSV, or a trial balance). Returns the proposed link to the standard tree. */
accountsRouter.post("/tree/read", upload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest("لم يتم رفع ملف. ارفع شجرة الحسابات (Excel أو CSV).");
  const template = await loadTemplate(req.auth!.firmId, req.body.sourceName);
  const read = readChartTree(req.file.buffer, req.file.originalname, template);
  res.json({ read, proposals: read.status === "OK" ? proposeTreeMapping(read.accounts) : [] });
});
accountsRouter.post("/tree/read-manual", upload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest("لم يتم رفع ملف.");
  const template = z.object({ sheet: z.string().optional(), headerRows: z.array(z.number()).optional(), dataStartRow: z.number(), roles: z.record(z.string(), z.string()) }).parse(JSON.parse(String(req.body.template ?? "{}")));
  const read = readChartTree(req.file.buffer, req.file.originalname, template as never);
  if (read.status === "OK" && String(req.body.saveTemplate) === "true" && req.body.sourceName) await saveTemplate(req.auth!.firmId, String(req.body.sourceName), template as never, "chart");
  res.json({ read, proposals: read.status === "OK" ? proposeTreeMapping(read.accounts) : [] });
});
const installSchema = z.object({
  caseId: z.string(),
  accounts: z.array(z.object({
    code: z.string(), name: z.string(), parentCode: z.string().nullable(), postable: z.boolean(),
    typeHint: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]).nullable(), stdCode: z.string().nullable().optional(), fsLine: z.string().nullable().optional(),
  })).min(2),
});
/** "اعتماد الربط" — the whole system now works on the client's tree. */
accountsRouter.post("/tree/install", async (req, res) => {
  const b = installSchema.parse(req.body);
  res.status(201).json(await installClientTree(b.caseId, req.auth!.firmId, b.accounts));
});

accountsRouter.get("/classification-rules", async (req, res) => {
  const rules = await prisma.classificationRule.findMany({
    where: { firmId: req.auth!.firmId, ...(typeof req.query.clientId === "string" ? { clientId: req.query.clientId } : {}) },
    include: { account: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(rules);
});

// ─── Client rules (spec §4.3): condition → account, highest priority, applied at once ───
const ruleCreateSchema = z.object({
  clientId: z.string(),
  matchText: z.string().min(1),                       // text · beneficiary account no. · merchant
  ruleKind: z.enum(["substring", "merchant", "beneficiary"]).default("substring"),
  direction: z.enum(["debit", "credit"]).nullable().optional(),
  minAmount: z.number().nullable().optional(),
  maxAmount: z.number().nullable().optional(),
  accountId: z.string(),
});
accountsRouter.post("/client-rules", async (req, res) => {
  const b = ruleCreateSchema.parse(req.body);
  const firmId = req.auth!.firmId;
  const client = await prisma.client.findFirst({ where: { id: b.clientId, firmId } });
  if (!client) throw notFound("Client not found");
  const account = await prisma.account.findFirst({ where: { id: b.accountId, firmId, postable: true } });
  if (!account) throw badRequest("الحساب غير موجود أو غير قابل للترحيل.");
  const rule = await prisma.classificationRule.create({
    data: {
      firmId, clientId: client.id, matchText: b.matchText.trim(), ruleKind: b.ruleKind, direction: b.direction ?? null,
      minAmount: b.minAmount ?? null, maxAmount: b.maxAmount ?? null, accountId: account.id, accountCode: account.code,
      accountStdKey: account.stdKey, createdFrom: "client-rule:manual",
    },
    include: { account: true },
  });
  res.status(201).json(rule);
});

const ruleUpdateSchema = z.object({
  matchText: z.string().min(1).optional(),
  accountId: z.string().optional(),
  ruleKind: z.enum(["substring", "merchant", "amount-pattern", "beneficiary"]).optional(),
  direction: z.enum(["debit", "credit"]).nullable().optional(),
  minAmount: z.number().nullable().optional(),
  maxAmount: z.number().nullable().optional(),
});

accountsRouter.patch("/classification-rules/:ruleId", async (req, res) => {
  const rule = await prisma.classificationRule.findFirst({ where: { id: req.params.ruleId, firmId: req.auth!.firmId } });
  if (!rule) throw notFound("Rule not found");
  const body = ruleUpdateSchema.parse(req.body);
  let acct: { id: string; code: string; stdKey: string | null } | null = null;
  if (body.accountId && body.accountId !== rule.accountId) {
    acct = await prisma.account.findFirst({ where: { id: body.accountId, firmId: req.auth!.firmId, postable: true }, select: { id: true, code: true, stdKey: true } });
    if (!acct) throw badRequest("الحساب غير موجود أو غير قابل للترحيل.");
  }
  const updated = await prisma.classificationRule.update({
    where: { id: rule.id },
    data: {
      ...(body.matchText !== undefined ? { matchText: body.matchText } : {}),
      ...(acct ? { accountId: acct.id, accountCode: acct.code, accountStdKey: acct.stdKey } : {}),
      ...(body.ruleKind !== undefined ? { ruleKind: body.ruleKind } : {}),
      ...(body.direction !== undefined ? { direction: body.direction } : {}),
      ...(body.minAmount !== undefined ? { minAmount: body.minAmount } : {}),
      ...(body.maxAmount !== undefined ? { maxAmount: body.maxAmount } : {}),
    },
    include: { account: true },
  });
  res.json(updated);
});

accountsRouter.delete("/classification-rules/:ruleId", async (req, res) => {
  const rule = await prisma.classificationRule.findFirst({ where: { id: req.params.ruleId, firmId: req.auth!.firmId } });
  if (!rule) throw notFound("Rule not found");
  await prisma.classificationRule.delete({ where: { id: rule.id } });
  res.json({ ok: true });
});

export { accountWhere };
