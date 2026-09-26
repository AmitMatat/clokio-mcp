#!/usr/bin/env node
/**
 * clokio-mcp — an MCP server for the Clokio Public API.
 *
 * Exposes tasks, projects/clients, employees and attendance as MCP tools over
 * stdio. Auth is the per-user CLOKIO_API_KEY (an X-API-Key credential); the key
 * carries its own scopes, so this server never re-implements authorization.
 *
 * Run: CLOKIO_API_KEY=clk_... node dist/index.js
 * Or register with: claude mcp add clokio -- npx -y clokio-mcp
 * (set CLOKIO_API_KEY, and optionally CLOKIO_BASE_URL, in the MCP env).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './client.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerProjectTools } from './tools/projects.js';
import { registerEmployeeTools } from './tools/employees.js';
import { registerAttendanceTools } from './tools/attendance.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const server = new McpServer({
    name: 'clokio-mcp',
    version: '0.1.0',
  });

  registerTaskTools(server, config);
  registerProjectTools(server, config);
  registerEmployeeTools(server, config);
  registerAttendanceTools(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr is safe for logs on stdio transport (stdout carries the protocol).
  process.stderr.write(`clokio-mcp connected (base: ${config.baseUrl})\n`);
}

main().catch((e) => {
  process.stderr.write(`clokio-mcp failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});
