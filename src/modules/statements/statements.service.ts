import { accountWhere, getChartScope } from "@/modules/chart/chart.service";
import { prisma } from "@/lib/prisma";
import { badRequest } from "@/lib/http-error";
import { computeTrialBalance } from "@/modules/trial-balance/trial-balance.service";
import { buildAccountTree, sumTree, formatSar, TreeNode } from "./accountTree";

/**
 * Statements are pure aggregation over the same Trial Balance rows the
 * accountant already approved — no separate calculation path, no AI,
 * nothing that could produce a statement figure the TB doesn't already
 * account for. The section structure, subtotal nesting, gross-profit
 * line, and parentheses-for-negative formatting below were built and
 * numerically validated directly against this firm's real Income
 * Statement and Balance Sheet PDFs.
 *
 * Cash Flow uses the INDIRECT method: start from net income, add back
 * non-cash items, adjust for working-capital changes, then split
 * investing/financing out separately.
 */

async function requireApprovedTb(caseId: string, firmId: string) {
  const kase = await prisma.case.findFirst({ where: { id: caseId, firmId } });
  if (!kase) throw badRequest("Case not found");
  if (kase.status !== "TB_APPROVED" && kase.status !== "COMPLETE") {
    throw badRequest(
      "Financial statements can only be generated from an approved Trial Balance.",
    );
  }
  return computeTrialBalance(caseId, firmId);
}

function withFormatted(node: TreeNode): TreeNode & {
  formatted: string;
  children: (TreeNode & { formatted: string })[];
} {
  return {
    ...node,
    formatted: formatSar(node.amount),
    children: node.children.map(withFormatted),
  };
}

async function chartAccounts(caseId: string, firmId: string) {
  const scope = await getChartScope(caseId, firmId);
  return prisma.account.findMany({ where: accountWhere(scope) });
}

export async function buildIncomeStatement(caseId: string, firmId: string) {
  const tb = await requireApprovedTb(caseId, firmId);
  const allAccounts = await chartAccounts(caseId, firmId);

  const revenueAccounts = allAccounts.filter((a) => a.type === "REVENUE");
  const expenseAccounts = allAccounts.filter((a) => a.type === "EXPENSE");

  const revenueAmounts = new Map(
    tb.rows
      .filter((r) => r.type === "REVENUE")
      .map((r) => [r.code, r.credit - r.debit]),
  );
  const expenseAmounts = new Map(
    tb.rows
      .filter((r) => r.type === "EXPENSE")
      .map((r) => [r.code, r.debit - r.credit]),
  );

  const revenueTree = buildAccountTree(revenueAccounts, revenueAmounts, 2).map(
    withFormatted,
  );
  const expenseTree = buildAccountTree(expenseAccounts, expenseAmounts, 2);

  // Standard Saudi/GCC CoA convention: "51" root is Direct Costs (cost of
  // sales); every other expense root (52, 53, ...) is Operating Costs.
  const directCostSections = expenseTree.filter((n) => n.code.startsWith("51"));
  const operatingCostSections = expenseTree.filter(
    (n) => !n.code.startsWith("51"),
  );

  const totalRevenue = sumTree(revenueTree);
  const totalDirectCosts = sumTree(directCostSections);
  const grossProfit = round2(totalRevenue - totalDirectCosts);
  const totalOperatingCosts = sumTree(operatingCostSections);
  const netIncomeBeforeZakat = round2(grossProfit - totalOperatingCosts);
  // No interest/zakat accounts modeled yet in this MVP.
  const netProfit = netIncomeBeforeZakat;

  return {
    revenue: revenueTree,
    totalRevenue,
    totalRevenueFormatted: formatSar(totalRevenue),
    directCosts: directCostSections.map(withFormatted),
    totalDirectCosts,
    totalDirectCostsFormatted: formatSar(totalDirectCosts),
    grossProfit,
    grossProfitFormatted: formatSar(grossProfit),
    operatingCosts: operatingCostSections.map(withFormatted),
    totalOperatingCosts,
    totalOperatingCostsFormatted: formatSar(totalOperatingCosts),
    netIncomeBeforeZakat,
    netIncomeBeforeZakatFormatted: formatSar(netIncomeBeforeZakat),
    netProfit,
    netProfitFormatted: formatSar(netProfit),
  };
}

