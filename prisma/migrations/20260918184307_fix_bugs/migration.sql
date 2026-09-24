-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "requiresSupportingDoc" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "counterparty" TEXT;

-- AlterTable
ALTER TABLE "ClassificationRule" ADD COLUMN     "ruleKind" TEXT NOT NULL DEFAULT 'substring';
