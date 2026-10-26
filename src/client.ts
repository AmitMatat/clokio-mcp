/**
 * The ONE place that talks to the Clokio Public API.
 *
 * Every tool goes through this module; nothing else builds a fetch. Auth is
 * the per-user `CLOKIO_API_KEY` sent as `X-API-Key`, exactly as the
 * clokio-task CLI does. The key carries its own scopes (and, for documents,
 * its "acts as" employee), so this server never re-implements authorization -
 * a 403/404/422 from the API is surfaced verbatim.
 */

export type ClokioMode = 'admin' | 'employee';

export interface ClokioConfig {
  baseUrl: string;
  /**
   * admin: CLOKIO_API_KEY (clk_...) sent as X-API-Key to /api/v1 - the
   * organisation-wide Public API, scoped by the key's own scopes.
   * employee: CLOKIO_EMPLOYEE_KEY sent as X-Employee-Key to /api/employee -
   * acts AS that person, bound by their roles and project permissions, which
   * the server judges on every call. Any employee issues one from their profile.
   */
  mode: ClokioMode;
  apiKey: string;
  /**
   * The employee_code to attribute writes to when a tool does not name one.
   *
   * The API already falls back to the KEY'S ISSUER for an unnamed write, so
   * a person using their own key gets correct attribution with no config at
   * all. This is only for the case that fallback does not cover: a SHARED or
   * service key whose issuer is not the person actually acting. Set
   * CLOKIO_DEFAULT_ACTOR and every unnamed create/comment/update is credited
   * to that code instead. An explicit code on a tool call always wins.
   */
  defaultActor?: string;
}

export function loadConfig(): ClokioConfig {
  const adminKey = process.env.CLOKIO_API_KEY?.trim();
  const employeeKey = process.env.CLOKIO_EMPLOYEE_KEY?.trim();
  if (adminKey && employeeKey) {
    throw new Error(
      'Both CLOKIO_API_KEY and CLOKIO_EMPLOYEE_KEY are set. Set exactly one: CLOKIO_API_KEY for the ' +
        'organisation-wide Public API (admin, clk_...), or CLOKIO_EMPLOYEE_KEY to act as one person with ' +
        'their own permissions.'
    );
  }
  if (!adminKey && !employeeKey) {
    throw new Error(
      'No Clokio key is set. Provide CLOKIO_API_KEY (an admin Public API key, clk_...) or ' +
        'CLOKIO_EMPLOYEE_KEY (a personal key from Profile -> API keys, acts as you with your own permissions).'
    );
  }
  const mode: ClokioMode = employeeKey ? 'employee' : 'admin';
  const apiKey = (employeeKey ?? adminKey) as string;
  const baseUrl = (process.env.CLOKIO_BASE_URL?.trim() || 'https://app.clokio.io').replace(/\/+$/, '');

  const defaultActor = process.env.CLOKIO_DEFAULT_ACTOR?.trim() || undefined;
  // Validate the same way the API constrains an employee_code, so a
  // misconfigured value fails at startup rather than silently on every write.
  if (defaultActor && mode === 'employee') {
    throw new Error(
      'CLOKIO_DEFAULT_ACTOR has no meaning with CLOKIO_EMPLOYEE_KEY: the key already IS the actor. Unset it.'
    );
  }
  if (defaultActor && !/^[A-Za-z0-9_-]{1,50}$/.test(defaultActor)) {
    throw new Error(
      'CLOKIO_DEFAULT_ACTOR must be an employee_code (1-50 chars of letters, digits, _ or -).'
    );
  }

  return { baseUrl, mode, apiKey, defaultActor };
}

/** The URL prefix the mode talks to. */
export function apiPrefix(config: ClokioConfig): string {
  return config.mode === 'employee' ? '/api/employee' : '/api/v1';
}

/** The one header that authenticates the mode's key. */
export function authHeaders(config: ClokioConfig): Record<string, string> {
  return config.mode === 'employee' ? { 'X-Employee-Key': config.apiKey } : { 'X-API-Key': config.apiKey };
}

