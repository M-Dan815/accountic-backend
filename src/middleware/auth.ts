import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "@/lib/env";
import { unauthorized } from "@/lib/http-error";

type JwtPayload = { userId: string; firmId: string; role: "OWNER" | "ACCOUNTANT" };

/**
 * Every route below /api (except /auth/*) requires a valid JWT. This is
 * also where firm isolation starts: req.auth.firmId is the ONLY firm id
 * ever trusted from here on — nothing downstream accepts a firmId from the
 * request body or query string, precisely so one firm can never read or
 * write another firm's data by passing a different id.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized("Missing bearer token");

  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, env.jwtSecret) as JwtPayload;
    req.auth = payload;
    next();
  } catch {
    throw unauthorized("Invalid or expired token");
  }
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn as jwt.SignOptions["expiresIn"] });
}
