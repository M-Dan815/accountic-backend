/*
  Warnings:

  - A unique constraint covering the columns `[clientAccessToken]` on the table `Case` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "clientAccessToken" TEXT,
ADD COLUMN     "clientAccessTokenExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "adjustmentGroupId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Case_clientAccessToken_key" ON "Case"("clientAccessToken");

-- CreateIndex
CREATE INDEX "JournalLine_adjustmentGroupId_idx" ON "JournalLine"("adjustmentGroupId");
