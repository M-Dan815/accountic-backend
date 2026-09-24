# Statement-first classification — what changed and why

Feedback (Anas): still invoice-dependent · no AI reading the statement · extraction only copies ·
100 % needs client clarification · wants to match everything.

## Root causes found in the code
1. **Extraction threw the evidence away.** `alRajhiStatementParser` reduced every row to a short label
   (`"(شراء عبر نقاط البيع أثير )محلي Fawal (5"`, `"تحويل"`). Merchant, beneficiary and the sender's
   typed purpose (راتب / بنزين / قسط البنك) never reached the DB, rules, or the LLM.
2. **Classification was blind and one-row-at-a-time.** ~957 sequential LLM calls (cache key contained
   the timestamp/ref → no dedupe), each resending the whole chart of accounts → rate limits. Any
   failure was swallowed to `null` → confidence 0 → "needs client clarification".
3. **The prompt/policy made "don't know" the default.** Person → 0, >5 000 unclear → 0, <0.5 → uncategorised,
   and `raiseExceptions` asked the client for every material row under 0.85.
4. **One question per transaction**, and answering it fixed only that row (salary payee × 12 = 12 questions).
5. **Reconciliation ran on every row** and generated review/approval noise for rows that never need an invoice.

## Changes
| Area | File |
|---|---|
| Keep full bank text (`rawText`), store as `description` | `parsers/alRajhiStatementParser.ts`, `cases/processing.service.ts` |
| **Enrichment**: kind, merchant, counterparty, typed purpose, fee↔transfer ref, payee key | `extraction/statementEnricher.ts` (new) |
| **Tier-1 evidence classifier** (fees, SADAD, HRSD, Ejar, fuel, food, memo keywords, own-account transfers, collections) | `classification/statementClassifier.ts` (new) |
| Tiered pipeline: human rules → evidence → seeded rules → **batched LLM on unique signatures** → policy fallback | `classification/classify-case.ts` (new) |
| Batch LLM call + retry/back-off on 429/5xx | `lib/ai-provider.ts` |
| `beneficiary` rule kind; human rules beat generic ones | `classification/classification.engine.ts` |
| One decision per **payee** (rule + propagation to siblings) | `classification/learning.ts` (new), `clarification.service.ts`, `cases.routes.ts` |
| Ask once per payee; no materiality-based questions | `cases/processing.service.ts` |
| Invoice matching only for accounts that need a document (collections) | `cases/processing.service.ts` |
| Schema: `BankTransaction.enrichment`, `.beneficiaryKey` | `prisma/schema.prisma` + migration `20260921090000_statement_enrichment` |

## Verify
```
npm run eval:reference   # deterministic tiers vs the 958-row reference workbook (no DB/AI)
npm run test:classify    # pipeline glue with fake DB + fake AI (works / fails / none)
```
Deploy: `npx prisma migrate deploy`, then **re-upload/re-extract existing cases** (old rows hold the truncated description).

## Not changed (needs a decision)
- `generateTrialBalance` still refuses to run while any row is unclassified (client's "waiting for N items" gate).
  The reference posts the ready rows and parks the rest in a suspense account instead.
- Journal lines use ONE cash account for every row (`findCashAccount`). Multi-bank cases (Rajhi 110201 / Riyad 110202)
  should derive the bank side from the source document.
- Seed rule `"سداد"` is too broad (matches "سداد قسط بنك الرياض"); it is now demoted below evidence.


---
## Round 2 — vision fallback + guaranteed statement-only flow

**Bank-statement extraction order** (`extraction/extraction.service.ts`):
1. deterministic parser (known layout) → 2. text-layer AI (unknown layout, selectable text) →
3. **vision AI over page images, chunked** (`extraction/statementVision.ts`; any bank, scans included).

**Nothing the AI reads is trusted** (`extraction/statementValidation.ts`): running-balance continuity in both
orderings (newest-/oldest-first), opening + Σ = closing, declared totals, date order. A failing 3-page chunk is re-read
page by page; a statement that still fails is stored with `extractionReport.status = FAILED`, and the pipeline raises
ONE blocking `MISSING_INFO` exception naming the row and the unexplained amount (≈ the missing row). Statements without
a balance column are marked `UNVERIFIED`, never "verified".

**Statement-only flow**: invoices are optional end to end. With zero invoices there is no `MISSING_SUPPORTING_DOC`,
`UNMATCHED_INVOICE` or matching noise; collections post to receivables and wait for a link if/when invoices arrive.

Schema: `Document.extractionReport` (migration `20260921100000_document_extraction_report`).
Parser now also returns each row's balance.

```
npm run test:extraction       # vision chunking + arithmetic checks (dropped row, misread digit, swapped sign, newest-first…)
npm run test:statement-only   # real processCase() on a statement only: 0 invoices, AI off
```
Limits: vision output for a real bank has not been exercised against a live model in this environment; the tests use a
fake provider fed by the reference statement. Try one real scanned statement before relying on it.
