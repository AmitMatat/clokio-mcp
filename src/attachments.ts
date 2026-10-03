/**
 * Attachment handling: everything that turns the raw bytes of a Clokio
 * attachment into something an agent can actually use - save it to disk, read a
 * PDF's text, list a ZIP's entries, or hand an image to the model.
 *
 * The bytes themselves come from client.ts (requestRawBytes), which owns the
 * credential and redirect handling. This module never fetches; it only decides
 * what to DO with what it was given.
 */

import { ClokioApiError, ClokioConfig, looksLikeText, requestRawBytes } from './client.js';
import { mcpContent, McpContentResult } from './tools/helpers.js';

/**
 * How much decoded text (PDF or text file) we return inline before truncating.
 * Same reasoning as the text cap in requestRaw: a 5 MB PDF of logs would bury
 * the conversation. The caller can always pass save_path for the whole file.
 */
const TEXT_INLINE_LIMIT = 100_000;

/**
 * How large an image we are willing to hand to the model as base64. Images ride
 * in the context as tokens; a 20 MB screenshot is both unusable and ruinous.
 * Over this, we describe it and point at save_path.
 */
const IMAGE_INLINE_LIMIT = 4 * 1024 * 1024; // 4 MB

function extensionOf(fileName: string | undefined): string {
  return (fileName ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}

async function sha256Hex(buffer: Buffer): Promise<string> {
  // Dynamic import, not require(): this is an ES module.
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buffer).digest('hex');
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

function imageMimeFor(contentType: string, fileName?: string): string | null {
  if (contentType.startsWith('image/')) return contentType.split(';')[0].trim();
  const ext = extensionOf(fileName);
  return IMAGE_MIME[ext] ?? null;
}

/**
 * Extract text from a PDF buffer, page by page, with pdfjs-dist (Mozilla's
 * maintained PDF engine). Loaded lazily so a session that never reads a PDF
 * pays nothing for it, and wrapped by the caller so a parse failure (encrypted
 * or image-only PDF) degrades to a clear message rather than crashing the tool.
 *
 * The `legacy` build is used deliberately: it is the CommonJS/Node-targeted bundle
 * that runs without a browser Worker. `pdf-parse` was tried first and REJECTED -
 * version 1.1.x fails "bad XRef entry" on valid PDFs (reproduced against a
 * reportlab PDF and a macOS system PDF), so it would have failed on real
 * attachments in production while passing a naive smoke test.
 */
async function extractPdfText(
  buffer: Buffer
): Promise<{ text: string; pages: number }> {
  // @ts-ignore - the legacy build has no bundled types; its runtime shape is used.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;

  const parts: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    parts.push(content.items.map((i: any) => (typeof i.str === 'string' ? i.str : '')).join(' '));
  }
  const pages = doc.numPages;
  await doc.destroy();
  return { text: parts.join('\n\n'), pages };
}

function capText(text: string): { body: string; truncated: boolean } {
  if (text.length <= TEXT_INLINE_LIMIT) return { body: text, truncated: false };
  return {
    body:
      text.slice(0, TEXT_INLINE_LIMIT) +
      `\n\n[...truncated. ${(text.length - TEXT_INLINE_LIMIT).toLocaleString()} more characters not shown. ` +
      'Pass save_path to write the whole file to disk.]',
    truncated: true,
  };
}

/**
 * List a ZIP's entries by reading its End Of Central Directory record and the
 * Central Directory, with no third-party library and WITHOUT inflating any
 * entry. This is a read of the archive's table of contents only - names, sizes
 * and modification dates - which is exactly what the spec asks for.
 *
 * Format: PKZIP APPNOTE. EOCD signature 0x06054b50 sits near the end (it may be
 * followed by up to 65,535 bytes of comment, so we scan backwards for it).
 * Each central-directory header is signature 0x02014b50 followed by fixed
 * fields, then variable name/extra/comment lengths.
 */
