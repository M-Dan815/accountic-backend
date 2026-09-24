import { prisma } from "@/lib/prisma";
import { badRequest } from "@/lib/http-error";
import type { TreeAccount } from "@/modules/import-reader/readChartTree";
import { matchToTree } from "./mapping";
import { STANDARD, STD_BY_CODE, toDbType } from "./standard";

/**
 * A client's own tree (spec §6.1). Every FINAL account is linked to the closest standard account and INHERITS
 * its type, nature, financial-statement line, cash-flow class and std_key — so classification, questions,
 * the Trial Balance and the statements all work on the client's numbers and names.
 */
const STD_TREE = STANDARD.accounts.filter((a) => a.active).map((a) => ({
  code: a.code, name: a.name_en, nameAr: a.name_ar, postable: a.postable, type: toDbType(a.type),
  keywordsAr: a.keywords_ar, keywordsEn: a.keywords_en, parentCode: a.parent_code, stdKey: a.std_key,
}));

export type TreeProposal = {
  source: { code: string; name: string; typeHint: TreeAccount["typeHint"] };
  stdCode: string | null;
  confidence: number;
  status: "green" | "yellow" | "red";
  alternatives: { code: string; nameAr: string; confidence: number }[];
};

export function proposeTreeMapping(tree: TreeAccount[]): TreeProposal[] {
  return tree.filter((a) => a.postable).map((a) => {
    const m = matchToTree({ code: null, name: a.name }, STD_TREE, { typeHint: a.typeHint }); // client numbers never equal ours: match by meaning
    return {
      source: { code: a.code, name: a.name, typeHint: a.typeHint },
      stdCode: m.best?.account.code ?? null,
      confidence: m.best?.confidence ?? 0,
      status: m.status,
      alternatives: m.alternatives.map((c) => ({ code: c.account.code, nameAr: c.account.nameAr ?? c.account.name, confidence: c.confidence })),
    };
  });
}

export type InstallItem = { code: string; name: string; parentCode: string | null; postable: boolean; typeHint: TreeAccount["typeHint"]; stdCode?: string | null; fsLine?: string | null };

export async function installClientTree(caseId: string, firmId: string, items: InstallItem[]) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!kase) throw badRequest("الملف غير موجود.");
  const [lines, categorised] = await Promise.all([
    prisma.journalLine.count({ where: { caseId, firmId } }),
    prisma.bankTransaction.count({ where: { caseId, firmId, categoryAccountId: { not: null } } }),
  ]);
  if (lines > 0 || categorised > 0) {
    throw badRequest("لا يمكن استبدال شجرة الحسابات بعد بدء التصنيف. أنشئ ملفًا جديدًا (مع «نسخ إعدادات من ملف سابق») أو أضف حسابات جديدة للشجرة الحالية.");
  }
  if (items.length < 2) throw badRequest("الشجرة فارغة.");
  const seen = new Set<string>();
  const clean = items.filter((i) => (seen.has(i.code) ? false : (seen.add(i.code), true)));

  await prisma.$transaction(async (tx) => {
    await tx.account.deleteMany({ where: { caseId, firmId } });
    await tx.account.createMany({
      data: clean.map((i) => {
        const std = i.postable && i.stdCode ? STD_BY_CODE.get(i.stdCode) : undefined;
        const type = std ? toDbType(std.type) : ((i.typeHint ?? "EXPENSE") as ReturnType<typeof toDbType>);
        const nature = std?.nature ?? (type === "ASSET" || type === "EXPENSE" ? "debit" : "credit");
        return {
          firmId, caseId, code: i.code, name: i.name, nameAr: i.name, type, parentCode: i.parentCode, postable: i.postable,
          level: null, nature, statement: std?.statement ?? (type === "REVENUE" || type === "EXPENSE" ? "income_statement" : "balance_sheet"),
          fsLine: std?.fs_line_ar ?? i.fsLine ?? null, fsLineEn: std?.fs_line_en ?? null, cfClass: std?.cf_class ?? null,
          stdKey: std?.std_key ?? null, isContra: std?.is_contra ?? false, vatDefault: std?.vat_default ?? null,
          keywordsAr: std?.keywords_ar ?? [], keywordsEn: std?.keywords_en ?? [], isCustom: true,
          requiresSupportingDoc: ["ar.trade", "equity.capital", "loan.short", "loan.long"].includes(std?.std_key ?? ""),
        };
      }),
    });
    await tx.case.update({ where: { id: caseId }, data: { chartMode: "client" } });
  });
  return { installed: clean.length, unmapped: clean.filter((i) => i.postable && !i.stdCode).length };
}
