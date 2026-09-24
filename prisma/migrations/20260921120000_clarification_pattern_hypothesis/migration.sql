-- AlterTable: add AI pattern-hypothesis columns to Clarification.
--
-- The pattern detector (src/modules/classification/patternDetector.ts)
-- finds groups of unclassified transactions that share a payee AND a
-- recurring cadence (same day-of-month + monthly spacing). An AI call
-- (src/lib/ai-provider.ts → suggestClarificationQuestion) then
-- interprets the pattern into:
--   • a natural-language question shown to the client/accountant
--     (stored on Clarification.question / questionAr as before)
--   • a proposed account code + hypothesis reason (these new columns)
--   • the raw detected signals, so the UI can explain "why did the AI
--     think this was salaries?" (detectedPattern JSON)
--
-- The client portal exposes a one-click "confirm hypothesis" action
-- (public-clarifications.routes.ts) that, when confirmed, calls
-- learnFromDecision → propagateToPayeeSiblings to settle every sibling
-- transaction to the same payee. See schema.prisma for the design notes.

ALTER TABLE "Clarification"
  ADD COLUMN "proposedAccountId" TEXT,
  ADD COLUMN "detectedPattern" JSONB,
  ADD COLUMN "hypothesisReason" TEXT;

-- FK from Clarification.proposedAccountId → Account.id (named relation so
-- it doesn't collide with Account.bankTransactions / .classificationRules).
ALTER TABLE "Clarification"
  ADD CONSTRAINT "Clarification_proposedAccountId_fkey"
  FOREIGN KEY ("proposedAccountId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
