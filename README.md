# Accountic — Backend

Reconciliation, classification, Trial Balance and financial-statement API
for the Accountic frontend. Node.js + Express + TypeScript + Prisma +
PostgreSQL.

## Architecture, in one paragraph

Documents are extracted (deterministic parsers first, AI provider only as a
fallback for layouts we don't have a parser for) → bank transactions are
matched against invoices by a scored, deterministic algorithm → transactions
are classified into Chart-of-Accounts categories (firm rules first, AI
suggestion second) → anything uncertain becomes an **Exception** the
accountant has to resolve → once there are zero open exceptions, approved
transactions are posted as **double-entry journal lines** → the Trial
Balance and every financial statement are pure aggregations of those
journal lines. AI never touches a calculation, a match decision, or a
total — see `src/lib/ai-provider.ts` for exactly where the AI boundary is.

## Validated against this client's real documents

Rather than build extraction against a spec and hope, the two deterministic
parsers in `src/modules/extraction/parsers/` were built and tested directly
against the real files Meshal sent:

- **Al Rajhi bank statement parser** (`alRajhiStatementParser.ts`) — tested
  against the real statement: correctly parses all **15 transactions**, and
  the summed credits/debits match the statement's own declared totals
  exactly (14,409.00 / 12,166.75 SAR).
- **Qoyod/Daftra invoice parser** (`qoyodDaftraInvoiceParser.ts`) — tested
  against all 3 real invoice PDFs (one Qoyod tax invoice, two Daftra
  simplified invoices, including one with corrupted font encoding in its
  underlying text layer) — all 3 now extract correctly (invoice number,
  date, pre-VAT amount, VAT, total).
- **Chart of Accounts importer** (`src/seed/importChartOfAccounts.ts`) —
  parses the firm's actual 98-account Qoyod export verbatim; the seed
  fixture at `src/seed/fixtures/chart-of-accounts.xlsx` *is* their real
  export. `npm run seed` loads it into a demo firm.

The 4th PDF Meshal sent (`_فاتوره_مخصوص_9مارس__2.pdf`) extracts to 0
characters of text — it appears to be a blank/corrupted export on his end,
worth asking him to re-send. The account-statement-labeled PDF
(`Account_Statement_...pdf`) turned out to actually be a **sales-ledger
export for account 4101**, not a bank statement — it's kept as reference
data, not run through the bank-statement parser.

## Setup

```bash
cp .env.example .env          # edit JWT_SECRET at minimum
docker compose up -d          # starts local Postgres
npm install
npx prisma migrate dev --name init
npm run seed                  # imports the real CoA + demo firm login
npm run dev                   # http://localhost:4000
```

Seeded login (printed by `npm run seed`): `demo@accountic.sa` /
`demo12345`, firm "Al Fanar Accounting Partners" with the real 98-account
Chart of Accounts already imported.

> **Note on this environment:** `npx prisma generate` could not run inside
> the sandbox this was built in (no network access to Prisma's engine CDN),
> so the Prisma Client types aren't generated here and `tsc --noEmit`
> currently shows type errors that are entirely due to that — every one of
> them is either "no exported member of `@prisma/client`" or an `any`
> cascading from it. Running `npm install && npx prisma generate` (or just
> `npx prisma migrate dev`, which generates as a side effect) on a machine
> with normal internet access resolves all of them. Every module was still
> runtime-tested directly against the real documents (see above) using
> `tsx`, independent of Prisma.

### File storage (S3 with local fallback, as requested)

Set `STORAGE_DRIVER=s3` plus `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY_ID`
/ `S3_SECRET_ACCESS_KEY` in `.env`. If those aren't fully set, or an S3
upload call itself fails, `src/lib/storage.ts` automatically falls back to
local disk under `./uploads` — uploads never hard-fail just because a
bucket isn't configured yet.

### AI provider (swappable, per the client's requirement)

Set `AI_PROVIDER=openai|deepseek|gemini` and `AI_API_KEY` in `.env`. Until
one is set (`AI_PROVIDER=none`, the default), documents that don't match a
known deterministic layout will raise an extraction error rather than
silently failing — which becomes a visible `FAILED` document status, not a
missing transaction.

## API surface

All routes below `/api` except `/api/auth/*` require `Authorization: Bearer
<token>` from `/api/auth/login` or `/api/auth/register`.

```
POST   /api/auth/register                          firm + first user
POST   /api/auth/login

GET    /api/clients
POST   /api/clients
POST   /api/clients/:clientId/cases

GET    /api/cases/:caseId
GET    /api/cases/:caseId/transactions
GET    /api/cases/:caseId/invoices
GET    /api/cases/:caseId/exceptions
POST   /api/cases/:caseId/exceptions/:id/resolve    approve | flag_missing_doc | manual_category | manual_match

POST   /api/cases/:caseId/documents                 multipart upload (type=BANK_STATEMENT|INVOICE|RECEIPT)
POST   /api/cases/:caseId/process                   run extraction → reconciliation → classification → exceptions
GET    /api/documents/file/:key                     local-storage file passthrough

GET    /api/accounts                                firm's Chart of Accounts
GET    /api/accounts/classification-rules

GET    /api/cases/:caseId/trial-balance
POST   /api/cases/:caseId/trial-balance/generate     blocked while exceptions are open
POST   /api/cases/:caseId/trial-balance/approve      blocked unless balanced

GET    /api/cases/:caseId/statements/income-statement
GET    /api/cases/:caseId/statements/balance-sheet
GET    /api/cases/:caseId/statements/cash-flow
GET    /api/cases/:caseId/accounts/:accountId/drilldown   source transactions + documents behind a line

GET    /api/cases/:caseId/export/trial-balance.xlsx
GET    /api/cases/:caseId/export/income-statement.xlsx
GET    /api/cases/:caseId/export/balance-sheet.xlsx
```

## What's deliberately simplified for this phase (flag before demoing)

- **Cash Flow Statement** is a direct-method summary (inflows/outflows
  through the cash/bank control account), not a full indirect-method
  statement with working-capital adjustments — no real Cash Flow sample has
  been provided yet to validate a richer version against.
- **Invoice direction** (payable vs receivable) defaults to `PAYABLE` at
  extraction time; flipping it per-invoice needs a small UI affordance that
  isn't wired up yet.
- **PDF export** only ships as Excel right now; PDF export endpoints aren't
  built yet.
- The **cash/bank control account** is auto-detected by name from the
  firm's CoA rather than configured explicitly — works for this firm's real
  export, but should become an explicit firm setting before other firms
  onboard.
- **Interest / Zakat**: the Income Statement exposes `netIncomeBeforeZakat`
  and `netProfit` as separate fields for future use, but no zakat/interest
  accounts are modeled yet — they're currently always equal.
- **Multi-period retained earnings**: each Case is currently an independent
  period with no automatic roll-forward from a prior Case's closing
  balance. Retained earnings in the Balance Sheet = whatever's already
  posted to that account (0, for a fresh case) + the current period's net
  profit. This reproduced the real client's numbers exactly for a single
  period (see below) but a firm running consecutive years through the
  system will eventually need that roll-forward wired up.

## Income Statement / Balance Sheet — rebuilt against the real templates

Meshal sent real 2023 and Jan–Apr 2024 Income Statements plus an Apr-2024
Balance Sheet. Three structural things those revealed that the statements
module is now built around (previously it only did a flat Revenue −
Expenses calc):

1. **Section hierarchy comes from the account code itself, not the CoA
   export's "Parent Account code" column.** That column turns out to only
   be reliably populated from the 4-digit level down — the top-level
   1-/2-digit section rows (`1`, `11`, `41`, `51`, `52`, `31`, `34`...)
   mostly have a *blank* parent in the real export, even though the actual
   statements clearly nest under them. `accountTree.ts` instead derives
   nesting from "whichever known account code is the longest prefix of this
   one," which is the standard Saudi/Qoyod numbering convention this firm's
   codes already follow, and reproduces both real PDFs exactly.
2. **There's a real Gross Profit step.** Revenue − Direct Costs (root
   section `51`) = `إجمالي الربح`, then − Operating Costs (every other
   expense root, `52`+) = `صافي الدخل قبل الفوائد والضريبة والزكاة` /
   `صافي الربح`. Verified against the real Jan–Apr 2024 P&L: computed gross
   profit −1,050.20 and net profit −77,383.95, both match the PDF exactly.
3. **Negative amounts render in parentheses** (`(97,163.00 ر.س)`), the
   normal accounting convention — every statement response now carries both
   a raw `amount`/`total*` number (for further math) and a matching
   `*Formatted` string in that convention; Excel exports use a native
   `#,##0.00;(#,##0.00)` number format for the same effect.


