/**
 * Verifies the "AI reads the pages, arithmetic checks the AI" design with a
 * fake vision provider fed by the 958-row reference statement (real running
 * balances). No network, no DB.
 *
 *   npm run test:extraction
 */
process.env.DATABASE_URL ??= "postgresql://test"; process.env.JWT_SECRET ??= "test";
import fs from "node:fs";
import path from "node:path";
import { extractStatementFromPages } from "../src/modules/extraction/statementVision";
import { validateStatement } from "../src/modules/extraction/statementValidation";

type Row = { date: string; amount: number; balance?: number; rawText: string; description: string };
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "reference-2025.json"), "utf8"));
const base: Row[] = ref.map((r: any) => ({
  date: String(r.date).slice(0, 10), amount: r.amount, balance: r.balance,
  rawText: r.desc, description: r.desc.slice(0, 60),
}));
const PER_PAGE = 25;
const pageCount = (n: number) => Math.ceil(n / PER_PAGE);
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
};

type Fault = (rows: Row[], firstPage: number, lastPage: number, call: number) => Row[];
function fakeProvider(rows: Row[], fault?: Fault) {
  let call = 0;
  return {
    name: "fake",
    extractBankStatementFromImages: async (images: { data: Buffer }[]) => {
      call++;
      const pages = images.map((i) => i.data.readUInt16BE(0));
      const first = Math.min(...pages), last = Math.max(...pages);
      let out = rows.slice(first * PER_PAGE, (last + 1) * PER_PAGE);
      if (fault) out = fault(out, first, last, call);
      return { transactions: out };
    },
  };
}
const pagesFor = (n: number) => Array.from({ length: pageCount(n) }, (_, i) => { const b = Buffer.alloc(2); b.writeUInt16BE(i); return b; });

(async () => {
  const pages = pagesFor(base.length);

  // a) perfect
  let r = await extractStatementFromPages(fakeProvider(base), pages);
  check("a) clean read verifies", r.report.status === "VERIFIED" && r.transactions.length === 958,
    `rows=${r.transactions.length} chunks=${r.chunks} status=${r.report.status} dir=${r.report.direction}`);

  // b) transient drop in one chunk, healed by page-by-page re-read
  r = await extractStatementFromPages(
    fakeProvider(base, (rows, f, l, call) => (call === 5 && l > f ? rows.filter((_, i) => i !== 7) : rows)), pages);
  check("b) transient dropped row is caught and re-read", r.report.status === "VERIFIED" && r.transactions.length === 958 && r.retried === 1,
    `rows=${r.transactions.length} retried=${r.retried}`);

  // c) persistent dropped row → must FAIL loudly and say where/how much
  const dropIdx = 400, dropped = base[dropIdx];
  const withoutRow = base.filter((_, i) => i !== dropIdx);
  const pagesC = pagesFor(withoutRow.length);
  r = await extractStatementFromPages(fakeProvider(withoutRow), pagesC);
  const brk = r.report.issues.find((i) => i.code === "BALANCE_BREAK");
  check("c) persistently dropped row is reported, not swallowed", r.report.status === "FAILED" && !!brk &&
    Math.abs(Math.abs(brk.gap!) - Math.abs(dropped.amount)) < 0.02,
    `status=${r.report.status} break@row ${brk?.index} gap=${brk?.gap} (dropped amount ${dropped.amount})`);

  // d) misread digit (amount 1,000 → 10,000) persistently
  const misread = base.map((x, i) => (i === 250 ? { ...x, amount: x.amount * 10 } : x));
  r = await extractStatementFromPages(fakeProvider(misread), pages);
  check("d) misread amount is caught", r.report.status === "FAILED", `issues=${r.report.issues.length}`);

  // e) debit/credit swapped on a row
  const swapped = base.map((x, i) => (i === 600 ? { ...x, amount: -x.amount } : x));
  r = await extractStatementFromPages(fakeProvider(swapped), pages);
  check("e) swapped debit/credit is caught", r.report.status === "FAILED");

  // f) newest-first statement (banks differ) still verifies
  const rev = [...base].reverse();
  r = await extractStatementFromPages(fakeProvider(rev), pages);
  check("f) newest-first layout verifies", r.report.status === "VERIFIED" && r.report.direction === "newest-first",
    `dir=${r.report.direction}`);

  // g) statement with no balance column can't be proven — say so honestly
  const noBal = base.map(({ balance, ...x }) => x);
  r = await extractStatementFromPages(fakeProvider(noBal), pages);
  check("g) no balance column → UNVERIFIED (not falsely 'verified')", r.report.status === "UNVERIFIED");

  // h) opening/closing catches a truncated statement
  const truncated = base.slice(0, 500);
  const rep = validateStatement(truncated, { openingBalance: base[0].balance! - base[0].amount, closingBalance: base[957].balance });
  check("h) truncated statement fails opening/closing check", rep.status === "FAILED" && rep.issues.some((i) => i.code === "OPENING_CLOSING_MISMATCH"));

  // i) whole reference workbook validates (ground truth)
  const gt = validateStatement(base);
  check("i) reference workbook verifies as-is", gt.status === "VERIFIED", `checked=${gt.balanceChecked}`);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
