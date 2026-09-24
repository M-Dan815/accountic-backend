/*
  Warnings:

  - The values [IMBALANCE] on the enum `ExceptionType` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "ClarificationStatus" AS ENUM ('OPEN', 'ANSWERED');

-- AlterEnum
BEGIN;
CREATE TYPE "ExceptionType_new" AS ENUM ('UNMATCHED_TRANSACTION', 'UNMATCHED_INVOICE', 'LOW_CONFIDENCE_CATEGORY', 'POSSIBLE_DUPLICATE', 'MISSING_INFO', 'NEEDS_CLIENT_CLARIFICATION', 'MISSING_SUPPORTING_DOC');
ALTER TABLE "Exception" ALTER COLUMN "type" TYPE "ExceptionType_new" USING ("type"::text::"ExceptionType_new");
ALTER TYPE "ExceptionType" RENAME TO "ExceptionType_old";
ALTER TYPE "ExceptionType_new" RENAME TO "ExceptionType";
DROP TYPE "ExceptionType_old";
COMMIT;

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "openingBalance" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "categoryReason" TEXT,
ADD COLUMN     "categoryReasonSource" TEXT;

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "adjustmentsConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "openingBalancesConfirmed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Clarification" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "bankTransactionId" TEXT,
    "invoiceId" TEXT,
    "question" TEXT NOT NULL,
    "questionAr" TEXT,
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answeredBy" TEXT,
    "status" "ClarificationStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Clarification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Clarification_bankTransactionId_key" ON "Clarification"("bankTransactionId");

-- CreateIndex
CREATE INDEX "Clarification_firmId_idx" ON "Clarification"("firmId");

-- CreateIndex
CREATE INDEX "Clarification_caseId_idx" ON "Clarification"("caseId");

-- CreateIndex
CREATE INDEX "Clarification_status_idx" ON "Clarification"("status");

-- AddForeignKey
ALTER TABLE "Clarification" ADD CONSTRAINT "Clarification_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clarification" ADD CONSTRAINT "Clarification_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clarification" ADD CONSTRAINT "Clarification_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
