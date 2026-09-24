/**
 * Measures the §7 engine (no DB, no AI) against the client's 958-row reference workbook.
 *   npx tsx scripts/eval-engine.ts
 * The reference uses the client's old Qoyod chart, so its accounts are translated to the standard tree
 * (same mapping as coa-tree.xlsx → "مثال ربط شجرة عميل"); a few reference accounts map to a SET of
 * acceptable standard codes (e.g. fuel for a logistics company is a direct cost).
 */
import fs from "node:fs";
import path from "node:path";
import { enrichStatementRow, normalizeForSearch } from "../src/modules/extraction/statementEnricher";
import { classifyRow, type EngineContext } from "../src/modules/classification/engine";

type Ref = { n: number; amount: number; desc: string; acct: string; status: string };
const rows: Ref[] = JSON.parse(fs.readFileSync(path.join(__dirname, "reference-2025.json"), "utf8"));

const OK: Record<string, string[]> = {
  "5214": ["530901"], "5212": ["530703"], "5219": ["530601", "510203", "510204", "530602"], "5213": ["540102", "110601"],
  "1103": ["110201"], "5209": ["530402", "530305"], "1107": ["110301", "340102"], "5102": ["530101"],
  "520802": ["530206", "530201", "530903"], "110202": ["110802", "110105"], "520801": ["530201"], "5204": ["530301", "530302"],
  "4201": ["420107", "420101"], "1105": ["110302"], "5304": ["540101"], "110403": ["110502"], "5104": ["510103"], "5203": ["520101"],
};
const refCode = (a: string) => a.match(/^\d+/)?.[0] ?? "PENDING";

const ctx: EngineContext = { activity: "logistics", clientRules: [], memoryRules: [], knownCustomers: [], sadadBillers: new Map() };
let auto = 0, review = 0, q = 0, none = 0, ok = 0, decided = 0, miscAuto = 0;
const qGroups = new Set<string>();
const byStage: Record<string, number> = {};
const wrong: string[] = [];

for (const r of rows) {
  const e = enrichStatementRow(r.desc, r.amount);
  const o = classifyRow({ description: r.desc, amount: r.amount, e, beneficiaryKey: e.beneficiaryKey, counterparty: e.counterparty ?? null }, ctx);
  if (!o) { none++; qGroups.add(e.beneficiaryKey ?? normalizeForSearch(e.merchant ?? "") ?? `row${r.n}`); continue; }
  if (o.decision === "question") { q++; qGroups.add(`${o.questionId}|${e.beneficiaryKey ?? normalizeForSearch(e.merchant ?? e.counterparty ?? "")}`); continue; }
  byStage[o.stage] = (byStage[o.stage] ?? 0) + 1;
  o.confidence >= 0.9 ? auto++ : review++;
  decided++;
  const code = o.target.stdCode!;
  if (code === "530901") miscAuto++;
  const good = (OK[refCode(r.acct)] ?? []).includes(code) || (refCode(r.acct) === "PENDING");
  good ? ok++ : wrong.push(`#${r.n} got ${code} [${o.stage}] ref=${r.acct} | ${r.desc.slice(0, 70)}`);
}
const pct = (a: number, b: number) => ((100 * a) / b).toFixed(1) + "%";
console.log(`rows ${rows.length}`);
console.log(`assigned automatically      : ${decided} (${pct(decided, rows.length)})  [≥0.90: ${auto}, 0.70–0.89 quick-review: ${review}]`);
console.log(`  agree with the reference  : ${ok} (${pct(ok, decided)} of assigned)`);
console.log(`  assigned to Misc (must be 0): ${miscAuto}`);
console.log(`by stage                    :`, byStage);
console.log(`→ asked (rule/evidence says ask): ${q} rows · left for AI: ${none} rows`);
console.log(`distinct groups that need an answer or the AI: ${qGroups.size}`);
console.log(`\nDisagreements (${wrong.length}) — first 25:`);
wrong.slice(0, 25).forEach((w) => console.log("  " + w));
