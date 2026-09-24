import type { Account, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound } from "@/lib/http-error";
import { normalizeText } from "@/lib/arabic";
import { nextChildCode } from "./accountSearch";
import { resolveStd } from "./resolve";
import { STANDARD, STD_BY_CODE, SYS, toDbType } from "./standard";

type Db = PrismaClient | Prisma.TransactionClient;

/** Which set of accounts a request works on: one file's own chart, or the legacy firm-level one. */
export type ChartScope = { firmId: string; caseId: string | null; mode: "standard" | "client" | "legacy" };
export const accountWhere = (s: ChartScope) => ({ firmId: s.firmId, caseId: s.caseId });

/** Copy the 252-account standard tree into a file (spec §4.1: "ُتنشأ فورًا لهذا الملف"). */
export async function seedStandardChart(db: Db, firmId: string, caseId: string) {
  await db.account.createMany({
    data: STANDARD.accounts.map((a) => ({
      firmId, caseId, code: a.code, name: a.name_en, nameAr: a.name_ar, type: toDbType(a.type),
      parentCode: a.parent_code, postable: a.postable, level: a.level, nature: a.nature, statement: a.statement,
      fsLine: a.fs_line_ar, fsLineEn: a.fs_line_en, cfClass: a.cf_class, stdKey: a.std_key, isContra: a.is_contra,
      systemLocked: a.system_locked, vatDefault: a.vat_default, keywordsAr: a.keywords_ar, keywordsEn: a.keywords_en,
      active: a.active,
      requiresSupportingDoc: ["ar.trade", "equity.capital", "loan.short", "loan.long"].includes(a.std_key ?? "") ,
    })),
    skipDuplicates: true,
  });
}

/**
 * The chart a request must use. A file that pre-dates per-file charts and whose
 * firm never had accounts (new firms got NONE — the empty "اختر حساباً" list) is
 * given the standard tree on first touch, so every existing file heals itself.
 */
export async function getChartScope(caseId: string, firmId: string, db: Db = prisma): Promise<ChartScope> {
  const kase = await db.case.findFirst({ where: { id: caseId, firmId }, select: { id: true, chartMode: true } });
  if (!kase) throw notFound("Case not found");
  if (kase.chartMode === "legacy") {
    const legacy = await db.account.count({ where: { firmId, caseId: null } });
    if (legacy > 0) return { firmId, caseId: null, mode: "legacy" };
    await seedStandardChart(db, firmId, caseId);
    await db.case.update({ where: { id: caseId }, data: { chartMode: "standard" } });
    return { firmId, caseId, mode: "standard" };
  }
  const n = await db.account.count({ where: { firmId, caseId } });
  if (n === 0 && kase.chartMode === "standard") await seedStandardChart(db, firmId, caseId);
  return { firmId, caseId, mode: kase.chartMode as ChartScope["mode"] };
}

export async function listChart(scope: ChartScope, db: Db = prisma): Promise<Account[]> {
  return db.account.findMany({ where: accountWhere(scope), orderBy: { code: "asc" } });
}

export { resolveStd };

/** System account (suspense, internal transfers, …) — created on the fly if a client tree lacks it. */
export async function ensureSystemAccount(scope: ChartScope, key: keyof typeof SYS, db: Db = prisma): Promise<Account> {
  const std = STD_BY_CODE.get(SYS[key])!;
  const chart = await listChart(scope, db);
  const found = resolveStd(chart, std.code);
  if (found) return found;
  return db.account.create({
    data: {
      firmId: scope.firmId, caseId: scope.caseId, code: std.code, name: std.name_en, nameAr: std.name_ar,
      type: toDbType(std.type), parentCode: std.parent_code, postable: true, level: std.level, nature: std.nature,
      statement: std.statement, fsLine: std.fs_line_ar, fsLineEn: std.fs_line_en, cfClass: std.cf_class,
      stdKey: std.std_key, systemLocked: true, isCustom: true, keywordsAr: [], keywordsEn: [],
    },
  }).catch(async () => {
    // code already taken by a different client account → next free code under the same parent
    const codes = chart.map((a) => a.code);
    return db.account.create({
      data: {
        firmId: scope.firmId, caseId: scope.caseId, code: nextChildCode(std.parent_code ?? std.code.slice(0, 4), codes),
        name: std.name_en, nameAr: std.name_ar, type: toDbType(std.type), parentCode: std.parent_code, postable: true,
        level: std.level, nature: std.nature, statement: std.statement, fsLine: std.fs_line_ar, fsLineEn: std.fs_line_en,
        cfClass: std.cf_class, stdKey: std.std_key, systemLocked: true, isCustom: true, keywordsAr: [], keywordsEn: [],
      },
    });
  });
}

