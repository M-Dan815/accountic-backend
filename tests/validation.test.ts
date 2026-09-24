process.env.DATABASE_URL ??= "postgresql://test"; process.env.JWT_SECRET ??= "test";
import assert from "node:assert/strict";
import { validateStatement, statementBalances } from "../src/modules/extraction/statementValidation";

// §13.5: rows 270–272 have gaps +1,839.82 / +2.30 / −1,842.12 (sum 0) → ONE alert, in Arabic.
const rows: { date: string; amount: number; balance: number }[] = [];
let bal = 10000;
for (let i = 0; i < 300; i++) { const amt = i % 2 ? -25.5 : 40; bal = Math.round((bal + amt) * 100) / 100; rows.push({ date: "2025-04-08", amount: amt, balance: bal }); }
// corrupt the printed balance of rows 270,271 (0-based 269..271) so the gaps are +1839.82, +2.30, −1842.12
rows[269].balance += 1839.82; rows[270].balance += 1839.82 + 2.3; rows[271].balance += 1839.82 + 2.3 - 1842.12 + 0; // returns to a consistent offset of 0 after
for (let i = 272; i < rows.length; i++) rows[i].balance = rows[i].balance; // untouched
const r = validateStatement(rows as never);
console.log(r.status, r.issues.map((i) => `${i.code}: ${i.message}`));
assert.equal(r.status, "FAILED");
assert.equal(r.issues.filter((i) => i.code === "BALANCE_ORDER").length, 1, "one merged alert");
assert.ok(r.issues.every((i) => /[\u0600-\u06FF]/.test(i.message)), "Arabic only");
assert.ok(r.issues.every((i) => i.actions && i.actions.length > 0), "every alert has a button");
const b = statementBalances([{ amount: 100, balance: 1100 }, { amount: -50, balance: 1050 }], "oldest-first");
assert.deepEqual(b, { opening: 1000, closing: 1050 });
console.log("validation ✓");
