/**
 * END-TO-END, STATEMENT ONLY: one bank-statement document, ZERO invoices,
 * AI provider OFF (worst case). Runs the real processCase() pipeline
 * (extract → classify → reconcile → raise-exceptions) against an in-memory
 * fake database and asserts the flow never depends on invoices.
 *
 *   npm run test:statement-only
 */
process.env.AI_PROVIDER = "none";
process.env.AI_API_KEY = "";

process.env.DATABASE_URL ??= "postgresql://test"; process.env.JWT_SECRET ??= "test";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { STANDARD, toDbType } from "../src/modules/chart/standard";

// ── tiny in-memory Prisma ───────────────────────────────────────────────
let seq = 0;
const tables: Record<string, any[]> = {};
const T = (n: string) => (tables[n] ??= []);
const match = (row: any, where: any = {}): boolean =>
  Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((w: any) => match(row, w));
    if (k === "AND") return v.every((w: any) => match(row, w));
    const x = row[k];
    if (v === null) return x == null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(x);
      if ("not" in v) return x !== v.not;
      if ("lt" in v) return x != null && Number(x) < v.lt;
      if ("gt" in v) return x != null && Number(x) > v.gt;
      if ("equals" in v) return x === v.equals;
    }
    return x === v;
  });
const model = (name: string) => ({
  findMany: async ({ where }: any = {}) => T(name).filter((r) => match(r, where)),
  findFirst: async ({ where }: any = {}) => T(name).find((r) => match(r, where)) ?? null,
  findUnique: async ({ where }: any) => T(name).find((r) => match(r, where)) ?? null,
  count: async ({ where }: any = {}) => T(name).filter((r) => match(r, where)).length,
  create: async ({ data }: any) => { const r = { id: `${name}${++seq}`, createdAt: new Date(), ...data }; T(name).push(r); return r; },
  createMany: async ({ data }: any) => { for (const d of data) T(name).push({ id: `${name}${++seq}`, createdAt: new Date(), matchStatus: "UNMATCHED", ...d }); return { count: data.length }; },
  update: async ({ where, data }: any) => Object.assign(T(name).find((r) => match(r, where))!, data),
  updateMany: async ({ where, data }: any) => { const rows = T(name).filter((r) => match(r, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
});
const fakePrisma: any = new Proxy({}, { get: (_t, n: string) => model(n) });

// register mocks for the modules the pipeline imports
const M: any = Module;
const orig = M._resolveFilename;
const mocks = new Map<string, any>();
const mockPath = (rel: string) => require.resolve(rel);
mocks.set(mockPath("../src/lib/prisma"), { prisma: fakePrisma });
let statementBuffer = Buffer.alloc(0);
mocks.set(mockPath("../src/lib/storage"), { readFile: async () => statementBuffer, saveFile: async () => ({}) });
for (const [file, exports] of mocks) require.cache[file] = { id: file, filename: file, loaded: true, exports } as any;

// ── data: the reference statement rendered as Al Rajhi PDF text ──────────
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "reference-2025.json"), "utf8"));
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const line = (r: any) => {
  const [y, m, d] = String(r.date).slice(0, 10).split("-");
  const credit = r.amount > 0 ? r.amount : 0, debit = r.amount < 0 ? -r.amount : 0;
  return `${money(r.balance)} SAR ${money(credit)} SAR ${money(debit)} SAR ${r.desc.replace(/\s+/g, " ")} ${y}/${m}/${d}`;
};
const header = "مصرف الراجحي كشف حساب جاري\n";
const statementText = (rows: any[]) => header + rows.map(line).join("\n");

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

