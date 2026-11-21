import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodRawShape } from 'zod';
import { ClokioApiError, ClokioConfig } from '../client.js';

/**
 * A pre-built MCP result a handler may return instead of a plain value, for the
 * cases plain JSON text cannot express - returning an image to the model, or
 * several content blocks at once. A handler that returns one of these has it
 * passed through untouched; anything else is rendered as text exactly as before.
 *
 * Recognised by the `__mcpContent` brand so it can never collide with a real API
 * payload (no Clokio response carries that key).
 */
export interface McpContentResult {
  __mcpContent: true;
  content: CallToolResult['content'];
  isError?: boolean;
}

export function mcpContent(
  content: CallToolResult['content'],
  isError = false
): McpContentResult {
  return { __mcpContent: true, content, isError };
}

function isMcpContentResult(value: unknown): value is McpContentResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as any).__mcpContent === true &&
    Array.isArray((value as any).content)
  );
}

/**
 * Register one Clokio tool. The handler returns any JSON-serialisable value,
 * rendered as pretty JSON text. ClokioApiError becomes an isError tool result
 * carrying the API's own status + message, so the model can correct its request
 * (a 422 naming the bad field, a 404, a 403 scope refusal).
 *
 * A handler may instead return `mcpContent([...])` to emit raw MCP content
 * blocks - an image the model can see, or several blocks together. That path is
 * used by the attachment tools (an image comes back as an image, not a size
 * description); every other tool returns a plain value and is rendered as text.
 *
 * `mutates` marks a tool that changes data (create/update/delete): it sets the
 * MCP readOnlyHint/destructiveHint annotations so clients can surface a warning.
 */
export function registerTool<S extends ZodRawShape>(
  server: McpServer,
  config: ClokioConfig,
  def: {
    name: string;
    description: string;
    schema: S;
    mutates?: boolean | 'destructive';
    handler: (args: z.infer<z.ZodObject<S>>, config: ClokioConfig) => Promise<unknown>;
  }
): void {
  const callback = async (args: any): Promise<CallToolResult> => {
      try {
        const result = await def.handler(args, config);
        // A handler may hand back pre-built MCP content (an image, multiple
        // blocks). Pass it through verbatim rather than JSON-stringifying it.
        if (isMcpContentResult(result)) {
          return { content: result.content, ...(result.isError ? { isError: true } : {}) };
        }
        return {
          content: [
            {
              type: 'text' as const,
              // A 204 (delete) has no body, so request() resolves undefined and
              // JSON.stringify(undefined) is undefined - not a valid text block.
              text:
                result === undefined
                  ? 'OK (no content)'
                  : typeof result === 'string'
                    ? result
                    : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (e) {
        if (e instanceof ClokioApiError) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  `Clokio API error (HTTP ${e.status}): ${e.message}` +
                  (e.body ? `\n\nDetails:\n${JSON.stringify(e.body, null, 2)}` : ''),
              },
            ],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }],
        };
      }
    };

  server.registerTool(
    def.name,
    {
      description: def.description,
      inputSchema: def.schema,
      annotations: {
        readOnlyHint: !def.mutates,
        destructiveHint: def.mutates === 'destructive',
      },
    },
    // The SDK's callback type is an inline structural shape that our
    // CallToolResult return does not unify with under strict generics; the
    // runtime shape is correct, so the cast is the pragmatic bridge.
    callback as any
  );
}

/**
 * 0.23.0 review: whether a YYYY-MM-DD string names a real calendar day.
 * Date.parse rolls 2026-02-30 over to 2 March, so the round trip is the check.
 */
export function isCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** A YYYY-MM-DD argument that must also be a real calendar date. */
export function calendarDate(name: string) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${name} must be YYYY-MM-DD`)
    .refine(isCalendarDate, `${name} must be a real calendar date (YYYY-MM-DD)`);
}

/**
 * 0.39.0: a tool that takes its task (or ticket) as `id` also accepts the
 * name a model reaches for first, `task_id` (or `ticket_id`). Either one is
 * accepted and exactly one is required; both given and different is an
 * error. `id` keeps working (backward compatible).
 *
 * `idAliasShape` is the schema fragment; `withIdAlias` wraps a handler so it
 * still reads `args.id`, resolved before the handler runs.
 */
export type IdAlias = 'task_id' | 'ticket_id';

export function idAliasShape<K extends IdAlias>(alias: K, what: string, positive = false) {
  const base = positive ? z.number().int().positive() : z.number().int();
  return {
    id: base.optional().describe(`${what} (or pass it as ${alias}; give one of the two)`),
    [alias]: base.optional().describe(`Same as id: ${what}`),
  } as { id: z.ZodOptional<z.ZodNumber> } & { [P in K]: z.ZodOptional<z.ZodNumber> };
}

/** The id a call names through `id` or its alias; throws a clear error otherwise. */
export function resolveIdAlias(args: Record<string, unknown>, alias: IdAlias): number {
  const a = args.id as number | undefined;
  const b = args[alias] as number | undefined;
  if (a === undefined && b === undefined) {
    throw new Error(`Give the ${alias.replace('_id', '')} as id or ${alias} (one of the two is required).`);
  }
  if (a !== undefined && b !== undefined && a !== b) {
    throw new Error(`id (${a}) and ${alias} (${b}) name different ${alias.replace('_id', '')}s: give one of them.`);
  }
  return (a ?? b) as number;
}

/** Wrap a handler that reads `args.id`, so `id` or the alias both reach it. */
export function withIdAlias<A extends Record<string, unknown>, R>(
  alias: IdAlias,
  fn: (args: Omit<A, 'id'> & { id: number }, cfg: ClokioConfig) => R,
): (args: A, cfg: ClokioConfig) => R {
  return (args, cfg) => {
    const id = resolveIdAlias(args, alias);
    const rest: Record<string, unknown> = { ...args };
    delete rest[alias];
    return fn({ ...(rest as Omit<A, 'id'>), id }, cfg);
  };
}
