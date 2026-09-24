import fs from "node:fs";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, isS3Configured } from "@/lib/env";

/**
 * Storage abstraction with automatic fallback.
 *
 * Behavior requested for this project: try S3 if it's configured; if the
 * S3_* env vars aren't fully set (or an upload call fails), silently fall
 * back to local disk under ./uploads so development and demos never break
 * on a missing bucket. Every stored file is addressed by a `storageKey`
 * plus the `storageDriver` that was actually used, both saved on the
 * Document row, so retrieval always knows where to look regardless of
 * which path was taken at upload time.
 */

const LOCAL_ROOT = path.resolve(process.cwd(), "uploads");

let s3Client: S3Client | null = null;
function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: env.s3.region,
      endpoint: env.s3.endpoint || undefined,
      credentials: {
        accessKeyId: env.s3.accessKeyId,
        secretAccessKey: env.s3.secretAccessKey,
      },
    });
  }
  return s3Client;
}

export type StoredFile = {
  storageDriver: "s3" | "local";
  storageKey: string;
};

function localPathFor(key: string): string {
  return path.join(LOCAL_ROOT, key);
}

async function saveLocal(key: string, buffer: Buffer): Promise<StoredFile> {
  const fullPath = localPathFor(key);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, buffer);
  return { storageDriver: "local", storageKey: key };
}

async function saveS3(key: string, buffer: Buffer, mimeType: string): Promise<StoredFile> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }),
  );
  return { storageDriver: "s3", storageKey: key };
}

/**
 * Saves a file. Tries S3 first when STORAGE_DRIVER="s3" and credentials are
 * present; falls back to local disk if S3 isn't configured or the upload
 * itself throws (network, bad bucket, etc.) — never blocks an upload just
 * because a bucket isn't set up yet.
 */
export async function saveFile(key: string, buffer: Buffer, mimeType: string): Promise<StoredFile> {
  const wantsS3 = env.storageDriver === "s3";

  if (wantsS3 && isS3Configured) {
    try {
      return await saveS3(key, buffer, mimeType);
    } catch (err) {
      console.warn(`[storage] S3 upload failed for key "${key}", falling back to local disk:`, err);
      return saveLocal(key, buffer);
    }
  }

  if (wantsS3 && !isS3Configured) {
    console.warn(`[storage] STORAGE_DRIVER="s3" but S3 credentials are incomplete — using local disk instead.`);
  }

  return saveLocal(key, buffer);
}

export async function readFile(file: StoredFile): Promise<Buffer> {
  if (file.storageDriver === "local") {
    return fs.promises.readFile(localPathFor(file.storageKey));
  }
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: env.s3.bucket, Key: file.storageKey }));
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Signed URL for S3-backed files; for local files, a same-origin API path the router serves directly. */
export async function urlFor(file: StoredFile): Promise<string> {
  if (file.storageDriver === "local") {
    return `/api/documents/file/${encodeURIComponent(file.storageKey)}`;
  }
  return getSignedUrl(getS3Client(), new GetObjectCommand({ Bucket: env.s3.bucket, Key: file.storageKey }), {
    expiresIn: 3600,
  });
}