async function scenario(label: string, rows: any[]) {
  Object.keys(tables).forEach((k) => delete tables[k]);
  T("case").push({ id: "c1", firmId: "f", status: "OPEN", chartMode: "standard", clientId: "cl", client: { id: "cl", name: "شركة نخلة الخليج للخدمات اللوجستية", activity: "logistics", materialityThreshold: 200 } });
  STANDARD.accounts.forEach((a: any) => T("account").push({ id: `a${a.code}`, firmId: "f", caseId: "c1", code: a.code, name: a.name_en, nameAr: a.name_ar, type: toDbType(a.type), parentCode: a.parent_code, postable: a.postable, active: true, stdKey: a.std_key, level: a.level, requiresSupportingDoc: a.std_key === "ar.trade" }));
  T("document").push({ id: "d1", firmId: "f", caseId: "c1", type: "BANK_STATEMENT", fileName: "statement.txt", mimeType: "text/plain", storageKey: "k", storageDriver: "local", status: "UPLOADED", bankName: "Al Rajhi" });
  statementBuffer = Buffer.from(statementText(rows), "utf8");

  const { processCase } = await import("../src/modules/cases/processing.service");
  await processCase("c1", "f");

  const doc = T("document")[0];
  const txns = T("bankTransaction");
  const exc = T("exception");
  const byType: Record<string, number> = {};
  exc.forEach((e) => (byType[e.type] = (byType[e.type] ?? 0) + 1));
  console.log(`\n── ${label}\n   doc: ${doc.status} via ${doc.extractionMethod}, report=${doc.extractionReport?.status}; rows=${txns.length}; ` +
    `classified=${txns.filter((t) => t.categoryAccountId).length}; exceptions=${JSON.stringify(byType)}; case=${T("case")[0].status}`);
  return { doc, txns, exc, byType };
}

(async () => {
  // 1) clean statement, no invoices, no AI
  let r = await scenario("clean statement · 0 invoices · AI off", ref);
  check("extracted deterministically and VERIFIED by arithmetic", r.doc.extractionMethod === "deterministic:al-rajhi" && r.doc.extractionReport.status === "VERIFIED");
  check("all 958 rows imported", r.txns.length === 958);
  check("no invoice-related exceptions at all", !r.byType.UNMATCHED_INVOICE && !r.byType.MISSING_SUPPORTING_DOC && !r.byType.POSSIBLE_DUPLICATE);
  check("no integrity exception on a good statement", !r.byType.MISSING_INFO);
  const cls = r.txns.filter((t) => t.categoryAccountId).length;
  check("≥ 60% classified with no AI and no invoices", cls / 958 >= 0.6, `${((100 * cls) / 958).toFixed(1)}%`);
  check("never assigned to Miscellaneous Expenses automatically", !r.txns.some((t) => t.categoryAccountId === "a530901"));
  check("a bank account was created for the statement (110103 Al Rajhi)", r.doc.bankAccountId === "a110103" && r.doc.closingBalance != null);
  const clar = (r.byType.NEEDS_CLIENT_CLARIFICATION ?? 0);
  const pendingRows = r.txns.filter((t) => !t.categoryAccountId).length;
  check("questions are grouped (payee/merchant), not one per row", clar > 0 && clar < pendingRows, `${clar} questions for ${pendingRows} unresolved rows`);
  const qs = T("clarification");
  check("every question is multiple choice with the universal options", qs.length > 0 && qs.every((c: any) => /^Q\d\d$/.test(c.questionId) && c.options?.question?.options?.some((o: any) => o.kind === "defer") && c.options.question.options.some((o: any) => o.kind === "pick")));
  check("small groups are flagged for one-tap approval", qs.some((c: any) => c.options.small === true));
  const big = qs.filter((c: any) => !c.options.small).length;
  console.log(`   questions: ${qs.length} groups → ${big} above the materiality threshold + ${qs.length - big} small groups approved in ONE tap (AI is OFF here; with an AI key most purchases never become questions)`);
  check("questions the accountant must answer one by one (AI off) ≤ 100", big <= 100, `${big}`);
  check("full bank text kept (memo/merchant available)", r.txns.some((t) => /الوقت/.test(t.description)));

  // 2) same statement with one row silently missing (parser can't see it)
  const dropped = ref.filter((_: any, i: number) => i !== 300);
  r = await scenario("statement with a dropped row", dropped);
  check("integrity failure detected", r.doc.extractionReport.status === "FAILED");
  check("blocking MISSING_INFO raised with the gap", r.byType.MISSING_INFO === 1 && /دون عملية تفسّره|صف/.test(r.exc.find((e) => e.type === "MISSING_INFO").note));
  check("case blocked until the accountant reviews it", T("case")[0].status === "EXCEPTIONS");

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