/** "+ حساب جديد": a postable child under any parent, created and selectable immediately (§3). */
export async function addChildAccount(
  scope: ChartScope,
  input: { parentCode: string; name: string; nameAr?: string; keywords?: string[] },
  db: Db = prisma,
): Promise<Account> {
  const chart = await listChart(scope, db);
  const parent = chart.find((a) => a.code === input.parentCode);
  if (!parent) throw badRequest("الحساب الأب غير موجود في الشجرة.");
  const name = input.name.trim();
  if (name.length < 2) throw badRequest("اكتب اسم الحساب.");
  const dup = chart.find((a) => a.parentCode === parent.code && normalizeText(a.nameAr ?? a.name) === normalizeText(name));
  if (dup) return dup; // never create the same child twice
  // A postable parent becomes a group: the existing account keeps its history, so
  // new children go under ITS parent instead.
  const holder = parent.postable && (parent.level ?? 4) >= 4 ? chart.find((a) => a.code === parent.parentCode) ?? parent : parent;
  return db.account.create({
    data: {
      firmId: scope.firmId, caseId: scope.caseId, code: nextChildCode(holder.code, chart.map((a) => a.code)),
      name, nameAr: input.nameAr ?? name, type: holder.type, parentCode: holder.code,
      postable: true, level: (holder.level ?? 3) + 1, nature: holder.nature, statement: holder.statement, fsLine: holder.fsLine,
      fsLineEn: holder.fsLineEn, cfClass: holder.cfClass, stdKey: null, isCustom: true,
      keywordsAr: input.keywords ?? [], keywordsEn: [], vatDefault: holder.vatDefault,
    },
  });
}

const BANK_HINTS: [RegExp, string][] = [
  [/راجحي|RAJHI|RJHI/i, "110103"], [/الاهلي|الأهلي|SNB|NCB|AHLI/i, "110104"], [/الرياض|RIYAD|RIBL/i, "110105"], [/الانماء|الإنماء|ALINMA/i, "110106"],
];

/** One bank account per statement under "النقد وما في حكمه" (§4.5). */
export async function ensureBankAccount(scope: ChartScope, bankName: string | null | undefined, db: Db = prisma): Promise<Account> {
  const chart = await listChart(scope, db);
  const banks = chart.filter((a) => a.stdKey === "cash.bank" && a.postable && a.active);
  const name = bankName ?? "";
  for (const [re, stdCode] of BANK_HINTS) {
    if (re.test(name)) {
      const hit = resolveStd(chart, stdCode);
      if (hit) return hit;
    }
  }
  const byName = banks.find((a) => name && normalizeText(a.nameAr ?? a.name).includes(normalizeText(name)));
  if (byName) return byName;
  const other = resolveStd(chart, "110107");
  if (other && !name) return other;
  const parent = chart.find((a) => a.code === "1101") ?? banks[0];
  if (!parent) return other ?? banks[0] ?? (await ensureSystemAccount(scope, "suspense", db));
  const created = await addChildAccount(scope, { parentCode: parent.code, name: name ? `البنك - ${name}` : "بنك" }, db);
  return db.account.update({ where: { id: created.id }, data: { stdKey: "cash.bank", cfClass: "cash", name: name ? `Bank - ${name}` : "Bank" } });
}
