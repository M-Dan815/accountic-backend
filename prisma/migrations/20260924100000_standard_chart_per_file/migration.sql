-- Spec v2.2: per-file chart of accounts (standard 252-account tree or client tree),
-- client profile, statement-only opening-balance modes, saved import templates,
-- multiple-choice clarifications.

-- Client profile
ALTER TABLE "Client"
  ADD COLUMN "crNumber" TEXT,
  ADD COLUMN "vatNumber" TEXT,
  ADD COLUMN "vatRegistered" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "activity" TEXT NOT NULL DEFAULT 'services',
  ADD COLUMN "materialityThreshold" INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN "revenueBasis" TEXT NOT NULL DEFAULT 'invoices';

-- Case
ALTER TABLE "Case"
  ADD COLUMN "chartMode" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "framework" TEXT NOT NULL DEFAULT 'sme',
  ADD COLUMN "isFirstYear" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "openingMode" TEXT,
  ADD COLUMN "releaseOverrides" JSONB;
-- Every case that exists today uses the old firm-level accounts.
UPDATE "Case" SET "chartMode" = 'legacy';

-- Document
ALTER TABLE "Document"
  ADD COLUMN "bankAccountId" TEXT,
  ADD COLUMN "iban" TEXT,
  ADD COLUMN "openingBalance" DECIMAL(18,2),
  ADD COLUMN "closingBalance" DECIMAL(18,2);

-- Account
ALTER TABLE "Account"
  ADD COLUMN "caseId" TEXT,
  ADD COLUMN "level" INTEGER,
  ADD COLUMN "nature" TEXT,
  ADD COLUMN "statement" TEXT,
  ADD COLUMN "fsLine" TEXT,
  ADD COLUMN "fsLineEn" TEXT,
  ADD COLUMN "cfClass" TEXT,
  ADD COLUMN "stdKey" TEXT,
  ADD COLUMN "isContra" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "systemLocked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "vatDefault" TEXT,
  ADD COLUMN "keywordsAr" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "keywordsEn" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "isCustom" BOOLEAN NOT NULL DEFAULT false;
DROP INDEX "Account_firmId_code_key";
CREATE UNIQUE INDEX "Account_firmId_caseId_code_key" ON "Account"("firmId", "caseId", "code");
CREATE INDEX "Account_caseId_idx" ON "Account"("caseId");
CREATE INDEX "Account_caseId_stdKey_idx" ON "Account"("caseId", "stdKey");

-- Classification rules: resolved by code / std key so they work on any file's chart
ALTER TABLE "ClassificationRule" DROP CONSTRAINT "ClassificationRule_accountId_fkey";
ALTER TABLE "ClassificationRule"
  ALTER COLUMN "accountId" DROP NOT NULL,
  ADD COLUMN "accountCode" TEXT,
  ADD COLUMN "accountStdKey" TEXT,
  ADD COLUMN "clientId" TEXT,
  ADD COLUMN "direction" TEXT,
  ADD COLUMN "minAmount" DECIMAL(18,2),
  ADD COLUMN "maxAmount" DECIMAL(18,2);
UPDATE "ClassificationRule" r SET "accountCode" = a."code", "accountStdKey" = a."stdKey"
  FROM "Account" a WHERE r."accountId" = a."id";
ALTER TABLE "ClassificationRule" ADD CONSTRAINT "ClassificationRule_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClassificationRule" ADD CONSTRAINT "ClassificationRule_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ClassificationRule_clientId_idx" ON "ClassificationRule"("clientId");

-- Clarifications: multiple choice
ALTER TABLE "Clarification" ADD COLUMN "questionId" TEXT, ADD COLUMN "options" JSONB;

-- Saved column mappings
CREATE TABLE "ImportTemplate" (
  "id" TEXT NOT NULL,
  "firmId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "sourceName" TEXT NOT NULL,
  "template" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ImportTemplate_firmId_kind_sourceName_key" ON "ImportTemplate"("firmId", "kind", "sourceName");