const RETAINED_EARNINGS_NAME_RE =
  /الأرباح المبقاة|الأرباح المحتجزة|retained earnings/i;

export async function buildBalanceSheet(caseId: string, firmId: string) {
  const tb = await requireApprovedTb(caseId, firmId);
  const allAccounts = await chartAccounts(caseId, firmId);
  const income = await buildIncomeStatement(caseId, firmId);

  const assetAccounts = allAccounts.filter((a) => a.type === "ASSET");
  const liabilityAccounts = allAccounts.filter((a) => a.type === "LIABILITY");
  const equityAccounts = allAccounts.filter((a) => a.type === "EQUITY");

  const assetAmounts = new Map(
    tb.rows
      .filter((r) => r.type === "ASSET")
      .map((r) => [r.code, r.debit - r.credit]),
  );
  const liabilityAmounts = new Map(
    tb.rows
      .filter((r) => r.type === "LIABILITY")
      .map((r) => [r.code, r.credit - r.debit]),
  );
  const equityAmounts = new Map(
    tb.rows
      .filter((r) => r.type === "EQUITY")
      .map((r) => [r.code, r.credit - r.debit]),
  );

  // Retained earnings is a real CoA account (e.g. "3402"). Its balance
  // here is whatever this case's ledger has posted PLUS this period's net
  // profit, exactly how the real Balance Sheet arrives at 3402's figure.
  // Standard tree: the period's profit is shown on its own line, 330102 "صافي ربح (خسارة) العام",
  // and reaches retained earnings when next year's file opens (spec §8.2) — no closing entry.
  const retainedEarningsAccount =
    equityAccounts.find((a) => a.stdKey === "equity.current_year") ??
    equityAccounts.find((a) => RETAINED_EARNINGS_NAME_RE.test(`${a.name} ${a.nameAr ?? ""}`));
  if (retainedEarningsAccount) {
    const priorBalance = equityAmounts.get(retainedEarningsAccount.code) ?? 0;
    equityAmounts.set(
      retainedEarningsAccount.code,
      priorBalance + income.netProfit,
    );
  }

  const assetTree = buildAccountTree(assetAccounts, assetAmounts, 1).map(
    withFormatted,
  );
  const liabilityTree = buildAccountTree(
    liabilityAccounts,
    liabilityAmounts,
    1,
  ).map(withFormatted);
  const equityTree = buildAccountTree(equityAccounts, equityAmounts, 1).map(
    withFormatted,
  );

  const totalAssets = round2(sumTree(assetTree));
  const totalLiabilities = round2(sumTree(liabilityTree));
  const totalEquity = round2(sumTree(equityTree));

  return {
    assets: assetTree,
    totalAssets,
    totalAssetsFormatted: formatSar(totalAssets),
    liabilities: liabilityTree,
    totalLiabilities,
    totalLiabilitiesFormatted: formatSar(totalLiabilities),
    equity: equityTree,
    netIncomeForPeriod: income.netProfit,
    netIncomeForPeriodFormatted: formatSar(income.netProfit),
    totalEquity,
    totalEquityFormatted: formatSar(totalEquity),
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  };
}

// ─── Cash Flow — indirect method ────────────────────────────────────────

export type CashFlowLine = {
  label: string;
  labelAr: string;
  amount: number;
  formatted: string;
};

export type CashFlowSection = {
  lines: CashFlowLine[];
  total: number;
  totalFormatted: string;
};

export type CashFlowStatement = {
  method: "indirect";
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netCashMovement: number;
  netCashMovementFormatted: string;
};