export function listZipEntries(
  buffer: Buffer
): Array<{ name: string; size: number; compressed_size: number; modified: string | null }> {
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

  // Find EOCD by scanning back from the end. 22 bytes is the minimum EOCD size.
  let eocd = -1;
  const minEocd = 22;
  const scanStart = Math.max(0, buffer.length - (minEocd + 0xffff));
  for (let i = buffer.length - minEocd; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ClokioApiError(0, 'Not a readable ZIP (no end-of-central-directory record found).');
  }

  let entryCount = buffer.readUInt16LE(eocd + 10);
  let cdOffset = buffer.readUInt32LE(eocd + 16);

  // ZIP64: a 0xffff count or 0xffffffff offset means the real values live in the
  // ZIP64 EOCD, located via the ZIP64 EOCD locator just before the EOCD.
  if ((entryCount === 0xffff || cdOffset === 0xffffffff) && eocd - 20 >= 0) {
    const locator = eocd - 20;
    if (buffer.readUInt32LE(locator) === ZIP64_EOCD_LOCATOR_SIG) {
      const z64 = Number(buffer.readBigUInt64LE(locator + 8));
      if (buffer.readUInt32LE(z64) === 0x06064b50) {
        entryCount = Number(buffer.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buffer.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries: Array<{ name: string; size: number; compressed_size: number; modified: string | null }> = [];
  let p = cdOffset;
  for (let n = 0; n < entryCount && p + 46 <= buffer.length; n++) {
    if (buffer.readUInt32LE(p) !== CEN_SIG) break;
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const dosTime = buffer.readUInt16LE(p + 12);
    const dosDate = buffer.readUInt16LE(p + 14);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);

    entries.push({
      name,
      size: uncompressedSize,
      compressed_size: compressedSize,
      modified: dosDateToIso(dosDate, dosTime),
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** Decode a DOS date+time pair (ZIP's native stamp) into an ISO-ish string. */
function dosDateToIso(dosDate: number, dosTime: number): string | null {
  if (dosDate === 0) return null;
  const day = dosDate & 0x1f;
  const month = (dosDate >> 5) & 0x0f;
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const second = (dosTime & 0x1f) * 2;
  const minute = (dosTime >> 5) & 0x3f;
  const hour = (dosTime >> 11) & 0x1f;
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/**
 * Write a buffer to an absolute-or-relative path, creating parent directories.
 * Refuses to overwrite unless told to. Returns the resolved absolute path.
 */
export async function saveBuffer(
  buffer: Buffer,
  savePath: string,
  overwrite: boolean
): Promise<string> {
  const { mkdir, writeFile, access } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const abs = resolve(savePath);

  if (!overwrite) {
    let exists = true;
    try {
      await access(abs);
    } catch {
      exists = false;
    }
    if (exists) {
      throw new ClokioApiError(
        0,
        `Refusing to overwrite an existing file at ${abs}. Pass overwrite: true to replace it.`
      );
    }
  }

  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buffer);
  return abs;
}

export interface SavedFile {
  saved_to: string;
  file_name: string | undefined;
  mime_type: string;
  file_size: number;
  sha256: string;
}

/**
 * Download one attachment and either save it, or return its content in the most
 * usable form for its type:
 *   - save_path set  -> write to disk, return {saved_to, sha256, ...}
 *   - text-like      -> the decoded text (capped)
 *   - PDF            -> extracted text + page count (capped)
 *   - ZIP            -> the entry list
 *   - image          -> the image itself, as MCP image content
 *   - anything else  -> a type+size description, as today
 */
export async function downloadAttachment(
  config: ClokioConfig,
  taskId: number,
  attachmentId: number,
  opts: { fileName?: string; savePath?: string; overwrite?: boolean }
): Promise<unknown> {
  const { buffer, contentType } = await requestRawBytes(
    config,
    `/tasks/${taskId}/attachments/${attachmentId}`
  );
  const kb = (buffer.byteLength / 1024).toFixed(1);

  if (opts.savePath) {
    const abs = await saveBuffer(buffer, opts.savePath, opts.overwrite ?? false);
    const saved: SavedFile = {
      saved_to: abs,
      file_name: opts.fileName,
      mime_type: contentType,
      file_size: buffer.byteLength,
      sha256: await sha256Hex(buffer),
    };
    return saved;
  }

  const ext = extensionOf(opts.fileName);

  // PDF -> text
  if (ext === 'pdf' || contentType.includes('application/pdf')) {
    try {
      const { text, pages } = await extractPdfText(buffer);
      const { body, truncated } = capText(text);
      return {
        kind: 'pdf',
        pages,
        truncated,
        file_size: buffer.byteLength,
        text: body,
      };
    } catch (e) {
      return {
        kind: 'pdf',
        error: `Could not extract text from this PDF: ${(e as Error).message}. ` +
          'It may be encrypted or image-only. Pass save_path to write the raw file to disk.',
        file_size: buffer.byteLength,
      };
    }
  }

  // ZIP -> entry list
  if (ext === 'zip' || contentType.includes('application/zip')) {
    try {
      const entries = listZipEntries(buffer);
      return { kind: 'zip', entry_count: entries.length, entries };
    } catch (e) {
      return {
        kind: 'zip',
        error: `Could not list this ZIP: ${(e as Error).message}. Pass save_path to write it to disk.`,
        file_size: buffer.byteLength,
      };
    }
  }

  // Image -> hand it to the model
  const imageMime = imageMimeFor(contentType, opts.fileName);
  if (imageMime) {
    if (buffer.byteLength > IMAGE_INLINE_LIMIT) {
      return (
        `[image: ${imageMime}, ${kb} KB] - too large to return inline ` +
        `(limit ${(IMAGE_INLINE_LIMIT / 1024 / 1024).toFixed(0)} MB). ` +
        'Pass save_path to write it to disk.'
      );
    }
    const result: McpContentResult = mcpContent([
      {
        type: 'image' as const,
        data: buffer.toString('base64'),
        mimeType: imageMime,
      },
    ]);
    return result;
  }

  // Text -> decoded text (capped)
  if (looksLikeText(contentType, opts.fileName)) {
    const { body, truncated } = capText(buffer.toString('utf8'));
    if (!truncated) return body;
    return `[truncated: showing the first ${TEXT_INLINE_LIMIT.toLocaleString()} characters of ${kb} KB]\n\n${body}`;
  }

  // Anything else -> describe it.
  return (
    `[binary file: ${contentType}, ${kb} KB]\n\n` +
    'The bytes are not included - they would be unreadable here and would cost a great deal of context. ' +
    'Pass save_path to write the file to disk, or ask the person to open it in Clokio.'
  );
}

/**
 * The shape of an attachment row as the API returns it. Only the fields this
 * module reasons about are named; the rest pass through untouched.
 */
interface AttachmentRow {
  id: number;
  file_name?: string;
  created_at?: string;
  uploaded_at?: string;
  [key: string]: unknown;
}

/**
 * Stamp each attachment with is_latest: whether it is the newest upload bearing
 * its file_name on this task. "Newest" is decided by created_at (falling back to
 * uploaded_at, then id as a monotonic tiebreaker). A file_name with a single
 * upload is trivially latest.
 *
 * This is computed client-side rather than asked of the API, deliberately: the
 * API has no versioning concept, and the MCP is a thin wrapper that adds no
 * server state. The field is ADDITIVE - existing readers that ignore it are
 * unaffected.
 */
export function stampIsLatest<T extends AttachmentRow>(rows: T[]): Array<T & { is_latest: boolean }> {
  // Rank as a (timestamp, id) PAIR, compared lexicographically - never folded
  // into one number. A millisecond epoch is ~1.7e12; multiplying by an id to
  // make room overflows Number.MAX_SAFE_INTEGER (9e15), silently dropping the
  // id and losing the tiebreak - a real bug the tie test caught. A row with no
  // parseable stamp sorts below any that has one (-Infinity), then by id.
  const nameOf = (r: AttachmentRow): string => r.file_name ?? `__id_${r.id}`;
  const stampMs = (r: AttachmentRow): number => {
    const s = r.created_at ?? r.uploaded_at;
    const t = s ? Date.parse(s) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  // true if a ranks strictly higher than b (newer stamp, or equal stamp + higher id).
  const higher = (a: AttachmentRow, b: AttachmentRow): boolean => {
    const ta = stampMs(a);
    const tb = stampMs(b);
    return ta !== tb ? ta > tb : a.id > b.id;
  };

  const winner = new Map<string, T>();
  for (const r of rows) {
    const name = nameOf(r);
    const current = winner.get(name);
    if (current === undefined || higher(r, current)) winner.set(name, r);
  }

  return rows.map((r) => ({
    ...r,
    is_latest: winner.get(nameOf(r))?.id === r.id,
  }));
}