/**
 * Assemble an /api/v1 request URL and enforce the prefix guard.
 *
 * A tool argument interpolated into `path` must never be able to change
 * WHICH endpoint is called. new URL() normalises the assembled string, so a
 * value containing `?` truncates the path (turning `/employees/X/status`
 * into `/employees/X/pin?...`) and `../` segments climb out of /api/v1.
 * That is an endpoint pivot: a caller who approved "set employee status"
 * would instead reach PATCH /employees/{code}/pin, which resets a person's
 * clock-in PIN and returns it in the response. Callers wrap string arguments
 * in seg(), but this is the invariant that holds even if one forgets.
 */
export function buildUrl(config: ClokioConfig, path: string): URL {
  const prefix = apiPrefix(config);
  const url = new URL(`${config.baseUrl}${prefix}${path.startsWith('/') ? path : `/${path}`}`);
  const expectedPrefix = new URL(config.baseUrl).pathname.replace(/\/+$/, '') + prefix + '/';
  if (!url.pathname.startsWith(expectedPrefix)) {
    throw new ClokioApiError(
      0,
      `Refusing to send a request outside ${prefix} - a path argument tried to change the endpoint.`
    );
  }
  return url;
}

/**
 * The file name a download response declares (Content-Disposition), or
 * undefined. Used only as a type-detection hint and a default display name;
 * a SAVE never trusts it as a path (see safeAttachmentName in attachments.ts).
 */
function dispositionFileName(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/);
  return plain ? plain[1].trim() : undefined;
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
/**
 * The raw bytes of a file endpoint, plus the content-type the API reported.
 *
 * This is the shared core: it owns the /api/v1 prefix guard, the by-hand
 * redirect to signed storage with NO credential attached, and the redirect
 * target scheme check - all the security-load-bearing parts of the download
 * path. `requestRaw` renders these bytes as text/description for the model;
 * the save-to-disk and typed-content tools consume the bytes directly.
 */
export async function requestRawBytes(
  config: ClokioConfig,
  path: string,
  query?: RequestOptions['query']
): Promise<{ buffer: Buffer; contentType: string; fileName?: string }> {
  const auth = authHeaders(config);
  const url = buildUrl(config, path);
  applyQuery(url, query);

  let res: Response;
  try {
    // `manual`, not 'error' and not 'follow' - see the long note in requestRaw.
    res = await fetch(url, {
      headers: auth,
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new ClokioApiError(0, 'Clokio redirected the download without a destination.');
      }
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

  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const fileName = dispositionFileName(res.headers.get('content-disposition'));
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType, fileName };
}

/**
 * Decide whether an attachment is text, from BOTH the content-type and the file
 * extension. Exported because the download tool needs the same verdict the
 * renderer uses, to choose between text, PDF, image and binary handling.
 *
 * CONTENT-TYPE IS NOT ENOUGH. The API deliberately re-labels html, json, js,
 * svg and xml attachments as application/octet-stream so a browser cannot
 * render them from our origin - an XSS defence. Trusting the header alone would
 * report a JSON report an agent attached as unreadable binary, so the file
 * EXTENSION gets a say too.
 */
export function looksLikeText(contentType: string, fileName?: string): boolean {
  const extension = (fileName ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
    'html', 'htm', 'log', 'diff', 'patch', 'sql', 'js', 'ts', 'css', 'svg',
  ]);
  return (
    contentType.startsWith('text/') ||
    /\b(json|xml|csv|yaml|javascript|markdown)\b/.test(contentType) ||
    TEXT_EXTENSIONS.has(extension)
  );
}

