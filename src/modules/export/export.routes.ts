import { Router, Response } from "express";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/http-error";
import { computeTrialBalance } from "@/modules/trial-balance/trial-balance.service";
import {
  buildIncomeStatement,
  buildBalanceSheet,
  buildCashFlowStatement,
} from "@/modules/statements/statements.service";
import type { TreeNode } from "@/modules/statements/accountTree";
import {
  htmlToPdf,
  incomeStatementHtml,
  balanceSheetHtml,
  trialBalanceHtml,
  cashFlowHtml,
  CaseMeta,
} from "@/lib/pdf";

export const exportRouter = Router();

const MONEY_FORMAT = "#,##0.00;(#,##0.00)"; // native Excel negative-in-parentheses, matching the real statement PDFs

/**
 * HTTP headers are Latin-1 only, and real client/case names here are Arabic —
 * putting them raw into Content-Disposition throws ERR_INVALID_CHAR. So:
 * an ASCII-sanitized fallback name every client understands, plus the RFC 5987
 * `filename*=UTF-8''...` form browsers actually display. Sanitizing also
 * strips CR/LF, closing the header-injection door.
 */
function setDownloadName(res: Response, filename: string) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
}

async function requireCase(caseId: string, firmId: string) {
  const kase = await prisma.case.findFirst({
    where: { id: caseId, firmId },
    include: { client: true },
  });
  if (!kase) throw notFound("Case not found");
  return kase;
}

/** Case + the bilingual metadata every PDF header block needs. */
async function caseContext(caseId: string, firmId: string) {
  const kase = await requireCase(caseId, firmId);
  const firm = await prisma.firm.findUnique({
    where: { id: firmId },
    select: { name: true },
  });
  const meta: CaseMeta = {
    firmName: firm?.name ?? null,
    clientName: kase.client.name,
    clientNameAr: kase.client.nameAr,
    caseLabel: kase.label,
    periodStart: kase.periodStart,
    periodEnd: kase.periodEnd,
  };
  return { kase, meta, baseName: `${kase.client.name}-${kase.label}` };
}

// --------------------------------------------------------------- Excel (.xlsx)

