import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/http-error";
import {
  createAdjustment,
  listAdjustments,
  deleteAdjustment,
  confirmAdjustments,
  unconfirmAdjustments,
} from "./adjustments.service";

export const adjustmentsRouter = Router();

async function requireCase(caseId: string, firmId: string) {
  const k = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!k) throw notFound("Case not found");
  return k;
}

const createSchema = z.object({
  date: z.string(),
  debitAccountId: z.string().min(1),
  creditAccountId: z.string().min(1),
  amount: z.number().positive(),
  memo: z.string().optional(),
});

adjustmentsRouter.post("/cases/:caseId/adjustments", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  const body = createSchema.parse(req.body);

  const adjustment = await createAdjustment({
    firmId: req.auth!.firmId,
    caseId: req.params.caseId,
    date: new Date(body.date),
    debitAccountId: body.debitAccountId,
    creditAccountId: body.creditAccountId,
    amount: body.amount,
    memo: body.memo,
  });
  res.status(201).json(adjustment);
});

adjustmentsRouter.get("/cases/:caseId/adjustments", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  res.json(await listAdjustments(req.params.caseId, req.auth!.firmId));
});

adjustmentsRouter.delete(
  "/cases/:caseId/adjustments/:adjustmentGroupId",
  async (req, res) => {
    await requireCase(req.params.caseId, req.auth!.firmId);
    res.json(
      await deleteAdjustment(
        req.params.caseId,
        req.auth!.firmId,
        req.params.adjustmentGroupId,
      ),
    );
  },
);

adjustmentsRouter.post(
  "/cases/:caseId/adjustments/confirm",
  async (req, res) => {
    await requireCase(req.params.caseId, req.auth!.firmId);
    res.json(await confirmAdjustments(req.params.caseId, req.auth!.firmId));
  },
);

adjustmentsRouter.post(
  "/cases/:caseId/adjustments/unconfirm",
  async (req, res) => {
    await requireCase(req.params.caseId, req.auth!.firmId);
    res.json(await unconfirmAdjustments(req.params.caseId, req.auth!.firmId));
  },
);
