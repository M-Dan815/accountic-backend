import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",

  storageDriver: (process.env.STORAGE_DRIVER ?? "local") as "s3" | "local",
  s3: {
    bucket: process.env.S3_BUCKET ?? "",
    region: process.env.S3_REGION ?? "",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    endpoint: process.env.S3_ENDPOINT ?? "",
  },

  aiProvider: (process.env.AI_PROVIDER ?? "none") as "none" | "openai" | "deepseek" | "gemini",
  aiApiKey: process.env.AI_API_KEY ?? "",
};

/** True only when every S3 credential needed to actually talk to a bucket is present. */
export const isS3Configured =
  !!env.s3.bucket && !!env.s3.region && !!env.s3.accessKeyId && !!env.s3.secretAccessKey;