exportRouter.get(
  "/cases/:caseId/export/trial-balance.xlsx",
  async (req, res) => {
    const { kase, baseName } = await caseContext(
      req.params.caseId,
      req.auth!.firmId,
    );
    const tb = await computeTrialBalance(kase.id, req.auth!.firmId);

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Trial Balance");
    sheet.columns = [
      { header: "Code", key: "code", width: 12 },
      { header: "Account", key: "name", width: 36 },
      { header: "Debit", key: "debit", width: 16 },
      { header: "Credit", key: "credit", width: 16 },
    ];
    sheet.getRow(1).font = { bold: true };
    tb.rows.forEach((r) => {
      const row = sheet.addRow({
        code: r.code,
        name: r.name,
        debit: r.debit || null,
        credit: r.credit || null,
      });
      row.getCell("debit").numFmt = MONEY_FORMAT;
      row.getCell("credit").numFmt = MONEY_FORMAT;
    });
    const totalsRow = sheet.addRow({
      code: "",
      name: "Totals",
      debit: tb.totalDebit,
      credit: tb.totalCredit,
    });
    totalsRow.font = { bold: true };
    totalsRow.getCell("debit").numFmt = MONEY_FORMAT;
    totalsRow.getCell("credit").numFmt = MONEY_FORMAT;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    setDownloadName(res, `${baseName}-trial-balance.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  },
);

/** Writes a tree section (with its own nested subtotal rows) into the sheet, indenting by depth like the real PDF does. */
function writeTreeRows(
  sheet: ExcelJS.Worksheet,
  nodes: TreeNode[],
  depth: number,
) {
  for (const node of nodes) {
    const isSection = node.children.length > 0;
    const row = sheet.addRow({
      name: `${"  ".repeat(depth)}${node.code} - ${node.name}`,
      amount: isSection ? null : node.amount,
    });
    if (!isSection) row.getCell("amount").numFmt = MONEY_FORMAT;
    if (isSection) writeTreeRows(sheet, node.children, depth + 1);
    if (isSection) {
      const totalRow = sheet.addRow({
        name: `${"  ".repeat(depth)}مجموع ${node.code} - ${node.name}`,
        amount: node.amount,
      });
      totalRow.font = { italic: true };
      totalRow.getCell("amount").numFmt = MONEY_FORMAT;
    }
  }
}

exportRouter.get(
  "/cases/:caseId/export/income-statement.xlsx",
  async (req, res) => {
    const { kase, baseName } = await caseContext(
      req.params.caseId,
      req.auth!.firmId,
    );
    const stmt = await buildIncomeStatement(kase.id, req.auth!.firmId);

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Income Statement");
    sheet.views = [{ rightToLeft: true }];
    sheet.columns = [
      { header: "Line", key: "name", width: 44 },
      { header: "Amount (SAR)", key: "amount", width: 18 },
    ];
    sheet.getRow(1).font = { bold: true };

    writeTreeRows(sheet, stmt.revenue, 0);
    let r = sheet.addRow({ name: "Total Revenue", amount: stmt.totalRevenue });
    r.font = { bold: true };
    r.getCell("amount").numFmt = MONEY_FORMAT;

    sheet.addRow({});
    writeTreeRows(sheet, stmt.directCosts, 0);

    sheet.addRow({});
    r = sheet.addRow({
      name: "إجمالي الربح (Gross Profit)",
      amount: stmt.grossProfit,
    });
    r.font = { bold: true };
    r.getCell("amount").numFmt = MONEY_FORMAT;

    sheet.addRow({});
    writeTreeRows(sheet, stmt.operatingCosts, 0);

    sheet.addRow({});
    r = sheet.addRow({
      name: "صافي الدخل قبل الفوائد والضريبة والزكاة",
      amount: stmt.netIncomeBeforeZakat,
    });
    r.font = { bold: true };
    r.getCell("amount").numFmt = MONEY_FORMAT;

    r = sheet.addRow({
      name: "صافي الربح (Net Profit)",
      amount: stmt.netProfit,
    });
    r.font = { bold: true };
    r.getCell("amount").numFmt = MONEY_FORMAT;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    setDownloadName(res, `${baseName}-income-statement.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  },
);

exportRouter.get(
  "/cases/:caseId/export/balance-sheet.xlsx",
  async (req, res) => {
    const { kase, baseName } = await caseContext(
      req.params.caseId,
      req.auth!.firmId,
    );
    const stmt = await buildBalanceSheet(kase.id, req.auth!.firmId);

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Balance Sheet");
    sheet.views = [{ rightToLeft: true }];
    sheet.columns = [
      { header: "Line", key: "name", width: 44 },
      { header: "Amount (SAR)", key: "amount", width: 18 },
    ];
    sheet.getRow(1).font = { bold: true };

    writeTreeRows(sheet, stmt.assets, 0);
    let r = sheet.addRow({
      name: "مجموع الأصول (Total Assets)",
      amount: stmt.totalAssets,
    });
    r.font = { bold: true };
    r.getCell("amount").numFmt = MONEY_FORMAT;

    sheet.addRow({});
    writeTreeRows(sheet, stmt.liabilities, 0);
    r = sheet.addRow({
      name: "مجموع الالتزامات (Total Liabilities)",
      amount: stmt.totalLiabilities,
    });
    r.font = { bold: true };
    r.getCell("amount").numFmt = MONEY_FORMAT;

    sheet.addRow({});
    writeTreeRows(sheet, stmt.equity, 0);
    r = sheet.addRow({
      name: "مجموع حقوق الملكية (Total Equity)",
      amount: stmt.totalEquity,
    });
    r.font = { bold: true };
    r.getCell("amount").numFmt = MONEY_FORMAT;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    setDownloadName(res, `${baseName}-balance-sheet.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  },
);

exportRouter.get("/cases/:caseId/export/cash-flow.xlsx", async (req, res) => {
  const { kase, baseName } = await caseContext(
    req.params.caseId,
    req.auth!.firmId,
  );
  const cf = await buildCashFlowStatement(kase.id, req.auth!.firmId);

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Cash Flow");
  sheet.views = [{ rightToLeft: true }];
  sheet.columns = [
    { header: "Line", key: "line", width: 56 },
    { header: "Amount (SAR)", key: "amount", width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };

  const sectionHeader = (ar: string, en: string) => {
    const r = sheet.addRow({ line: `${ar} — ${en}` });
    r.font = { bold: true, size: 12 };
  };
  const lineRow = (label: string, labelAr: string, amount: number) => {
    const r = sheet.addRow({ line: `${label} (${labelAr})`, amount });
    r.getCell("amount").numFmt = MONEY_FORMAT;
  };
  const sectionTotal = (ar: string, en: string, amount: number) => {
    const r = sheet.addRow({ line: `${ar} — ${en} (Total)`, amount });
    r.font = { bold: true };
    r.getCell("amount").numFmt = MONEY_FORMAT;
  };

  sectionHeader("الأنشطة التشغيلية", "Operating activities");
  cf.operating.lines.forEach((l) => lineRow(l.label, l.labelAr, l.amount));
  sectionTotal(
    "إجمالي الأنشطة التشغيلية",
    "Operating activities",
    cf.operating.total,
  );

  sheet.addRow({});
  sectionHeader("الأنشطة الاستثمارية", "Investing activities");
  cf.investing.lines.forEach((l) => lineRow(l.label, l.labelAr, l.amount));
  sectionTotal(
    "إجمالي الأنشطة الاستثمارية",
    "Investing activities",
    cf.investing.total,
  );

  sheet.addRow({});
  sectionHeader("الأنشطة التمويلية", "Financing activities");
  cf.financing.lines.forEach((l) => lineRow(l.label, l.labelAr, l.amount));
  sectionTotal(
    "إجمالي الأنشطة التمويلية",
    "Financing activities",
    cf.financing.total,
  );

  sheet.addRow({});
  const net = sheet.addRow({
    line: "صافي التغير في النقدية — Net Cash Movement",
    amount: cf.netCashMovement,
  });
  net.font = { bold: true };
  net.getCell("amount").numFmt = MONEY_FORMAT;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  setDownloadName(res, `${baseName}-cash-flow.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

// --------------------------------------------------------------- PDF (.pdf)
// Same data, same TB_APPROVED gate (the statement builders enforce it), rendered
// as bilingual RTL HTML and printed by headless Chromium — see lib/pdf.ts for
// why a browser is used instead of a JS PDF library (Arabic shaping).

exportRouter.get(
  "/cases/:caseId/export/income-statement.pdf",
  async (req, res) => {
    const { meta, baseName } = await caseContext(
      req.params.caseId,
      req.auth!.firmId,
    );
    const stmt = await buildIncomeStatement(
      req.params.caseId,
      req.auth!.firmId,
    );

    const pdf = await htmlToPdf(incomeStatementHtml(meta, stmt));
    res.setHeader("Content-Type", "application/pdf");
    setDownloadName(res, `${baseName}-income-statement.pdf`);
    res.send(pdf);
  },
);

exportRouter.get(
  "/cases/:caseId/export/balance-sheet.pdf",
  async (req, res) => {
    const { meta, baseName } = await caseContext(
      req.params.caseId,
      req.auth!.firmId,
    );
    const bs = await buildBalanceSheet(req.params.caseId, req.auth!.firmId);

    const pdf = await htmlToPdf(balanceSheetHtml(meta, bs));
    res.setHeader("Content-Type", "application/pdf");
    setDownloadName(res, `${baseName}-balance-sheet.pdf`);
    res.send(pdf);
  },
);

exportRouter.get(
  "/cases/:caseId/export/trial-balance.pdf",
  async (req, res) => {
    const { meta, baseName } = await caseContext(
      req.params.caseId,
      req.auth!.firmId,
    );
    const tb = await computeTrialBalance(req.params.caseId, req.auth!.firmId);
    if (tb.rows.length === 0)
      throw notFound("No trial balance has been generated for this case yet");

    const pdf = await htmlToPdf(trialBalanceHtml(meta, tb));
    res.setHeader("Content-Type", "application/pdf");
    setDownloadName(res, `${baseName}-trial-balance.pdf`);
    res.send(pdf);
  },
);

exportRouter.get("/cases/:caseId/export/cash-flow.pdf", async (req, res) => {
  const { meta, baseName } = await caseContext(
    req.params.caseId,
    req.auth!.firmId,
  );
  const cf = await buildCashFlowStatement(req.params.caseId, req.auth!.firmId);

  const pdf = await htmlToPdf(cashFlowHtml(meta, cf));
  res.setHeader("Content-Type", "application/pdf");
  setDownloadName(res, `${baseName}-cash-flow.pdf`);
  res.send(pdf);
});
