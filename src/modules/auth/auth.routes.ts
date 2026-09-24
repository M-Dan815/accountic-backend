import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/middleware/auth";
import { badRequest, unauthorized } from "@/lib/http-error";

export const authRouter = Router();

const registerSchema = z.object({
  firmName: z.string().min(2),
  firmNameAr: z.string().optional(),
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

/**
 * Registers a new firm plus its first user (OWNER) in one step, per the
 * PRD requirement that every accounting firm must have a user + password
 * and register their firm before using the system.
 */
authRouter.post("/register", async (req, res) => {
  const body = registerSchema.parse(req.body);

  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw badRequest("An account with this email already exists");

  const passwordHash = await bcrypt.hash(body.password, 12);

  const firm = await prisma.firm.create({
    data: {
      name: body.firmName,
      nameAr: body.firmNameAr,
      users: {
        create: { email: body.email, passwordHash, name: body.name, role: "OWNER" },
      },
    },
    include: { users: true },
  });

  const user = firm.users[0];
  const token = signToken({ userId: user.id, firmId: firm.id, role: user.role });
  res.status(201).json({ token, firm: { id: firm.id, name: firm.name }, user: { id: user.id, name: user.name, email: user.email } });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const body = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email: body.email }, include: { firm: true } });
  if (!user) throw unauthorized("Invalid email or password");

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) throw unauthorized("Invalid email or password");

  const token = signToken({ userId: user.id, firmId: user.firmId, role: user.role });
  res.json({ token, firm: { id: user.firm.id, name: user.firm.name }, user: { id: user.id, name: user.name, email: user.email } });
});
