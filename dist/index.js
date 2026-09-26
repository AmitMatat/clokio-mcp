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
import { VERSION } from './version.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerProjectTools } from './tools/projects.js';
import { registerEmployeeTools } from './tools/employees.js';
import { registerAttendanceTools } from './tools/attendance.js';
/**
 * The optional tool groups a session can turn OFF.
 *
 * tools/list is ~8k tokens with everything registered, and a task-focused
 * session never touches the 13 attendance/leave/time tools or the 5 employee
 * ones. Setting e.g. CLOKIO_TOOLSETS=tasks drops them, cutting the per-session
 * cost.
 *
 * `projects` is NOT selectable: it holds whoami and the reference lookups
 * (task statuses, labels, projects, locations) that the task tools depend on
 * to resolve names to ids, so it is always registered. Naming a toolset that
 * does not exist is refused at startup rather than silently ignored.
 */
const OPTIONAL_TOOLSETS = ['tasks', 'employees', 'attendance'];
function selectedToolsets() {
    const raw = process.env.CLOKIO_TOOLSETS?.trim();
    if (!raw) {
        // Default: everything.
        return new Set(OPTIONAL_TOOLSETS);
    }
    const requested = raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    const unknown = requested.filter((s) => !OPTIONAL_TOOLSETS.includes(s));
    if (unknown.length) {
        throw new Error(`CLOKIO_TOOLSETS names unknown toolset(s): ${unknown.join(', ')}. ` +
            `Valid values are: ${OPTIONAL_TOOLSETS.join(', ')} (projects is always on).`);
    }
    return new Set(requested);
}
async function main() {
    const config = loadConfig();
    const toolsets = selectedToolsets();
    const server = new McpServer({
        name: 'clokio-mcp',
        version: VERSION,
    });
    // Always on: whoami plus the reference lookups the task tools resolve
    // names against.
    registerProjectTools(server, config);
    if (toolsets.has('tasks'))
        registerTaskTools(server, config);
    if (toolsets.has('employees'))
        registerEmployeeTools(server, config);
    if (toolsets.has('attendance'))
        registerAttendanceTools(server, config);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stderr is safe for logs on stdio transport (stdout carries the protocol).
    const active = ['projects', ...OPTIONAL_TOOLSETS.filter((t) => toolsets.has(t))].join(', ');
    process.stderr.write(`clokio-mcp ${VERSION} connected (base: ${config.baseUrl}, toolsets: ${active})\n`);
}
main().catch((e) => {
    process.stderr.write(`clokio-mcp failed to start: ${e.message}\n`);
    process.exit(1);
});
