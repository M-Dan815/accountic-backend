-- Add `splits` and `pairedWithTxnId` columns to BankTransaction.
--
-- splits: JSON array of {accountId, amount} pairs, used when a single
-- transaction posts to multiple accounts (Anas feedback #2 — e.g. a fuel +
-- snack POS purchase that splits 80/20 Transport/Hospitality). When null,
-- the journal-entry generator uses categoryAccountId as before.
--
-- pairedWithTxnId: points from a refund (PURCHASE_REFUND / SADAD_REFUND)
-- back to the original purchase it reverses (Anas feedback #4). The pairing
-- is detected by a small matcher in processing.service.ts (same merchant +
-- similar amount + close date). The reconciliation UI renders this as
-- "Refund of {original txn}" instead of treating the refund as standalone.

ALTER TABLE "BankTransaction"
  ADD COLUMN "splits" JSONB,
  ADD COLUMN "pairedWithTxnId" TEXT;

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_pairedWithTxnId_fkey"
  FOREIGN KEY ("pairedWithTxnId") REFERENCES "BankTransaction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
