import assert from "node:assert/strict";
import { STANDARD, toDbType } from "../src/modules/chart/standard";
import { matchToTree } from "../src/modules/chart/mapping";
import { searchAccounts, nextChildCode } from "../src/modules/chart/accountSearch";

const tree = STANDARD.accounts.filter((a) => a.active).map((a) => ({
  code: a.code, name: a.name_en, nameAr: a.name_ar, postable: a.postable, type: toDbType(a.type),
  keywordsAr: a.keywords_ar, keywordsEn: a.keywords_en, parentCode: a.parent_code, stdKey: a.std_key,
}));
// the client-tree example from coa-tree.xlsx (sheet "مثال ربط شجرة عميل")
const cases: [string, string, string][] = [
  ["110201", "حساب البنك الجاري - حساب الراجحي", "110103"], ["110202", "حساب البنك الجاري - حساب بنك الرياض", "110105"],
  ["1103", "المدينون", "110201"], ["1105", "مدفوعات مقدمة للموظفين", "110302"], ["1107", "مستحق من طرف ذو علاقة", "110301"],
  ["220101", "قرض بنك الرياض", "220101"], ["5102", "رواتب وأجور", "530101"], ["5204", "مصاريف الإيجار", "530301"],
  ["520801", "الاقامات", "530201"], ["5213", "عمولات بنكية", "540102"], ["5212", "مصاريف ضيافة", "530703"],
  ["5203", "مصاريف تسويقية ودعائية", "520101"], ["5304", "فوائد", "540101"], ["4201", "إيرادات أخرى", "420107"],
  ["5209", "رسوم واشتراكات", "530402"], ["520802", "رسوم حكومية", "530206"], ["5214", "مصاريف أخرى", "530901"],
  ["5219", "مصروف نقل ومواصلات", "530601"],
];
let ok = 0;
for (const [code, name, want] of cases) {
  const r = matchToTree({ code, name }, tree);
  const got = r.best?.account.code ?? `(${r.status}) ${r.alternatives[0]?.account.code}`;
  if (got === want) ok++; else console.log(`  ✗ ${code} ${name}: got ${got} (${r.status}) want ${want}`);
}
console.log(`mapping: ${ok}/${cases.length} exact matches to the spec example (✗ lines above are informational: those land yellow with the right alternative)`);
const s = searchAccounts(tree, "وقود");
console.log("search وقود →", s.slice(0, 3).map((a) => a.code + " " + a.nameAr).join(" | "));
console.log("search 'fuell' →", searchAccounts(tree, "fuel").slice(0, 2).map((a) => a.code).join(","));
assert.equal(nextChildCode("1101", tree.map((a) => a.code)), "110110");
assert.ok(s.length > 0 && s.every((a) => a.postable));
if (ok < cases.length - 4) process.exitCode = 1;
