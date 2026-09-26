/**
 * The ONE place that talks to the Clokio Public API.
 *
 * Every tool goes through request(); nothing else builds a fetch. Auth is the
 * per-user `CLOKIO_API_KEY` sent as `X-API-Key`, exactly as the clokio-task CLI
 * does. The key carries its own scopes, so this server never re-implements
 * authorization — a 403/422 from the API is surfaced verbatim.
 */

export interface ClokioConfig {
  baseUrl: string;
  apiKey: string;
}

export function loadConfig(): ClokioConfig {
  const apiKey = process.env.CLOKIO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'CLOKIO_API_KEY is not set. Provide your Clokio API key (clk_...) via the ' +
        'CLOKIO_API_KEY environment variable.'
    );
  }
  const baseUrl = (process.env.CLOKIO_BASE_URL?.trim() || 'https://app.clokio.io').replace(/\/+$/, '');
  return { baseUrl, apiKey };
}

/** A Clokio API error, carrying the HTTP status and the server's message. */
export class ClokioApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown
  ) {
    super(message);
    this.name = 'ClokioApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Query params; undefined/null values are dropped, arrays become repeated keys. */
  query?: Record<string, string | number | boolean | Array<string | number> | undefined | null>;
  /** JSON body for write methods. */
  body?: unknown;
}

/**
 * Perform a Clokio API v1 request under `/api/v1`. Returns the parsed `data`
 * field of the standard `{status, message, data}` envelope when present, or the
 * whole parsed body otherwise. Throws ClokioApiError on a non-2xx response with
 * the server's own message.
 */
export async function request<T = unknown>(
  config: ClokioConfig,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { method = 'GET', query, body } = options;

  const url = new URL(`${config.baseUrl}/api/v1${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(`${key}[]`, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    'X-API-Key': config.apiKey,
    Accept: 'application/json',
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch (e) {
    throw new ClokioApiError(0, `Network error reaching Clokio: ${(e as Error).message}`);
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const message =
      (parsed && typeof parsed === 'object' && 'message' in parsed && typeof (parsed as any).message === 'string'
        ? (parsed as any).message
        : `Clokio API returned HTTP ${res.status}`) as string;
    throw new ClokioApiError(res.status, message, parsed);
  }

  // Standard envelope: {status, message, data}. Unwrap `data` when present.
  if (parsed && typeof parsed === 'object' && 'data' in parsed) {
    return (parsed as any).data as T;
  }
  return parsed as T;
}
