import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound } from "@/lib/http-error";
import { accountWhere, getChartScope } from "@/modules/chart/chart.service";
import { answerClarification } from "./clarification.service";
import { reclassifyCase } from "./processing.service";
import { acceptStatementDifference } from "@/modules/trial-balance/trial-balance.service";
import { computeReadiness } from "@/modules/trial-balance/readiness.service";

/**
 * Endpoints behind the "no dead end" table (spec §3): every situation the user can hit has a button.
 */
export const workflowRouter = Router();

async function requireCase(caseId: string, firmId: string) {
  const k = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!k) throw notFound("Case not found");
  return k;
}

const chooseSchema = z.object({
  accountId: z.string().optional(),
  accountCode: z.string().optional(),
  /** ترحيلها مؤقتًا لحساب «معلق» والمتابعة */
  defer: z.boolean().optional(),
  /** which option of the question the user tapped (kept for the audit trail) */
  optionLabel: z.string().optional(),
  applyToSimilar: z.enum(["statement", "client"]).default("client"),
});

/** Answer a multiple-choice question with an option, any account of the tree, or "defer to suspense". */
workflowRouter.post("/cases/:caseId/clarifications/:id/choose", async (req, res) => {
  const firmId = req.auth!.firmId;
  await requireCase(req.params.caseId, firmId);
  const b = chooseSchema.parse(req.body);
  const scope = await getChartScope(req.params.caseId, firmId);
  let accountId = b.accountId;
  if (!accountId && b.accountCode) {
    accountId = (await prisma.account.findFirst({ where: { ...accountWhere(scope), code: b.accountCode, postable: true } }))?.id;
    if (!accountId) throw badRequest("الحساب غير موجود في شجرة هذا الملف أو غير قابل للترحيل.");
  }
  if (!b.defer && !accountId) throw badRequest("اختر حسابًا أو اختر «تأجيل».");
  const cl = await prisma.clarification.findFirst({ where: { id: req.params.id, caseId: req.params.caseId, firmId } });
  if (!cl) throw notFound("Clarification not found");
  const updated = await answerClarification({
    firmId, clarificationId: cl.id, answeredBy: req.auth!.userId,
    answer: b.defer ? "تأجيل — رُحّلت مؤقتًا إلى الحساب المعلق" : b.optionLabel ?? "اختيار المحاسب",
    proposedAccountId: b.defer ? undefined : accountId,
    applyToSimilar: b.applyToSimilar,
  });
  res.json(updated);
});

/**
 * "اعتماد الكل على المقترح" for the small groups: every OPEN question whose total is below the client's
 * materiality threshold is settled on its suggested account in one go.
 */
workflowRouter.post("/cases/:caseId/clarifications/approve-small", async (req, res) => {
  const firmId = req.auth!.firmId;
  await requireCase(req.params.caseId, firmId);
  const open = await prisma.clarification.findMany({ where: { caseId: req.params.caseId, firmId, status: "OPEN" } });
  let approved = 0, skipped = 0;
  for (const c of open) {
    const meta = (c.options ?? {}) as { small?: boolean; suggestedCode?: string | null };
    if (!meta.small || !c.proposedAccountId) { skipped++; continue; }
    await answerClarification({
      firmId, clarificationId: c.id, answeredBy: req.auth!.userId, answer: "اعتماد على المقترح (مجموعة أقل من حد الأهمية)",
      proposedAccountId: c.proposedAccountId, applyToSimilar: "statement",
    });
    approved++;
  }
  res.json({ approved, skipped });
});

/** "أعد التصنيف" — re-run the engine after adding client rules. Manual decisions are never touched. */
workflowRouter.post("/cases/:caseId/reclassify", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  res.json(await reclassifyCase(req.params.caseId, req.auth!.firmId));
});

/** "اقبل الفرق" — accept the unexplained gap of a statement into «فروقات التسوية», with a note. */
workflowRouter.post("/cases/:caseId/documents/:documentId/accept-difference", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  const { note } = z.object({ note: z.string().min(3) }).parse(req.body);
  res.json(await acceptStatementDifference(req.params.caseId, req.auth!.firmId, req.params.documentId, note, req.auth!.userId));
});

/** Pass a warning of the release gate with a written justification (kept in the file's log). */
workflowRouter.post("/cases/:caseId/release-overrides", async (req, res) => {
  const kase = await requireCase(req.params.caseId, req.auth!.firmId);
  const { key, reason } = z.object({ key: z.string(), reason: z.string().min(3) }).parse(req.body);
  const report = await computeReadiness(kase.id, req.auth!.firmId);
  const item = report.items.find((i) => i.key === key);
  if (!item) throw badRequest("فحص غير معروف.");
  if (item.severity !== "warning") throw badRequest("هذا فحص حاجب ولا يمكن تجاوزه: استخدم زر «اذهب للمشكلة».");
  const current = (kase.releaseOverrides ?? {}) as Record<string, unknown>;
  await prisma.case.update({
    where: { id: kase.id },
    data: { releaseOverrides: { ...current, [key]: { reason, by: req.auth!.userId, at: new Date().toISOString() } } as Prisma.InputJsonObject },
  });
  res.json(await computeReadiness(kase.id, req.auth!.firmId));
});
