import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodRawShape } from 'zod';
import { ClokioApiError, ClokioConfig } from '../client.js';

/**
 * Register one Clokio tool. The handler returns any JSON-serialisable value,
 * rendered as pretty JSON text. ClokioApiError becomes an isError tool result
 * carrying the API's own status + message, so the model can correct its request
 * (a 422 naming the bad field, a 404, a 403 scope refusal).
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
