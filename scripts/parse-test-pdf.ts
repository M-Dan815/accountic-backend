import pdf from "pdf-parse";
import { parseAlRajhiStatement } from "../src/modules/extraction/parsers/alRajhiStatementParser";
import fs from "node:fs";

async function main() {
  const pdfPath = process.argv[2] ?? "/home/z/my-project/upload/نخلة الخليج من 1-1 الى 12-9.PDF";
  const buf = fs.readFileSync(pdfPath);
  const d = await pdf(buf);
  const txns = parseAlRajhiStatement(d.text);

  console.log("Parsed", txns.length, "transactions");
  let totalCredit = 0, totalDebit = 0;
  for (const t of txns) {
    if (t.amount > 0) totalCredit += t.amount;
    else totalDebit += Math.abs(t.amount);
  }
  console.log("Sum credits:", totalCredit.toFixed(2), "SAR");
  console.log("Sum debits :", totalDebit.toFixed(2), "SAR");
  console.log("Net        :", (totalCredit - totalDebit).toFixed(2), "SAR");
  console.log("---");
  console.log("Statement reports: deposits=840,853.57 withdrawals=842,896.28");
  console.log("Statement opening: 4,525.29 closing: 2,482.58");
  console.log("Expected net (closing - opening):", (2482.58 - 4525.29).toFixed(2), "SAR");
  console.log("Total transactions reported: 116 deposits + 417 withdrawals = 533");
  console.log("---");
  // Look for the specific discrepancy values Anas mentioned
  const targets = [29255.20, 20000, 30600];
  for (const target of targets) {
    const matches = txns.filter(t => Math.abs(Math.abs(t.amount) - target) < 0.01);
    console.log(`Amount ${target}: ${matches.length} matches`);
    matches.slice(0, 3).forEach(m => console.log(`  ${m.date.slice(0,10)} ${m.amount.toFixed(2).padStart(12)} ${m.description.slice(0,80)}`));
  }
  console.log("---");
  // Check balance continuity (running balance vs computed balance)
  let runningBalance = 4525.29; // opening
  let maxDrift = 0;
  let firstDriftIdx = -1;
  for (let i = 0; i < txns.length; i++) {
    const t = txns[i];
    runningBalance += t.amount;
    if (t.balance != null) {
      const drift = Math.abs(t.balance - runningBalance);
      if (drift > maxDrift) maxDrift = drift;
      if (drift > 0.01 && firstDriftIdx === -1) firstDriftIdx = i;
    }
  }
  console.log("Max balance drift:", maxDrift.toFixed(2), "SAR");
  console.log("First drift index:", firstDriftIdx);
  if (firstDriftIdx > -1) {
    console.log("Context around first drift:");
    for (let i = Math.max(0, firstDriftIdx - 2); i < Math.min(txns.length, firstDriftIdx + 3); i++) {
      const t = txns[i];
      const expected = t.balance;
      console.log(`  [${i}] ${t.date.slice(0,10)} ${t.amount.toFixed(2).padStart(12)} bal-printed=${(t.balance ?? 0).toFixed(2).padStart(12)} ${t.description.slice(0,70)}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
