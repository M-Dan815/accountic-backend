import { pdf } from "pdf-to-img";

const log = (...args: unknown[]) => console.log("[pdf-to-images]", ...args);

/**
 * Render a PDF buffer to an array of PNG buffers, one per page.
 *
 * Scale 2.0 ≈ 144 DPI — enough for a vision model to read Arabic text
 * reliably without blowing past OpenAI's per-image token budget.
 */
export async function pdfToPngPages(
  buffer: Buffer,
  opts: { scale?: number; maxPages?: number } = {},
): Promise<Buffer[]> {
  const scale = opts.scale ?? 2.0;
  const maxPages = opts.maxPages ?? 5;

  const doc = await pdf(buffer, { scale });
  const pages: Buffer[] = [];
  let i = 0;
  for await (const page of doc) {
    pages.push(page);
    if (++i >= maxPages) break;
  }
  log(`rendered ${pages.length} page(s) at scale=${scale}`);
  return pages;
}
