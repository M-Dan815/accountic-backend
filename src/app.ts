import "express-async-errors";
import express from "express";
import cors from "cors";
import { env } from "@/lib/env";
import { requireAuth } from "@/middleware/auth";
import { errorHandler } from "@/middleware/errorHandler";
import { authRouter } from "@/modules/auth/auth.routes";
import { clientsRouter } from "@/modules/clients/clients.routes";
import { casesRouter } from "@/modules/cases/cases.routes";
import { documentsRouter } from "@/modules/documents/documents.routes";
import { trialBalanceRouter } from "@/modules/trial-balance/trial-balance.routes";
import { statementsRouter } from "@/modules/statements/statements.routes";
import { exportRouter } from "@/modules/export/export.routes";
import { accountsRouter } from "@/modules/accounts/accounts.routes";
import { openingBalancesRouter } from "@/modules/opening-balances/opening-balances.routes";
import { workflowRouter } from "@/modules/cases/workflow.routes";
import { adjustmentsRouter } from "@/modules/adjustments/adjustments.routes";
import { publicClarificationsRouter } from "@/modules/clarifications/public-clarifications.routes";

export const app = express();

app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Public
app.use("/api/auth", authRouter);
// Public clarification portal — client-facing, token-authenticated per
// request. Must be mounted BEFORE requireAuth below.
app.use("/api/public", publicClarificationsRouter);

// Everything below requires a valid firm-scoped JWT (see requireAuth).
app.use("/api", requireAuth);
app.use("/api/clients", clientsRouter);
app.use("/api/cases", casesRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api", documentsRouter);
app.use("/api", trialBalanceRouter);
app.use("/api", statementsRouter);
app.use("/api", exportRouter);
app.use("/api", openingBalancesRouter);
app.use("/api", adjustmentsRouter);
app.use("/api", workflowRouter);

app.use(errorHandler);
