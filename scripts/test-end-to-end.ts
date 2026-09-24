/**
 * END TO END on the standard chart, in memory (no Postgres, no network, AI off):
 *   statement → extract (bank account per statement) → classify → questions → opening balances
 *   ("unavailable now" AND "uploaded from a قيود-style file") → Trial Balance → release gate.
 *   npx tsx scripts/test-end-to-end.ts
 */
process.env.AI_PROVIDER = "none"; process.env.AI_API_KEY = "";
process.env.DATABASE_URL ??= "postgresql://test"; process.env.JWT_SECRET ??= "test";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { STANDARD, toDbType } from "../src/modules/chart/standard";
import { toXlsx } from "../tests/fixtures-tb";

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
      if ("not" in v) return v.not === null ? x != null : x !== v.not;
      if ("lt" in v) return x != null && Number(x) < v.lt;
      if ("gt" in v) return x != null && Number(x) > v.gt;
      if ("gte" in v) return x != null && Number(x) >= v.gte;
      if ("startsWith" in v) return typeof x === "string" && x.startsWith(v.startsWith);
      if ("equals" in v) return x === v.equals;
    }
    return x === v;
  });
const withInclude = (name: string, r: any, include: any) => {
  if (!include) return r;
  const out = { ...r };
  if (name === "journalLine" && include.account) out.account = T("account").find((a) => a.id === r.accountId);
  return out;
};
const model = (name: string) => ({
  findMany: async ({ where, include }: any = {}) => T(name).filter((r) => match(r, where)).map((r) => withInclude(name, r, include)),
  findFirst: async ({ where }: any = {}) => T(name).find((r) => match(r, where)) ?? null,
  findUnique: async ({ where }: any) => T(name).find((r) => match(r, where)) ?? null,
  count: async ({ where }: any = {}) => T(name).filter((r) => match(r, where)).length,
  create: async ({ data }: any) => { const r = { id: `${name}${++seq}`, createdAt: new Date(), ...data }; T(name).push(r); return r; },
  createMany: async ({ data }: any) => { for (const d of data) T(name).push({ id: `${name}${++seq}`, createdAt: new Date(), matchStatus: "UNMATCHED", ...d }); return { count: data.length }; },
  update: async ({ where, data }: any) => Object.assign(T(name).find((r) => match(r, where))!, data),
  updateMany: async ({ where, data }: any) => { const rows = T(name).filter((r) => match(r, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
  deleteMany: async ({ where }: any = {}) => { const keep = T(name).filter((r) => !match(r, where)); const n = T(name).length - keep.length; tables[name] = keep; return { count: n }; },
  groupBy: async ({ by, where, _max, _min }: any) => {
    const g = new Map<string, any[]>();
    for (const r of T(name).filter((x) => match(x, where))) { const k = by.map((b: string) => r[b]).join("|"); (g.get(k) ?? g.set(k, []).get(k)!).push(r); }
    return [...g.values()].map((rows) => ({ ...Object.fromEntries(by.map((b: string) => [b, rows[0][b]])),
      _max: _max ? Object.fromEntries(Object.keys(_max).map((f) => [f, new Date(Math.max(...rows.map((r) => +r[f])))])) : undefined,
      _min: _min ? Object.fromEntries(Object.keys(_min).map((f) => [f, new Date(Math.min(...rows.map((r) => +r[f])))])) : undefined }));
  },
});
const fakePrisma: any = new Proxy({}, { get: (_t, n: string) => (n === "$transaction" ? async (fn: any) => fn(fakePrisma) : model(n)) });
const M: any = Module; void M;
let statementBuffer = Buffer.alloc(0);
for (const [file, exports] of [
  [require.resolve("../src/lib/prisma"), { prisma: fakePrisma }],
  [require.resolve("../src/lib/storage"), { readFile: async () => statementBuffer, saveFile: async () => ({}) }],
] as [string, any][]) require.cache[file] = { id: file, filename: file, loaded: true, exports } as any;

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "reference-2025.json"), "utf8"));
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const line = (r: any) => { const [y, m, d] = String(r.date).slice(0, 10).split("-"); return `${money(r.balance)} SAR ${money(r.amount > 0 ? r.amount : 0)} SAR ${money(r.amount < 0 ? -r.amount : 0)} SAR ${r.desc.replace(/\s+/g, " ")} ${y}/${m}/${d}`; };

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

