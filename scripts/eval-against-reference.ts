/**
 * Measures the deterministic tiers (enricher + heuristic classifier) against
 * the client's reference workbook (958 Al Rajhi rows, 2025), exported to
 * reference-2025.json.
 *
 *   npx tsx scripts/eval-against-reference.ts
 *
 * No DB, no network, no AI. Whatever the heuristics leave undecided is what
 * the LLM tier has to handle — this tells us how big that residue is.
 */
import fs from "node:fs";
import path from "node:path";
import { enrichStatementRow } from "../src/modules/extraction/statementEnricher";
import {
  classifyFromStatement,
  DEFAULT_ROLE_CODES,
} from "../src/modules/classification/statementClassifier";

type Ref = { n: number; amount: number; desc: string; acct: string; status: string };
const rows: Ref[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "reference-2025.json"), "utf8"),
);

const refCode = (a: string) => a.match(/^\d+/)?.[0] ?? "PENDING";
const isRefPending = (r: Ref) => r.status.startsWith("معلّق");

let decided = 0, correct = 0, pendingCalled = 0, pendingHit = 0;
let undecided = 0;
// End-to-end WITHOUT the LLM: heuristics, then the "unidentified operating
// purchase → 5214" fallback for POS/online residue, PENDING rows grouped by payee.
let e2eOk = 0, e2ePending = 0;
const pendingPayees = new Set<string>();
const wrong: string[] = [];
const undecidedKinds: Record<string, number> = {};
const byKind: Record<string, { n: number; ok: number }> = {};

for (const r of rows) {
  const e = enrichStatementRow(r.desc, r.amount);
  const res = classifyFromStatement(e, r.amount);
  const k = (byKind[e.kind] ??= { n: 0, ok: 0 });
  k.n++;

  if (!res) {
    if (e.kind === "POS_PURCHASE" || e.kind === "ONLINE_PURCHASE") {
      if (refCode(r.acct) === DEFAULT_ROLE_CODES.OTHER_EXPENSE) e2eOk++;
    }
    undecided++;
    undecidedKinds[e.kind] = (undecidedKinds[e.kind] ?? 0) + 1;
    continue;
  }
  decided++;
  if (res.decision === "PENDING") {
    e2ePending++;
    pendingPayees.add(e.beneficiaryKey ?? `row${r.n}`);
    if (isRefPending(r)) e2eOk++;
    pendingCalled++;
    if (isRefPending(r)) { pendingHit++; correct++; k.ok++; }
    else wrong.push(`#${r.n} PENDING but ref=${r.acct} | ${r.desc.slice(0, 90)}`);
    continue;
  }
  const code = DEFAULT_ROLE_CODES[res.role];
  if (code === refCode(r.acct)) { correct++; k.ok++; e2eOk++; }
  else wrong.push(`#${r.n} got ${code} ref=${r.acct} (${res.reason.slice(0, 50)}) | ${r.desc.slice(0, 80)}`);
}

const refPending = rows.filter(isRefPending).length;
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + "%" : "n/a");
console.log(`rows                      : ${rows.length}`);
console.log(`decided by heuristics     : ${decided} (${pct(decided, rows.length)})`);
console.log(`  correct vs reference    : ${correct} (${pct(correct, decided)} of decided)`);
console.log(`left for the LLM tier     : ${undecided} (${pct(undecided, rows.length)})`);
console.log(`PENDING called            : ${pendingCalled}, of which reference agrees: ${pendingHit} (ref has ${refPending})`);
console.log(`\nEnd-to-end with NO LLM (5214 fallback for unknown merchants):`);
console.log(`  agrees with reference on ${e2eOk}/${rows.length} rows (${pct(e2eOk, rows.length)}) — note PENDING rows are counted correct only if the reference also parked them`);
console.log(`  held back as PENDING: ${e2ePending} rows = ${pendingPayees.size} payees to ask about (reference parked ${refPending})`);
console.log("\nresidue for LLM by kind:", undecidedKinds);
console.log("\nby kind:", Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, `${v.ok}/${v.n}`])));
console.log(`\nDisagreements (${wrong.length}), first 40:`);
wrong.slice(0, 40).forEach((w) => console.log("  " + w));