export async function buildCashFlowStatement(
  caseId: string,
  firmId: string,
): Promise<CashFlowStatement & { openingCash: number; closingCash: number; reconciles: boolean }> {
  await requireApprovedTb(caseId, firmId);
  const [tb, income, accounts] = await Promise.all([
    computeTrialBalance(caseId, firmId),
    buildIncomeStatement(caseId, firmId),
    chartAccounts(caseId, firmId),
  ]);

  // Indirect method driven by each account's cash-flow class (cf_class in the tree):
  //   cash → the cash itself · operating / non_cash → operating · investing · financing.
  // The effect of a balance-sheet account on cash is −(Δ debit-positive balance). Because the TB
  // balances, the three sections always add up to the change in cash — checked below.
  const closingById = new Map(tb.rows.map((r) => [r.accountId, r.debit - r.credit]));
  const acct = (a: (typeof accounts)[number]) => {
    const closing = closingById.get(a.id) ?? 0;
    const opening = Number(a.openingBalance);
    return { a, delta: closing - opening, closing, opening };
  };
  const bs = accounts.filter((a) => a.statement ? a.statement === "balance_sheet" : a.type === "ASSET" || a.type === "LIABILITY" || a.type === "EQUITY");
  const legacyClass = (a: (typeof accounts)[number]): string => {
    if (a.cfClass) return a.cfClass;
    const t = `${a.name} ${a.nameAr ?? ""}`;
    if (/نقد|بنك|cash|bank/i.test(t)) return "cash";
    if (/أصول ثابتة|fixed asset|معدات|equipment|مركبات|vehicle|أثاث|furniture/i.test(t)) return "investing";
    if (/قرض|تمويل|loan|capital|رأس المال|drawings|مسحوبات/i.test(t)) return "financing";
    return "operating";
  };
  const groups: Record<string, ReturnType<typeof acct>[]> = { cash: [], operating: [], non_cash: [], investing: [], financing: [], profit: [] };
  for (const a of bs) (groups[legacyClass(a)] ?? groups.operating).push(acct(a));

  const line = (label: string, labelAr: string, amount: number): CashFlowLine => ({ label, labelAr, amount: round2(amount), formatted: formatSar(amount) });
  const effect = (x: ReturnType<typeof acct>) => -x.delta;
  const lines = (list: ReturnType<typeof acct>[]) =>
    list.filter((x) => Math.abs(x.delta) >= 0.005).map((x) => line(x.a.name, x.a.nameAr ?? x.a.name, effect(x)));

  const nonCash = groups.non_cash.reduce((s, x) => s + effect(x), 0);
  const operatingLines: CashFlowLine[] = [
    line("Net income for the period", "صافي الربح للفترة", income.netProfit),
    ...(Math.abs(nonCash) >= 0.005 ? [line("Add back: depreciation and provisions", "يُضاف: الإهلاك والمخصصات", nonCash)] : []),
    ...lines(groups.operating),
  ];
  const operatingTotal = round2(operatingLines.reduce((s, l) => s + l.amount, 0));
  const investingLines = lines(groups.investing);
  const investingTotal = round2(investingLines.reduce((s, l) => s + l.amount, 0));
  const financingLines = lines(groups.financing);
  const financingTotal = round2(financingLines.reduce((s, l) => s + l.amount, 0));
  const netCashMovement = round2(operatingTotal + investingTotal + financingTotal);

  const openingCash = round2(groups.cash.reduce((s, x) => s + x.opening, 0));
  const closingCash = round2(groups.cash.reduce((s, x) => s + x.closing, 0));
  return {
    method: "indirect",
    operating: { lines: operatingLines, total: operatingTotal, totalFormatted: formatSar(operatingTotal) },
    investing: { lines: investingLines, total: investingTotal, totalFormatted: formatSar(investingTotal) },
    financing: { lines: financingLines, total: financingTotal, totalFormatted: formatSar(financingTotal) },
    netCashMovement,
    netCashMovementFormatted: formatSar(netCashMovement),
    openingCash, closingCash,
    reconciles: Math.abs(netCashMovement - (closingCash - openingCash)) < 0.01,
  };
}

/** Traceability: every source transaction (and its document) behind one TB/statement line. */
export async function drilldownAccount(
  caseId: string,
  firmId: string,
  accountId: string,
) {
  const lines = await prisma.journalLine.findMany({
    where: { caseId, firmId, accountId },
    include: {
      bankTransaction: {
        include: {
          document: {
            select: {
              id: true,
              fileName: true,
              storageDriver: true,
              storageKey: true,
            },
          },
        },
      },
    },
    orderBy: { date: "asc" },
  });

  return lines.map((l) => ({
    date: l.date,
    debit: round2(Number(l.debit)),
    credit: round2(Number(l.credit)),
    memo: l.memo,
    sourceTransaction: l.bankTransaction
      ? {
          id: l.bankTransaction.id,
          description: l.bankTransaction.description,
          amount: Number(l.bankTransaction.amount),
          date: l.bankTransaction.date,
        }
      : null,
    sourceDocument: l.bankTransaction?.document
      ? {
          id: l.bankTransaction.document.id,
          fileName: l.bankTransaction.document.fileName,
        }
      : null,
  }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
