import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { seedStandardChart } from "@/modules/chart/chart.service";
import { STANDARD } from "@/modules/chart/standard";

/**
 * Seeds one demo firm: a login, one demo client and one file.
 *
 * The chart of accounts is NOT seeded per firm any more: every FILE gets its own copy of the standard
 * 252-account tree when it is created (spec §4.1), so no account list can ever be empty. The 62 system
 * rules, the merchant directory and the questionnaire ship inside the code (src/data/coa_seed.json).
 *
 * Safe to re-run.
 */
async function main() {
  const email = "demo@accountic.sa";
  const passwordHash = await bcrypt.hash("demo12345", 12);

  const firm = await prisma.firm.upsert({
    where: { id: "demo-firm" },
    update: {},
    create: {
      id: "demo-firm",
      name: "Al Fanar Accounting Partners",
      nameAr: "شركاء الفنار للمحاسبة",
      users: { create: { email, passwordHash, name: "Demo Accountant", role: "OWNER" } },
    },
  });

  let client = await prisma.client.findFirst({ where: { firmId: firm.id, name: "Nakhlat Al Khaleej Logistics" } });
  if (!client) {
    client = await prisma.client.create({
      data: { firmId: firm.id, name: "Nakhlat Al Khaleej Logistics", nameAr: "نخلة الخليج للخدمات اللوجستية", activity: "logistics", vatRegistered: true, materialityThreshold: 200 },
    });
  }
  const has = await prisma.case.count({ where: { clientId: client.id } });
  if (!has) {
    const kase = await prisma.case.create({
      data: { firmId: firm.id, clientId: client.id, label: "FY 2025", periodStart: new Date("2025-01-01"), periodEnd: new Date("2025-12-31"), chartMode: "standard" },
    });
    await seedStandardChart(prisma, firm.id, kase.id);
  }
  console.log(`Seeded demo firm (${email} / demo12345). Standard chart v${STANDARD.version}: ${STANDARD.accounts.length} accounts per file.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
