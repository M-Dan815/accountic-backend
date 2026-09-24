import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/http-error";
import { buildIncomeStatement, buildBalanceSheet, buildCashFlowStatement, drilldownAccount } from "./statements.service";

export const statementsRouter = Router();

async function requireCase(caseId: string, firmId: string) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!kase) throw notFound("Case not found");
  return kase;
}

statementsRouter.get("/cases/:caseId/statements/income-statement", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  res.json(await buildIncomeStatement(req.params.caseId, req.auth!.firmId));
});

statementsRouter.get("/cases/:caseId/statements/balance-sheet", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  res.json(await buildBalanceSheet(req.params.caseId, req.auth!.firmId));
});

statementsRouter.get("/cases/:caseId/statements/cash-flow", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  res.json(await buildCashFlowStatement(req.params.caseId, req.auth!.firmId));
});

statementsRouter.get("/cases/:caseId/accounts/:accountId/drilldown", async (req, res) => {
  await requireCase(req.params.caseId, req.auth!.firmId);
  res.json(await drilldownAccount(req.params.caseId, req.auth!.firmId, req.params.accountId));
});