(async () => {
  T("case").push({ id: "c1", firmId: "f", status: "OPEN", chartMode: "standard", openingMode: null, openingBalancesConfirmed: false, adjustmentsConfirmed: false, clientId: "cl", client: { id: "cl", name: "شركة نخلة الخليج للخدمات اللوجستية", activity: "logistics", materialityThreshold: 200 } });
  STANDARD.accounts.forEach((a: any) => T("account").push({ id: `a${a.code}`, firmId: "f", caseId: "c1", code: a.code, name: a.name_en, nameAr: a.name_ar, type: toDbType(a.type), parentCode: a.parent_code, postable: a.postable, active: true, stdKey: a.std_key, level: a.level, nature: a.nature, statement: a.statement, fsLine: a.fs_line_ar, cfClass: a.cf_class, isContra: a.is_contra, systemLocked: a.system_locked, openingBalance: 0, keywordsAr: a.keywords_ar, keywordsEn: a.keywords_en, requiresSupportingDoc: false }));
  T("document").push({ id: "d1", firmId: "f", caseId: "c1", type: "BANK_STATEMENT", fileName: "rajhi.txt", mimeType: "text/plain", storageKey: "k", storageDriver: "local", status: "UPLOADED", bankName: "Al Rajhi", uploadedAt: new Date() });
  statementBuffer = Buffer.from("مصرف الراجحي كشف حساب جاري\n" + ref.map(line).join("\n"), "utf8");

  const { processCase } = await import("../src/modules/cases/processing.service");
  await processCase("c1", "f");
  const doc = T("document")[0];
  check("bank account created for the statement", doc.bankAccountId === "a110103", `opening ${doc.openingBalance} → closing ${doc.closingBalance}`);

  const { generateTrialBalance } = await import("../src/modules/trial-balance/trial-balance.service");
  const { computeReadiness } = await import("../src/modules/trial-balance/readiness.service");
  const ob = await import("../src/modules/opening-balances/opening-balances.service");

  // 1 ── Trial Balance is NOT blocked by 353 unanswered rows / open questions
  let tb = await generateTrialBalance("c1", "f");
  check("TB builds although rows are unresolved (no dead end)", tb.rows.length > 0 && tb.balanced);
  check("unresolved rows sit in the suspense account and a warning says so", tb.rows.some((r: any) => r.code === "110801") && tb.warnings.length === 1);
  let r = await computeReadiness("c1", "f");
  check("gate: opening balances is a blocker until step 4 is decided", r.blockers.some((b: any) => b.key === "opening_balances"));

  // 2 ── "unavailable now": bank opening from the first statement, the other side in 330103
  const res: any = await ob.setMode("c1", "f", "unavailable");
  tb = await generateTrialBalance("c1", "f");
  const unalloc = tb.rows.find((x: any) => x.code === "330103");
  check("«غير متوفر الآن» puts the counter-balance in 330103 and the TB stays balanced", !!unalloc && tb.balanced, `330103 = ${unalloc ? unalloc.credit - unalloc.debit : "-"}`);
  r = await computeReadiness("c1", "f");
  check("bank balance equals the last printed balance (release check)", !r.items.find((i: any) => i.key === "bank_balances")!.detailAr && r.items.find((i: any) => i.key === "bank_balances")!.status === "complete");
  check("still a blocker for FINAL release (needs the real TB) but a draft is possible", r.blockers.map((b: any) => b.key).join() === "opening_balances");

  // 3 ── upload a قيود-style prior-year TB (numbers/names differ from our tree) and map it
  const rows: (string | number)[][] = [
    ["ميزان المراجعة"], ["شركة نخلة الخليج"], ["الفترة من ٢٠٢٤-٠١-٠١ إلى ٢٠٢٤-١٢-٣١"], [""],
    ["الحساب", "الرصيد الافتتاحي", "", "الحركة", "", "الرصيد الختامي", ""],
    ["", "مدين", "دائن", "مدين", "دائن", "مدين", "دائن"],
    ["الأصول - 1", "", "", "", "", "", ""],
    ["حساب البنك الجاري - حساب الراجحي - 110201", 0, 0, 500000, 0, 500000, 0],
    ["المدينون - 1103", 0, 0, 120000, 0, 120000, 0],
    ["حقوق الملكية - 3"],
    ["رأس المال - 3101", 0, 0, 0, 620000, 0, 620000],
    ["مجموع", 0, 0, 620000, 620000, 620000, 620000],
  ];
  const file = toXlsx([{ rows, merges: ["B5:C5", "D5:E5", "F5:G5"] }]);
  const mapped = await ob.readAndMap("c1", "f", file, "qoyod.xlsx");
  check("قيود file read; 3 final accounts, structure kept", mapped.read.status === "OK" && mapped.read.accounts.length === 3, JSON.stringify(mapped.summary));
  const byName = (n: string) => mapped.mapping.find((m: any) => m.source.name.includes(n))!;
  check("bank account mapped to a bank account of our tree (not to receivables 110201)", ["110103"].includes(mapped.mapping.find((m: any) => /الراجحي/.test(m.source.name))!.alternatives[0].code) || byName("الراجحي").alternatives.some((a: any) => a.code === "110103"), `→ ${byName("الراجحي").alternatives.slice(0, 2).map((a: any) => a.code).join(", ")}`);
  const applied: any = await ob.applyImport("c1", "f", mapped.mapping.map((m: any) => ({ key: m.key, code: m.source.code, name: m.source.name, balance: m.source.balance })), { autoAccept: true });
  check("mapping applied, balanced", applied.applied === true, JSON.stringify(applied));
  const opening = await ob.listOpeningBalances("c1", "f");
  check("opening balances balanced, mode = uploaded", opening.totals.balanced && opening.mode === "uploaded" && opening.confirmed);

  // 4 ── the release gate now reflects the real position
  tb = await generateTrialBalance("c1", "f");
  r = await computeReadiness("c1", "f");
  console.log("     blockers:", r.blockers.map((b: any) => `${b.key}: ${b.detailAr}`));
  check("TB balanced with the uploaded opening balances", tb.balanced);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