export async function requestRaw(
  config: ClokioConfig,
  path: string,
  fileName?: string
): Promise<string> {
  const auth = authHeaders(config);
  const url = buildUrl(config, path);

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
      headers: auth,
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

  const isText = looksLikeText(type, fileName);
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

/**
 * Upload a LOCAL FILE to a Clokio endpoint as multipart/form-data.
 *
 * The one write on this API that is not JSON. The tool gives a file PATH the
 * model can already reach (it is running in a session with a filesystem), this
 * reads it and sends it under the `file` field. Extra text fields (e.g.
 * uploaded_by_employee_code) ride along.
 *
 * The same /api/v1 prefix guard and redirect: 'error' as request(), so the
 * upload path is not a hole in either defence, and the key is sent as a header
 * exactly as elsewhere - multipart does not change where the credential goes.
 */
export async function requestUpload<T = unknown>(
  config: ClokioConfig,
  path: string,
  filePath: string,
  fields: Record<string, string | undefined> = {}
): Promise<T> {
  const { readFile } = await import('node:fs/promises');
  const { basename } = await import('node:path');

  const auth = authHeaders(config);
  const url = buildUrl(config, path);

  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (e) {
    throw new ClokioApiError(0, `Could not read the file at ${filePath}: ${(e as Error).message}`);
  }

  const form = new FormData();
  // A fresh Uint8Array view is a valid BlobPart; a Node Buffer is not, under
  // strict lib types.
  form.append('file', new Blob([new Uint8Array(bytes)]), basename(filePath));
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, value);
  }

  let res: Response;
  try {
    // Content-Type is set BY fetch from the FormData (with the boundary); do
    // not set it by hand or the boundary is lost.
    res = await fetch(url, {
      method: 'POST',
      headers: { ...auth, Accept: 'application/json' },
      body: form,
      redirect: 'error',
    });
  } catch (e) {
    throw new ClokioApiError(0, `Network error reaching Clokio: ${(e as Error).message}`);
  }

  return parseEnvelope<T>(res);
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
  /**
   * Extra request headers (today only Idempotency-Key on a ticket reply).
   * They can never replace X-API-Key or Accept: those are set after them.
   */
  headers?: Record<string, string>;
  /**
   * Called with the response headers of a SUCCESSFUL answer, before the body
   * is unwrapped (0.25.0: `Idempotency-Replayed: true` marks a replayed
   * idempotent write). Never called for an error answer.
   */
  onHeaders?: (headers: Headers) => void;
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
  const { method = 'GET', query, body, headers: extra, onHeaders } = options;

  const url = buildUrl(config, path);
  applyQuery(url, query);

  const headers: Record<string, string> = {
    ...(extra ?? {}),
    ...authHeaders(config),
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
    // any origin. The API never redirects a JSON /api/v1 call, so a redirect
    // here means something between us and it is not the API, and the key
    // must not be handed over. Failing closed costs nothing on the happy path.
    res = await fetch(url, { method, headers, body: payload, redirect: 'error' });
  } catch (e) {
    throw new ClokioApiError(0, `Network error reaching Clokio: ${(e as Error).message}`);
  }

  if (res.ok && onHeaders) onHeaders(res.headers);

  return parseEnvelope<T>(res);
}

function applyQuery(url: URL, query: RequestOptions['query']): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(`${key}[]`, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function parseEnvelope<T>(res: Response): Promise<T> {
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

  // Standard envelope: {status, message, data, meta?}. Unwrap `data`, but
  // KEEP `meta` when the API sent one.
  //
  // Unwrapping both was a real defect: list endpoints return
  // meta.next_cursor, meta.total and meta.last_page, and this threw all of it
  // away. The tool descriptions told the model to page with a cursor while
  // the value it needed had already been discarded - so a caller could not
  // tell a full first page from the whole result set, and every crawl past
  // page one was impossible. Reported 2026-09-26.
  //
  // `data` is returned bare when there is no meta, so single-object reads
  // (get_task, whoami) keep the shape they have always had.
  if (parsed && typeof parsed === 'object' && 'data' in parsed) {
    const envelope = parsed as { data: unknown; meta?: unknown };

    if (envelope.meta !== undefined && envelope.meta !== null) {
      return { data: envelope.data, meta: envelope.meta } as T;
    }

    return envelope.data as T;
  }
  return parsed as T;
}
