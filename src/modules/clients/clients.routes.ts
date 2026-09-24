import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/http-error";
import { seedStandardChart } from "@/modules/chart/chart.service";

export const clientsRouter = Router();

// req.auth is guaranteed by requireAuth, mounted before this router in app.ts.

clientsRouter.get("/", async (req, res) => {
  const clients = await prisma.client.findMany({
    where: { firmId: req.auth!.firmId },
    include: { cases: { orderBy: { createdAt: "desc" } } },
    orderBy: { name: "asc" },
  });
  res.json(clients);
});

// Client profile — spec §4.1 fields plus the §4.3 client settings.
const profileFields = {
  crNumber: z.string().optional(),
  vatNumber: z.string().optional(),
  vatRegistered: z.boolean().optional(),
  activity: z.enum(["trading", "services", "contracting", "logistics", "other"]).optional(),
  materialityThreshold: z.number().int().min(0).optional(),
  revenueBasis: z.enum(["invoices", "collections"]).optional(),
};
const createClientSchema = z.object({
  name: z.string().min(1),
  nameAr: z.string().optional(),
  ...profileFields,
});

clientsRouter.post("/", async (req, res) => {
  const body = createClientSchema.parse(req.body);
  const client = await prisma.client.create({
    data: { firmId: req.auth!.firmId, ...body },
  });
  res.status(201).json(client);
});

clientsRouter.patch("/:clientId", async (req, res) => {
  const body = createClientSchema.partial().parse(req.body);
  const found = await prisma.client.findFirst({ where: { id: req.params.clientId, firmId: req.auth!.firmId } });
  if (!found) throw notFound("Client not found");
  res.json(await prisma.client.update({ where: { id: found.id }, data: body }));
});

const createCaseSchema = z.object({
  label: z.string().min(1),
  periodStart: z.string(),
  periodEnd: z.string(),
  isFirstYear: z.boolean().optional(),
  framework: z.enum(["sme", "full"]).optional(),
  /** "نسخ إعدادات من ملف سابق لنفس العميل": copies the chart (custom or standard). Rules/answers are per client and always carry over. */
  copyFromCaseId: z.string().optional(),
});

clientsRouter.post("/:clientId/cases", async (req, res) => {
  const client = await prisma.client.findFirst({
    where: { id: req.params.clientId, firmId: req.auth!.firmId },
  });
  if (!client) throw notFound("Client not found");

  const body = createCaseSchema.parse(req.body);
  const firmId = req.auth!.firmId;
  const source = body.copyFromCaseId
    ? await prisma.case.findFirst({ where: { id: body.copyFromCaseId, firmId, clientId: client.id } })
    : null;
  const kase = await prisma.$transaction(async (tx) => {
    const created = await tx.case.create({
      data: {
        firmId,
        clientId: client.id,
        label: body.label,
        periodStart: new Date(body.periodStart),
        periodEnd: new Date(body.periodEnd),
        isFirstYear: body.isFirstYear ?? false,
        framework: body.framework ?? "sme",
        chartMode: source && source.chartMode !== "legacy" ? source.chartMode : "standard",
        // a first-year file has, by definition, no opening balances to ask about
        ...(body.isFirstYear ? { openingMode: "first_year", openingBalancesConfirmed: true } : {}),
      },
    });
    // The chart is created NOW, so no account list is ever empty (spec §4.1, §13.2).
    if (source && source.chartMode !== "legacy") {
      const accounts = await tx.account.findMany({ where: { firmId, caseId: source.id } });
      await tx.account.createMany({ data: accounts.map(({ id: _id, caseId: _c, openingBalance: _o, ...a }) => ({ ...a, caseId: created.id, openingBalance: 0 })) });
    } else {
      await seedStandardChart(tx, firmId, created.id);
    }
    return created;
  });
  res.status(201).json(kase);
});
