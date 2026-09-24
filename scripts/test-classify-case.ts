/**
 * Glue test for classifyCase() with an in-memory fake DB and a fake AI provider — no Postgres, no network.
 * Feeds the 958 reference rows through the REAL pipeline on the STANDARD chart and checks the policy:
 *   · nothing is ever assigned to the miscellaneous account automatically
 *   · every unresolved row is parked with a question id (never dropped, never guessed)
 *   · an AI failure degrades to questions, it does not crash or guess
 *   · identical merchants share one AI signature
 */
process.env.DATABASE_URL ??= "postgresql://test"; process.env.JWT_SECRET ??= "test";
import fs from "node:fs";
import path from "node:path";
const stub = require.resolve("../src/lib/prisma");
require.cache[stub] = { id: stub, filename: stub, loaded: true, exports: { prisma: {} } } as any;
const { classifyCase } = require("../src/modules/classification/classify-case");
const { STANDARD, toDbType } = require("../src/modules/chart/standard");

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "reference-2025.json"), "utf8"));
const chart = STANDARD.accounts.map((a: any) => ({
  id: `a${a.code}`, firmId: "f", caseId: "c", code: a.code, name: a.name_en, nameAr: a.name_ar, type: toDbType(a.type),
  parentCode: a.parent_code, postable: a.postable, active: true, stdKey: a.std_key, level: a.level,
}));
const txns: any[] = ref.map((r: any, i: number) => ({
  id: `t${i}`, caseId: "c", firmId: "f", date: new Date(2025, 3, 8 + Math.floor(i / 4)), description: r.desc, counterparty: null, amount: r.amount,
  categoryAccountId: null, categoryConfidence: 0, categorySource: null,
}));
const fakeDb: any = {
  case: { findFirst: async () => ({ id: "c", chartMode: "standard", client: { id: "cl", name: "شركة نخلة الخليج للخدمات اللوجستية", activity: "logistics" } }), update: async () => ({}) },
  bankTransaction: { findMany: async () => txns.filter((t) => !t.categoryAccountId), update: async ({ where, data }: any) => Object.assign(txns.find((t) => t.id === where.id), data) },
  classificationRule: { findMany: async () => [] },
  account: { findMany: async () => chart, count: async () => chart.length },
  invoice: { findMany: async () => [] },
};
function provider(mode: "works" | "fails" | "none"): any {
  let calls = 0, signatures = 0;
  return {
    name: mode === "none" ? "none" : "fake", supportsVision: false,
    get calls() { return calls; }, get signatures() { return signatures; },
    suggestCategoryBatch: async (items: any[], cands: any[]) => {
      calls++; signatures += items.length;
      if (mode === "fails") throw new Error("429 rate limited");
      if (cands.some((c) => c.code === "530901")) throw new Error("misc must never be offered to the AI");
      return items.map((i) => ({ id: i.id, accountCode: "530402", confidence: 0.8, reason: "fake AI" }));
    },
  };
}
let bad = 0;
const expect = (cond: boolean, msg: string) => { if (!cond) { bad++; console.error("  ✗", msg); } else console.log("  ✓", msg); };
async function run(mode: "works" | "fails" | "none") {
  txns.forEach((t) => Object.assign(t, { categoryAccountId: null, categoryConfidence: 0, categorySource: null, enrichment: undefined }));
  const p = provider(mode);
  await classifyCase("c", "f", { db: fakeDb, provider: p });
  const classified = txns.filter((t) => t.categoryAccountId);
  const pending = txns.filter((t) => !t.categoryAccountId);
  console.log(`\n[AI ${mode}] classified ${classified.length}/${txns.length}; pending ${pending.length}; AI calls=${p.calls}, signatures=${p.signatures}`);
  expect(!classified.some((t) => t.categoryAccountId === "a530901"), "nothing auto-assigned to Miscellaneous Expenses");
  expect(pending.every((t) => t.enrichment?.pending && /^Q\d\d$/.test(t.enrichment.questionId)), "every pending row carries its question id (Q01–Q10)");
  expect(classified.every((t) => t.categoryReason), "every assigned row has a reason");
  if (mode === "works") expect(p.signatures < txns.length / 2, "AI called once per unique signature, not per row");
  if (mode === "fails") expect(classified.length > 500, "AI failure still leaves the deterministic tiers working");
}
(async () => { for (const m of ["works", "fails", "none"] as const) await run(m); process.exitCode = bad ? 1 : 0; })();
