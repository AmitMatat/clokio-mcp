import { ClokioApiError } from '../client.js';
export function mcpContent(content, isError = false) {
    return { __mcpContent: true, content, isError };
}
function isMcpContentResult(value) {
    return (typeof value === 'object' &&
        value !== null &&
        value.__mcpContent === true &&
        Array.isArray(value.content));
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
export function registerTool(server, config, def) {
    const callback = async (args) => {
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
                        type: 'text',
                        // A 204 (delete) has no body, so request() resolves undefined and
                        // JSON.stringify(undefined) is undefined - not a valid text block.
                        text: result === undefined
                            ? 'OK (no content)'
                            : typeof result === 'string'
                                ? result
                                : JSON.stringify(result, null, 2),
                    },
                ],
            };
        }
        catch (e) {
            if (e instanceof ClokioApiError) {
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: `Clokio API error (HTTP ${e.status}): ${e.message}` +
                                (e.body ? `\n\nDetails:\n${JSON.stringify(e.body, null, 2)}` : ''),
                        },
                    ],
                };
            }
            return {
                isError: true,
                content: [{ type: 'text', text: `Error: ${e.message}` }],
            };
        }
    };
    server.registerTool(def.name, {
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
    callback);
}
