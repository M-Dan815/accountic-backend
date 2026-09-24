import { Router } from "express";
import multer from "multer";
import { prisma } from "@/lib/prisma";
import { saveFile, readFile } from "@/lib/storage";
import { HttpError, notFound, badRequest } from "@/lib/http-error";
import { processCase } from "@/modules/cases/processing.service";
import { z } from "zod";
import {
  listOpenClarifications,
  listAnsweredClarifications,
  answerClarification,
  generateClientAccessToken,
  revokeClientAccessToken,
} from "@/modules/cases/clarification.service";
import { computeReadiness } from "@/modules/trial-balance/readiness.service";

export const documentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const uploadBodySchema = z.object({
  type: z.enum(["BANK_STATEMENT", "INVOICE", "RECEIPT"]),
  bankName: z.string().optional(),
});

documentsRouter.post(
  "/cases/:caseId/documents",
  upload.single("file"),
  async (req, res) => {
    const kase = await prisma.case.findFirst({
      where: { id: req.params.caseId, firmId: req.auth!.firmId },
    });
    if (!kase) throw notFound("Case not found");
    if (!req.file)
      throw badRequest('No file uploaded (expected multipart field "file")');

    const body = uploadBodySchema.parse(req.body);

    // Multer decodes multipart filenames as latin1 per RFC 7578, but modern
    // browsers send them as UTF-8 bytes. Re-decode to UTF-8 so Arabic
    // filenames (نخلة الخليج.PDF) display correctly in the UI instead of as
    // mojibake (ÙØ®Ù„Ø©.PDF). This is safe — latin1→utf8 round-trips cleanly
    // for ASCII filenames too.
    const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");

    console.log(
      `[upload] case=${kase.id} type=${body.type} ` +
        `name="${fileName}" size=${req.file.size} ` +
        `mime=${req.file.mimetype}`,
    );

    const key = `${req.auth!.firmId}/${kase.id}/${Date.now()}-${fileName}`;
    const stored = await saveFile(key, req.file.buffer, req.file.mimetype);

    const doc = await prisma.document.create({
      data: {
        firmId: req.auth!.firmId,
        caseId: kase.id,
        type: body.type,
        fileName,
        storageKey: stored.storageKey,
        storageDriver: stored.storageDriver,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        bankName: body.bankName,
      },
    });

    console.log(
      `[upload] stored doc=${doc.id} key=${stored.storageKey} ` +
        `driver=${stored.storageDriver}`,
    );

    res.status(201).json(doc);
  },
);

documentsRouter.post("/cases/:caseId/process", async (req, res) => {
  const kase = await prisma.case.findFirst({
    where: { id: req.params.caseId, firmId: req.auth!.firmId },
  });
  if (!kase) throw notFound("Case not found");

  console.log(`[process] starting case=${kase.id} firm=${req.auth!.firmId}`);
  const t0 = Date.now();

  try {
    await processCase(kase.id, req.auth!.firmId);
  } catch (err) {
    console.error("[process] pipeline failed:", err);
    throw new HttpError(
      500,
      err instanceof Error ? err.message : "Processing failed",
    );
  }

  console.log(`[process] finished case=${kase.id} in ${Date.now() - t0}ms`);

  const updated = await prisma.case.findUnique({ where: { id: kase.id } });
  res.json(updated);
});

documentsRouter.get("/documents/file/:key(*)", async (req, res) => {
  const doc = await prisma.document.findFirst({
    where: { firmId: req.auth!.firmId, storageKey: req.params.key },
  });
  if (!doc) throw notFound("File not found");
  // readFile() handles both local disk AND S3 — there's no reason to reject
  // S3-backed files here. Anas feedback: "View original produced no visible
  // document when tested" because the previous version threw a 400 for any
  // S3-stored document. Now the endpoint serves either storage driver.
  const buffer = await readFile({
    storageDriver: doc.storageDriver as "local" | "s3",
    storageKey: doc.storageKey,
  });
  res.setHeader("Content-Type", doc.mimeType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
  );
  res.send(buffer);
});

// ─── Clarifications (accountant-facing) ────────────────────────────────

documentsRouter.get("/cases/:caseId/clarifications", async (req, res) => {
  const kase = await prisma.case.findFirst({
    where: { id: req.params.caseId, firmId: req.auth!.firmId },
  });
  if (!kase) throw notFound("Case not found");

  const [open, answered] = await Promise.all([
    listOpenClarifications(kase.id, req.auth!.firmId),
    listAnsweredClarifications(kase.id, req.auth!.firmId),
  ]);
  res.json({ open, answered });
});

const answerSchema = z.object({
  answer: z.string().min(1),
  proposedAccountId: z.string().optional(),
});

documentsRouter.post(
  "/cases/:caseId/clarifications/:clarificationId/answer",
  async (req, res) => {
    const kase = await prisma.case.findFirst({
      where: { id: req.params.caseId, firmId: req.auth!.firmId },
    });
    if (!kase) throw notFound("Case not found");

    const body = answerSchema.parse(req.body);
    const updated = await answerClarification({
      firmId: req.auth!.firmId,
      clarificationId: req.params.clarificationId,
      answeredBy: req.auth!.userId,
      answer: body.answer,
      proposedAccountId: body.proposedAccountId,
    });
    res.json(updated);
  },
);

// ─── Client-facing clarification share token ───────────────────────────
//
// Generates (or rotates) the bearer token the accountant sends to the
// client for the public portal. The public endpoints themselves live at
// /api/public/clarifications/:token — see public-clarifications.routes.ts
// — and are mounted BEFORE requireAuth in app.ts.
//
// Rotating invalidates any previously shared link.

documentsRouter.post(
  "/cases/:caseId/clarifications/request",
  async (req, res) => {
    const kase = await prisma.case.findFirst({
      where: { id: req.params.caseId, firmId: req.auth!.firmId },
    });
    if (!kase) throw notFound("Case not found");

    const { token, expiresAt } = await generateClientAccessToken(
      kase.id,
      req.auth!.firmId,
    );
    res.status(201).json({
      token,
      expiresAt,
      // Convenience hint for the frontend so it doesn't have to hardcode
      // the URL pattern. Frontend builds the full link from its own origin.
      publicPath: `/api/public/clarifications/${token}`,
    });
  },
);

documentsRouter.delete(
  "/cases/:caseId/clarifications/request",
  async (req, res) => {
    const kase = await prisma.case.findFirst({
      where: { id: req.params.caseId, firmId: req.auth!.firmId },
    });
    if (!kase) throw notFound("Case not found");

    res.json(await revokeClientAccessToken(kase.id, req.auth!.firmId));
  },
);

// ─── Readiness ─────────────────────────────────────────────────────────

documentsRouter.get("/cases/:caseId/readiness", async (req, res) => {
  const kase = await prisma.case.findFirst({
    where: { id: req.params.caseId, firmId: req.auth!.firmId },
  });
  if (!kase) throw notFound("Case not found");

  const readiness = await computeReadiness(kase.id, req.auth!.firmId);
  res.json(readiness);
});
