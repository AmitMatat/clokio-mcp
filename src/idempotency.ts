/**
 * Idempotent creates, shared by every toolset that sends an Idempotency-Key
 * (tickets since 0.25.0, the CRM since 0.37.0). Moved here from
 * tools/tickets.ts unchanged, so the ticket and CRM tools read one copy.
 */
import { ClokioConfig, request } from './client.js';

/** The Idempotency-Key shape the server accepts (8-191 of A-Za-z0-9 . _ : -). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,191}$/;

/**
 * E7 (0.25.0): whether a successful idempotent write was a REPLAY of an
 * earlier answer: the `Idempotency-Replayed: true` header, or `replayed: true`
 * in the answer's data. A replay wrote nothing and sent nothing.
 */
export function isReplay(headers: Headers | null, data: any): boolean {
  return headers?.get('idempotency-replayed')?.trim().toLowerCase() === 'true' || data?.replayed === true;
}

/** An idempotent POST that also reports whether the server replayed it. */
export async function idempotentPost(cfg: ClokioConfig, path: string, key: string, body: unknown): Promise<{ res: any; replayed: boolean }> {
  let headers: Headers | null = null;
  const res = await request<any>(cfg, path, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body,
    onHeaders: (h) => {
      headers = h;
    },
  });
  return { res, replayed: isReplay(headers, res) };
}
