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

/**
 * Encode ONE path segment supplied by a tool argument.
 *
 * Interpolating a raw argument into a request path lets it change which
 * endpoint is called: `?` truncates the path (so a hardcoded `/status` suffix
 * becomes query noise and the request lands on a different route), `/` adds
 * segments, and `..` climbs. encodeURIComponent turns all of them into their
 * percent-encoded forms, which the API then sees as a single literal value -
 * and its own `[A-Za-z0-9_-]` route constraint rejects it.
 *
 * Every tool that puts a STRING into a path must wrap it in this. Numeric
 * (z.number().int()) arguments cannot carry separators and need no wrapping,
 * but passing them through is harmless.
 */
export function seg(value: string | number): string {
  const s = String(value);
  // encodeURIComponent leaves `.` alone, so a bare `.` or `..` would survive
  // as a real dot-segment and be normalised away by new URL(). The prefix
  // guard in request() already catches the escape; refusing here keeps the
  // error at the argument that caused it, and an empty segment would silently
  // collapse `/a//b` into `/a/b` and hit a neighbouring route.
  if (s === '' || s === '.' || s === '..') {
    throw new ClokioApiError(0, `Invalid path argument ${JSON.stringify(s)}.`);
  }
  return encodeURIComponent(s);
}

/**
 * Fetch an endpoint that returns a FILE rather than the JSON envelope.
 *
 * Only the attachment download does this today. Text comes back as text;
 * anything binary is DESCRIBED rather than returned, because a model that
 * asks for a 4 MB PNG cannot use the bytes and pouring them into the
 * conversation as mojibake costs a fortune in tokens and tells it nothing.
 * The description still answers the question the caller actually had - is
 * there a file here, what kind, how big.
 */
export async function requestRaw(
  config: ClokioConfig,
  path: string,
  fileName?: string
): Promise<string> {
  const url = new URL(`${config.baseUrl}/api/v1${path.startsWith('/') ? path : `/${path}`}`);

  const expectedPrefix = new URL(config.baseUrl).pathname.replace(/\/+$/, '') + '/api/v1/';
  if (!url.pathname.startsWith(expectedPrefix)) {
    throw new ClokioApiError(0, 'Refusing to send a request outside /api/v1.');
  }

  let res: Response;
  try {
    // `manual`, not 'error' and not 'follow'.
    //
    // The API streams small and renderable files, but 302s to a short-lived
    // signed storage URL for anything over 8 MB. 'error' would report every
    // large attachment as a bogus network failure. 'follow' is worse: Node
    // re-sends request headers on a redirect, so X-API-Key would be handed
    // to another origin, which is the leak the redirect: 'error' on the JSON
    // path exists to prevent. So the redirect is followed HERE, by hand,
    // with no credential attached - the signed URL needs none.
    res = await fetch(url, {
      headers: { 'X-API-Key': config.apiKey },
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new ClokioApiError(0, 'Clokio redirected the download without a destination.');
      }

      // WHERE the redirect may point is constrained, even though the key does
      // not travel with it.
      //
      // new URL() resolution is unrestricted: `file:///etc/passwd`, `data:...`
      // and `http://169.254.169.254/...` all resolve to themselves rather than
      // inheriting our origin. Node's fetch refuses most of those schemes on
      // its own, but `data:` it happily resolves, and an http(s) target is a
      // blind SSRF - this process would fetch an attacker-named URL and return
      // up to 100k characters of the response into the model's context.
      //
      // Reaching that requires control of the API's own response, at which
      // point the attacker could have put the same bytes in the attachment
      // body - so it buys them nothing today. It is refused anyway because the
      // check is free, and because "the API is trustworthy" is the assumption
      // most likely to stop being true.
      const target = new URL(location, url);
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        throw new ClokioApiError(
          0,
          `Refusing to follow a download redirect to a ${target.protocol} URL.`
        );
      }

      // NO headers: the key must not cross to the storage origin.
      res = await fetch(target, { redirect: 'error' });
    }
  } catch (e) {
    if (e instanceof ClokioApiError) throw e;
    throw new ClokioApiError(0, `Network error reaching Clokio: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text();
    let message = `Clokio API returned HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.message === 'string') message = parsed.message;
    } catch {
      /* a non-JSON error body is not more informative than the status */
    }
    throw new ClokioApiError(res.status, message);
  }

  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  const buffer = Buffer.from(await res.arrayBuffer());

  // CONTENT-TYPE IS NOT ENOUGH. The API deliberately re-labels html, json,
  // js, svg and xml attachments as application/octet-stream so a browser
  // cannot render them from our origin - an XSS defence. Trusting the header
  // alone would report a JSON report an agent attached as unreadable binary,
  // so the file EXTENSION gets a say too.
  const extension = (fileName ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
    'html', 'htm', 'log', 'diff', 'patch', 'sql', 'js', 'ts', 'css', 'svg',
  ]);

  const isText =
    type.startsWith('text/') ||
    /\b(json|xml|csv|yaml|javascript|markdown)\b/.test(type) ||
    TEXT_EXTENSIONS.has(extension);

  const kb = (buffer.byteLength / 1024).toFixed(1);

  if (isText) {
    // A CAP ON TEXT TOO. Attachments go up to 200 MB and .csv/.log are
    // allowed, so "it is text" does not make it safe to paste: a 40 MB CSV
    // would be dumped whole into the conversation. Truncate and SAY SO, so
    // the reader never mistakes a prefix for the entire file.
    const LIMIT = 100_000;
    const text = buffer.toString('utf8');
    if (text.length <= LIMIT) {
      return text;
    }

    return (
      `[truncated: showing the first ${LIMIT.toLocaleString()} characters of ${kb} KB]\n\n` +
      text.slice(0, LIMIT) +
      `\n\n[...truncated. ${(text.length - LIMIT).toLocaleString()} more characters not shown.]`
    );
  }

  return (
    `[binary file: ${type}, ${kb} KB]\n\n` +
    'The bytes are not included - they would be unreadable here and would cost a great deal of context. ' +
    'Ask the person to open the attachment in Clokio, or fetch this path yourself if you can handle binary.'
  );
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

  // A tool argument interpolated into `path` must never be able to change
  // WHICH endpoint is called. new URL() normalises the assembled string, so a
  // value containing `?` truncates the path (turning `/employees/X/status`
  // into `/employees/X/pin?...`) and `../` segments climb out of /api/v1.
  // That is an endpoint pivot: a caller who approved "set employee status"
  // would instead reach PATCH /employees/{code}/pin, which resets a person's
  // clock-in PIN and returns it in the response. Callers validate their own
  // arguments, but this is the invariant that holds even if one forgets.
  const expectedPrefix = new URL(config.baseUrl).pathname.replace(/\/+$/, '') + '/api/v1/';
  if (!url.pathname.startsWith(expectedPrefix)) {
    throw new ClokioApiError(
      0,
      'Refusing to send a request outside /api/v1 - a path argument tried to change the endpoint.'
    );
  }
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
    // redirect: 'error' - Node's fetch follows redirects and RESENDS the
    // request headers, including X-API-Key, to wherever Location points, on
    // any origin. The API never redirects an /api/v1 call, so a redirect here
    // means something between us and it is not the API, and the key must not
    // be handed over. Failing closed costs nothing on the happy path.
    res = await fetch(url, { method, headers, body: payload, redirect: 'error' });
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
