-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "enrichment" JSONB,
ADD COLUMN     "beneficiaryKey" TEXT;

-- CreateIndex
CREATE INDEX "BankTransaction_caseId_beneficiaryKey_idx" ON "BankTransaction"("caseId", "beneficiaryKey");
