import { createRequire } from 'node:module';

/**
 * This package's version, read from package.json at runtime.
 *
 * ONE source for it. A literal went stale on the first patch release (0.1.1
 * announced itself as 0.1.0), and there are now two consumers that must not
 * drift apart: the MCP handshake in index.ts, and clokio_whoami, which
 * reports it so a session can tell WHICH build it is running.
 *
 * That second use is not cosmetic. `npx -y clokio-mcp` can serve a cached old
 * build, and a session then reports bugs fixed releases ago against tools it
 * does not have - which is exactly what happened on 2026-09-26, with 0.1.2
 * running while 0.5.3 was current.
 */
export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
