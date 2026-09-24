# AccountTech backend — changes for spec v2.2 (23 Sep 2026)

Answers Anas's feedback ("the system can't read the files and classify like a human accountant") and the
§13 urgent fixes. **Deploy steps at the bottom.**

## What was wrong (root causes)

| Symptom | Cause | Fix |
|---|---|---|
| قيود trial balance rejected: "Could not find an account-code column" | Old reader only looked in the first 10 rows for a *separate* code column | New universal reader (§5) |
| "اختر حسابًا" list empty | `register` created a firm with **zero accounts**; only the demo seed had any | Every file gets its own copy of the standard tree at creation; existing files heal on first use |
| Loan repayment suggested a group account (1107) | Suggestions weren't restricted to postable accounts | AI/rules only see postable accounts of the file's chart |
| Classification looked like "copying the statement" | AI-first, hard-coded to one client's 98 Qoyod codes, unknown merchants dumped into "other expenses" | §7 engine: client rules → memory → auto-match → **62 system rules** → **merchant directory** → evidence → AI → question. Misc account is never auto-assigned |
| Everything blocked on "needs clarification" | Trial Balance refused to build with open items | "لا توقف": unresolved rows post to suspense 110801; only 5 real blockers remain (release gate §9.3) |
| Client's own name hard-coded in the enricher | `نخلة الخليج` regex | Built from the file's client name |

## Built

**Standard chart** — `src/data/coa_seed.json` (your file, unchanged): 252 accounts / 182 postable, 62 rules, merchant
directory, Q01–Q10. Per-file copy (`Account.caseId`); client-tree files use `stdKey` to translate. Legacy files
that already have firm-level accounts keep working untouched.

**Universal reader** (`src/modules/import-reader/`) — xlsx/xls/csv (UTF-8/BOM/windows-1256), all sheets, merged cells expanded,
2-row headers, code merged with name in any of the 4 forms (+ `(…)`, `:`), Arabic-Indic digits, `(1,250.00)`/`1,250-`/`Dr`/`Cr`,
total/footer/repeated-header rows ignored, final-account detection, closing → opening+movement → signed → debit/credit,
balance + file-total checks, period detection. Fails soft: returns `NEEDS_MAPPING` + first 30 rows for the column screen;
templates saved per source system. Also reads a client's **chart of accounts** (or a TB used as one).

**Opening balances (§4.4)** — 4 modes: upload (read → green/yellow/red mapping → apply, add-difference), manual,
first year, "unavailable now" (bank opening from first statement, counter-side 330103).

**Classification** — `engine.ts` (pure, tested), `classify-case.ts` (AI batching by unique signature, ≤0.85),
`questions.ts` (Q01–Q10 resolved per file + universal options), grouped by payee/merchant, small groups
(< client materiality) flagged for one-tap approval.

**Trial Balance / gate** — one bank account per statement, suspense for pending, accepted statement differences → 110803,
release gate = 5 blockers + overridable warnings.  **Statements** — cash flow is now driven by `cf_class` and
reconciles to the change in cash by construction; profit shows in 330102.

**§13 items:** 13.1 reader ✔ · 13.2 empty list ✔ · 13.3 postable-only ✔ · 13.4 Arabic validation messages with actions ✔ ·
13.5 zero-sum gaps merged into one alert ✔ · 13.6 "apply to similar" now covers same payee **or** merchant in the same file ✔

## New / changed API (all under `/api`)

- `POST /cases/:id/opening-balances/read` · `/read-manual` (+`saveTemplate`) · `/apply` · `/mode` · `/add-difference` · `/import` (one-shot)
- `GET /accounts?caseId=&q=&picker=true` (search, recents, suggested) · `GET /accounts/tree` · `POST /accounts` (+ حساب جديد) · `PATCH /accounts/:id` · `GET /accounts/export`
- `POST /accounts/tree/read` · `/read-manual` · `/install` (client tree → mapped to standard)
- `POST /accounts/client-rules` (condition → account) · `POST /cases/:id/reclassify`
- `POST /cases/:id/clarifications/:cid/choose` (account · defer to suspense · applyToSimilar statement|client) · `/approve-small`
- `POST /cases/:id/documents/:docId/accept-difference` · `POST /cases/:id/release-overrides`
- `GET /import-templates` · `DELETE /import-templates/:id`
- Client create/patch accept `activity, vatRegistered, materialityThreshold, revenueBasis, crNumber, vatNumber`; case create accepts `isFirstYear, framework, copyFromCaseId`

## Tests (`npm test`)

reader (13 layouts incl. the exact §5.1 قيود layout) · mapping (14/18 exact vs your example sheet; rest land yellow with the right
alternative) · validation (§13.5 case) · extraction (unchanged, 9/9) · classify glue · statement-only flow · end-to-end
(statement → TB → gate, "unavailable now" and uploaded قيود opening balances).
`npm run eval:reference` on the 958-row workbook, **AI off**: 63% assigned by rules alone, 81% of those agree with the
workbook (most disagreements are rows the workbook put in "other expenses", which the spec forbids), 0 to Misc,
66 questions above materiality (+132 small groups approved in one tap). With an AI key most purchases never become questions.

## Not done / be aware

- **Not run against Postgres.** No DB or Prisma engine in my environment: types are checked (`tsc`) and every flow is tested on an
  in-memory fake, but run `npm run test` + a real upload on staging before Anas sees it.
- The 7 system fixtures are **synthetic** (built from the spec's §5.1 and each system's known layout). Send real exports from
  دفترة / قوائم / رواء / Odoo / Zoho and add them to `tests/` — the manual column screen is the safety net until then.
- Not built (spec phases 4–5): adjustments UI wiring for depreciation/EOSB/zakat templates (§8.2 — existing manual adjustments still work),
  Excel/PDF statement export in the new layout (§9.2), notes, Riyad/SNB/Alinma statement parsers (only Al Rajhi has one; others use the vision fallback).
- Public client portal still shows single suggestions, not the multiple-choice options.
- Existing files stay on their old chart; use "copy from previous file" or create a new file to move to the standard tree.

## Deploy

```
npm ci
npx prisma migrate deploy        # 20260924100000_standard_chart_per_file
npm run backfill:charts          # gives empty-chart files the standard tree
npm run seed                     # optional demo data
```
