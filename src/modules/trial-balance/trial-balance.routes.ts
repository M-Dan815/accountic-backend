import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/http-error";
import { generateTrialBalance, computeTrialBalance, approveTrialBalance } from "./trial-balance.service";

export const trialBalanceRouter = Router();

async function requireCase(caseId: string, firmId: string) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!kase) throw notFound("Case not found");
  return kase;
}

trialBalanceRouter.get("/cases/:caseId/trial-balance", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  const tb = await computeTrialBalance(req.params.caseId, req.auth!.firmId);
  res.json(tb);
});

trialBalanceRouter.post("/cases/:caseId/trial-balance/generate", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  const tb = await generateTrialBalance(req.params.caseId, req.auth!.firmId);
  res.json(tb);
});

trialBalanceRouter.post("/cases/:caseId/trial-balance/approve", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  const tb = await approveTrialBalance(req.params.caseId, req.auth!.firmId);
  res.json(tb);
});
