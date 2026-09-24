/**
 * One-off, safe to re-run: gives every existing file whose firm never had accounts (the empty
 * "اختر حسابًا" list, spec §13.2) its own copy of the standard chart. Files that already work on the
 * old firm-level accounts are left exactly as they are.
 *
 *   npx tsx scripts/backfill-charts.ts
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { getChartScope } from "../src/modules/chart/chart.service";

(async () => {
  const cases = await prisma.case.findMany({ where: { chartMode: "legacy" }, select: { id: true, firmId: true, label: true } });
  let healed = 0, kept = 0;
  for (const c of cases) {
    const scope = await getChartScope(c.id, c.firmId);
    if (scope.mode === "standard") { healed++; console.log(`  + ${c.label} (${c.id}) → standard chart`); } else kept++;
  }
  console.log(`\n${healed} file(s) received the standard chart · ${kept} keep their existing firm-level accounts.`);
  await prisma.$disconnect();
})();
