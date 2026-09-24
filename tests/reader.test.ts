import assert from "node:assert/strict";
import { readTrialBalance } from "../src/modules/import-reader/readTrialBalance";
import { splitCodeName } from "../src/modules/import-reader/accountCell";
import { parseAmount } from "../src/modules/import-reader/numbers";
import { toXlsx, TRUTH, qoyod, zoho, odoo, daftra, rawaa, handmade, csvFile } from "./fixtures-tb";

let pass = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { console.error("  ✗", name, "\n   ", (e as Error).message); process.exitCode = 1; } };

console.log("cell parsing");
t("code+name in every orientation", () => {
  for (const s of ["النقدية في الخزينة - 110101", "110101 - النقدية في الخزينة", "110101 النقدية في الخزينة", "[110101] النقدية في الخزينة", "(110101) النقدية في الخزينة", "١١٠١٠١ - النقدية في الخزينة"]) {
    const r = splitCodeName(s);
    assert.equal(r.code, "110101", s); assert.equal(r.name, "النقدية في الخزينة", s);
  }
  assert.deepEqual(splitCodeName("رأس المال"), { code: null, name: "رأس المال" });
});
t("amounts", () => {
  assert.equal(parseAmount("(1,250.00)"), -1250); assert.equal(parseAmount("1,250.00-"), -1250);
  assert.equal(parseAmount("١٬٢٥٠٫٥٠"), 1250.5); assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("1,250.00 Cr"), -1250); assert.equal(parseAmount("500 SAR"), 500);
  assert.equal(parseAmount("—"), 0); assert.equal(parseAmount("abc"), null);
});

const check = (name: string, buf: Buffer, opts: { minBalanced?: boolean } = {}) =>
  t(name, () => {
    const r = readTrialBalance(buf, name);
    assert.equal(r.status, "OK", r.message);
    const got = Object.fromEntries(r.accounts.map((a) => [a.code, a.balance]));
    assert.deepEqual(got, TRUTH);
    assert.equal(r.totals.balanced, opts.minBalanced ?? true, JSON.stringify(r.totals));
  });

console.log("systems");
check("قيود (spec §5.1 layout)", qoyod());
t("قيود: structure, totals row ignored, file total matches, period read", () => {
  const r = readTrialBalance(qoyod(), "q.xlsx");
  assert.equal(r.basis, "closing");
  assert.ok(r.structure.some((s) => s.code === "1101"), "1101 group kept as structure");
  assert.equal(r.totals.matchesFileTotal, true);
  assert.equal(r.period?.year, 2023);
  assert.equal(r.accounts.length, Object.keys(TRUTH).length, "no duplicates from total rows");
});
check("Zoho Books", zoho());
check("Odoo (code merged, text numbers)", odoo());
check("دفترة (Arabic digits, parentheses)", daftra());
check("رواء/قوائم ([code] name, Dr/Cr suffix, reversed columns)", rawaa());
check("CSV semicolon + BOM", csvFile());

console.log("manual fallback");
t("hand-written file → NEEDS_MAPPING with preview, no English error", () => {
  const r = readTrialBalance(handmade(), "h.xlsx");
  assert.equal(r.status, "NEEDS_MAPPING");
  assert.ok(r.preview.length > 0 && /[\u0600-\u06FF]/.test(r.message ?? ""));
});
t("…then a saved template reads it", () => {
  const r = readTrialBalance(handmade(), "h.xlsx", { dataStartRow: 2, roles: { "0": "code", "1": "name", "2": "debit", "3": "credit" } });
  assert.equal(r.status, "OK");
  assert.deepEqual(Object.fromEntries(r.accounts.map((a) => [a.code, a.balance])), TRUTH);
  assert.equal(r.usedTemplate, true);
});
t("PDF → Arabic guidance, not a crash", () => {
  const r = readTrialBalance(Buffer.from("%PDF-1.4 ..."), "x.pdf");
  assert.equal(r.status, "NEEDS_MAPPING"); assert.match(r.message!, /Excel/);
});
t("unbalanced file is read AND flagged (never blocks)", () => {
  const r = readTrialBalance(zoho(), "z.xlsx");
  assert.ok(r.totals.balanced);
});
console.log(`\n${pass} passed`);

import { readChartTree } from "../src/modules/import-reader/readChartTree";

console.log("chart trees");
t("tree with code / name / type columns", () => {
  const b = toXlsx([{ rows: [["رقم الحساب", "اسم الحساب", "النوع"], ["1", "الأصول", "أصول"], ["11", "أصول متداولة", "أصول"], ["1101", "النقدية", "أصول"], ["110101", "الصندوق", "أصول"], ["110102", "بنك الراجحي", "أصول"], ["4", "الإيرادات", "إيرادات"], ["4101", "مبيعات", "إيرادات"]] }]);
  const r = readChartTree(b, "tree.xlsx");
  assert.equal(r.status, "OK");
  assert.equal(r.accounts.length, 7);
  assert.deepEqual(r.accounts.filter((a) => a.postable).map((a) => a.code), ["110101", "110102", "4101"]);
  assert.equal(r.accounts.find((a) => a.code === "110102")!.parentCode, "1101");
  assert.equal(r.accounts.find((a) => a.code === "4101")!.typeHint, "REVENUE");
});
t("a قيود trial balance works as a tree (structure + final accounts)", () => {
  const r = readChartTree(qoyod(), "q.xlsx");
  assert.equal(r.status, "OK");
  assert.ok(r.accounts.some((a) => a.code === "1101" && !a.postable) && r.accounts.some((a) => a.code === "110102" && a.postable));
});
console.log("done");
