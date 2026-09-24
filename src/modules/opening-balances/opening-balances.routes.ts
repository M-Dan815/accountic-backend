import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound } from "@/lib/http-error";
import type { ColumnTemplate } from "@/modules/import-reader/types";
import {
  addOpeningDifference, applyImport, confirm, listOpeningBalances, loadTemplate, readAndMap, saveTemplate, setMode, setOne, unconfirm,
} from "./opening-balances.service";

export const openingBalancesRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

async function requireCase(caseId: string, firmId: string) {
  const k = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!k) throw notFound("Case not found");
  return k;
}

const templateSchema = z.object({
  sheet: z.string().optional(),
  headerRows: z.array(z.number().int().min(0)).optional(),
  dataStartRow: z.number().int().min(0),
  roles: z.record(z.string(), z.enum([
    "code", "name", "code_name", "opening_debit", "opening_credit", "opening_balance", "movement_debit", "movement_credit",
    "net_debit", "net_credit", "closing_debit", "closing_credit", "closing_balance", "debit", "credit", "balance", "type", "parent", "ignore",
  ])),
});

/**
 * STEP 1 — read a trial balance in ANY format (قيود، دفترة، قوائم، رواء، Odoo، Zoho، Excel يدوي).
 * Multipart: file, optional sourceName (uses that system's saved template).
 * Returns status OK + the mapping table (green/yellow/red), or NEEDS_MAPPING + the first 30 rows for
 * the "تحديد الأعمدة" screen. It never answers with a developer error.
 */
openingBalancesRouter.post("/cases/:caseId/opening-balances/read", upload.single("file"), async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  if (!req.file) throw badRequest("لم يتم رفع ملف. اختر ملف الميزان (Excel أو CSV).");
  const sourceName = typeof req.body.sourceName === "string" ? req.body.sourceName : undefined;
  const template = await loadTemplate(req.auth!.firmId, sourceName);
  let out = await readAndMap(req.params.caseId, req.auth!.firmId, req.file.buffer, req.file.originalname, template);
  // a saved template that no longer fits → fall back to automatic reading
  if (template && out.read.status !== "OK") out = await readAndMap(req.params.caseId, req.auth!.firmId, req.file.buffer, req.file.originalname);
  res.json(out);
});

/**
 * STEP 1b — the manual column screen: the user picked the header row and each column's role.
 * Multipart: file, template (JSON), optional sourceName + saveTemplate=true ("احفظ هذا القالب").
 */
openingBalancesRouter.post("/cases/:caseId/opening-balances/read-manual", upload.single("file"), async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  if (!req.file) throw badRequest("لم يتم رفع ملف.");
  let template: ColumnTemplate;
  try { template = templateSchema.parse(JSON.parse(String(req.body.template ?? "{}"))); } catch { throw badRequest("تحديد الأعمدة غير مكتمل: اختر صف البداية ودور كل عمود."); }
  const out = await readAndMap(req.params.caseId, req.auth!.firmId, req.file.buffer, req.file.originalname, template);
  if (out.read.status === "OK" && String(req.body.saveTemplate) === "true" && req.body.sourceName) {
    await saveTemplate(req.auth!.firmId, String(req.body.sourceName), template);
  }
  res.json(out);
});

const applySchema = z.object({
  rows: z.array(z.object({ key: z.string(), code: z.string().nullable(), name: z.string(), balance: z.number() })).min(1),
  decisions: z.array(z.object({
    key: z.string(), action: z.enum(["map", "create", "ignore"]),
    accountId: z.string().optional(), parentCode: z.string().optional(), newName: z.string().optional(),
  })).optional(),
  /** "ربط الكل بالمقترح": map every green/yellow row, create the red ones under the suggested parent */
  autoAccept: z.boolean().optional(),
  addDifference: z.boolean().optional(),
});

/** STEP 2 — apply the (confirmed) mapping. */
openingBalancesRouter.post("/cases/:caseId/opening-balances/apply", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  const b = applySchema.parse(req.body);
  res.status(201).json(await applyImport(req.params.caseId, req.auth!.firmId, b.rows, b));
});

/** One-shot convenience: read + auto-map + apply (green/yellow accepted, the rest created). */
openingBalancesRouter.post("/cases/:caseId/opening-balances/import", upload.single("file"), async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  if (!req.file) throw badRequest("لم يتم رفع ملف.");
  const out = await readAndMap(req.params.caseId, req.auth!.firmId, req.file.buffer, req.file.originalname, await loadTemplate(req.auth!.firmId, req.body.sourceName));
  if (out.read.status !== "OK") { res.status(422).json(out); return; }
  const result = await applyImport(req.params.caseId, req.auth!.firmId,
    out.mapping.map((m) => ({ key: m.key, code: m.source.code, name: m.source.name, balance: m.source.balance })),
    { autoAccept: true, addDifference: String(req.body.addDifference) === "true" });
  res.status(201).json({ ...out, result });
});
// kept for older clients
openingBalancesRouter.post("/cases/:caseId/opening-balances/preview", upload.single("file"), async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  if (!req.file) throw badRequest("لم يتم رفع ملف.");
  res.json(await readAndMap(req.params.caseId, req.auth!.firmId, req.file.buffer, req.file.originalname, await loadTemplate(req.auth!.firmId, req.body.sourceName)));
});

/** The other three choices: manual · first_year · unavailable ("غير متوفر الآن"). */
openingBalancesRouter.post("/cases/:caseId/opening-balances/mode", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  const { mode } = z.object({ mode: z.enum(["manual", "first_year", "unavailable"]) }).parse(req.body);
  res.json(await setMode(req.params.caseId, req.auth!.firmId, mode));
});

openingBalancesRouter.get("/cases/:caseId/opening-balances", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  res.json(await listOpeningBalances(req.params.caseId, req.auth!.firmId));
});
openingBalancesRouter.patch("/cases/:caseId/opening-balances/:accountId", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  const body = z.object({ balance: z.number() }).parse(req.body); // debit-positive
  res.json(await setOne(req.params.caseId, req.auth!.firmId, req.params.accountId, body.balance));
});
openingBalancesRouter.post("/cases/:caseId/opening-balances/add-difference", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  res.json(await addOpeningDifference(req.params.caseId, req.auth!.firmId));
});
openingBalancesRouter.post("/cases/:caseId/opening-balances/confirm", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  res.json(await confirm(req.params.caseId, req.auth!.firmId));
});
openingBalancesRouter.post("/cases/:caseId/opening-balances/unconfirm", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  res.json(await unconfirm(req.params.caseId, req.auth!.firmId));
});

// ── saved column templates ──
openingBalancesRouter.get("/import-templates", async (req, res) => {
  res.json(await prisma.importTemplate.findMany({ where: { firmId: req.auth!.firmId }, orderBy: { sourceName: "asc" } }));
});
openingBalancesRouter.delete("/import-templates/:id", async (req, res) => {
  await prisma.importTemplate.deleteMany({ where: { id: req.params.id, firmId: req.auth!.firmId } });
  res.status(204).end();
});
