#!/usr/bin/env node
/**
 * clokio-mcp - an MCP server for the Clokio Public API.
 *
 * Exposes tasks, projects/clients, employees, attendance, documents and support
 * tickets as MCP tools over stdio. Auth is the per-user CLOKIO_API_KEY (an X-API-Key
 * credential); the key carries its own scopes, so this server never
 * re-implements authorization. Documents additionally need a key that "acts
 * as" an employee - the API decides that, not this server.
 *
 * Run: CLOKIO_API_KEY=clk_... node dist/index.js
 * Or register with: claude mcp add clokio -- npx -y clokio-mcp
 * (set CLOKIO_API_KEY, and optionally CLOKIO_BASE_URL, in the MCP env).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClokioApiError, loadConfig, request } from './client.js';
import { VERSION } from './version.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerProjectTools } from './tools/projects.js';
import { registerEmployeeTools } from './tools/employees.js';
import { registerAttendanceTools } from './tools/attendance.js';
import { registerDocTools } from './tools/docs.js';
import { registerEmployeeIdentityTools, registerEmployeeModeTools } from './tools/employee.js';
import { registerTicketTools } from './tools/tickets.js';


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
const OPTIONAL_TOOLSETS = ['tasks', 'employees', 'attendance', 'docs', 'tickets'] as const;
type Toolset = (typeof OPTIONAL_TOOLSETS)[number];

function selectedToolsets(): Set<Toolset> {
  const raw = process.env.CLOKIO_TOOLSETS?.trim();
  if (!raw) {
    // Default: everything.
    return new Set(OPTIONAL_TOOLSETS);
  }

  const requested = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const unknown = requested.filter((s) => !(OPTIONAL_TOOLSETS as readonly string[]).includes(s));
  if (unknown.length) {
    throw new Error(
      `CLOKIO_TOOLSETS names unknown toolset(s): ${unknown.join(', ')}. ` +
        `Valid values are: ${OPTIONAL_TOOLSETS.join(', ')} (projects is always on).`
    );
  }

  return new Set(requested as Toolset[]);
}

const EMPLOYEE_TOOLSETS = ['tasks', 'docs'] as const;

/**
 * Employee mode: the personal X-Employee-Key surface. Only tasks and docs
 * exist there, so CLOKIO_TOOLSETS may name those two and nothing else.
 */
function selectedEmployeeToolsets(): Set<Toolset> {
  const raw = process.env.CLOKIO_TOOLSETS?.trim();
  if (!raw) return new Set(EMPLOYEE_TOOLSETS);
  // Its own check, never the admin one: that error lists the admin toolsets
  // and says "projects is always on", neither of which is true here.
  const requested = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unsupported = requested.filter((t) => !(EMPLOYEE_TOOLSETS as readonly string[]).includes(t));
  if (unsupported.length) {
    throw new Error(
      `CLOKIO_TOOLSETS names toolset(s) the employee surface does not have: ${unsupported.join(', ')}. ` +
        `With CLOKIO_EMPLOYEE_KEY the choices are: ${EMPLOYEE_TOOLSETS.join(', ')} (clokio_whoami and clokio_list_projects are always on).`
    );
  }
  return new Set(requested as Toolset[]);
}

/** How long the startup /me check may take before the server says so and stops. */
const STARTUP_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();

  const server = new McpServer({
    name: 'clokio-mcp',
    version: VERSION,
  });

  if (config.mode === 'employee') {
    // Fail at startup, not on the first write: a revoked or expired key is
    // 401 here, and the person the key acts as is announced so a session
    // never has to guess whose name its writes will carry.
    const employeeToolsets = selectedEmployeeToolsets();
    let me: { employee_code?: string; name?: string } = {};
    try {
      me = (await request(config, '/me', { timeoutMs: STARTUP_TIMEOUT_MS })) as typeof me;
    } catch (e) {
      // Only a 401/403 means the KEY is bad. A network failure, a timeout, a
      // 5xx during a deploy, a 429 or a server without /me (404) must not send
      // the person to rotate a key that works (review of PR #2).
      const status = e instanceof ClokioApiError ? e.status : 0;
      if (status === 401 || status === 403) {
        throw new Error(
          `CLOKIO_EMPLOYEE_KEY was refused by ${config.baseUrl} (${(e as Error).message}). The key may be revoked or expired - ` +
            'issue a new one at Profile -> API keys.'
        );
      }
      throw new Error(
        `Could not check CLOKIO_EMPLOYEE_KEY with ${config.baseUrl}: ${(e as Error).message}` +
          (status === 404 ? ' (this Clokio server has no /api/employee/me yet: it needs a newer Clokio).' : '') +
          ' The key itself was not refused; try again once Clokio answers.'
      );
    }
    registerEmployeeIdentityTools(server, config);
    if (employeeToolsets.has('tasks')) registerEmployeeModeTools(server, config);
    if (employeeToolsets.has('docs')) registerDocTools(server, config);
    await server.connect(new StdioServerTransport());
    process.stderr.write(
      `clokio-mcp ${VERSION} connected in employee mode, acting as ${me.name ?? '?'} (${me.employee_code ?? '?'}) ` +
        `(base: ${config.baseUrl}, toolsets: ${[...employeeToolsets].join(', ')})\n`
    );
    return;
  }

  const toolsets = selectedToolsets();
  registerProjectTools(server, config);

  if (toolsets.has('tasks')) registerTaskTools(server, config);
  if (toolsets.has('employees')) registerEmployeeTools(server, config, { tickets: toolsets.has('tickets') });
  if (toolsets.has('attendance')) registerAttendanceTools(server, config);
  if (toolsets.has('docs')) registerDocTools(server, config);
  if (toolsets.has('tickets')) registerTicketTools(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr is safe for logs on stdio transport (stdout carries the protocol).
  const active = ['projects', ...OPTIONAL_TOOLSETS.filter((t) => toolsets.has(t))].join(', ');
  process.stderr.write(`clokio-mcp ${VERSION} connected (base: ${config.baseUrl}, toolsets: ${active})\n`);
}

main().catch((e) => {
  process.stderr.write(`clokio-mcp failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});
