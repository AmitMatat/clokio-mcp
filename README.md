# clokio-mcp

An MCP (Model Context Protocol) server for the **Clokio Public API**. It lets any
MCP client — Claude Code, Claude Desktop, Cursor, etc. — read and manage Clokio
tasks, projects, clients, employees and attendance through AI tools.

Every request is authenticated with **your own** Clokio API key (`clk_...`),
sent as `X-API-Key`. The key carries its own scopes, so this server never
re-implements authorization: a 403 / 422 from the API is surfaced verbatim.

## Setup

```bash
cd clokio-mcp
npm install
npm run build
```

You need a Clokio API key. Create/manage keys in the admin dashboard at
`/admin/api-keys/`. Each person should use their own key so permissions and the
audit trail stay per-user.

## Register with Claude Code

```bash
claude mcp add clokio \
  --env CLOKIO_API_KEY=clk_your_key_here \
  -- node /absolute/path/to/clokio-mcp/dist/index.js
```

Optional: set `CLOKIO_BASE_URL` (defaults to `https://app.clokio.io`).

Once the package is published to npm you can instead use:

```bash
claude mcp add clokio --env CLOKIO_API_KEY=clk_... -- npx -y clokio-mcp
```

## Register with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clokio": {
      "command": "node",
      "args": ["/absolute/path/to/clokio-mcp/dist/index.js"],
      "env": { "CLOKIO_API_KEY": "clk_your_key_here" }
    }
  }
}
```

## Tools

36 tools across five areas. Read-only tools are marked with the MCP
`readOnlyHint`; writes are marked as mutating (delete is `destructive`).

**Tasks** — `clokio_list_tasks`, `clokio_get_task`, `clokio_create_task`,
`clokio_update_task`, `clokio_delete_task`, `clokio_set_task_assignees`,
`clokio_list_task_comments`, `clokio_add_task_comment`, `clokio_get_task_activity`,
`clokio_list_task_dependencies`, `clokio_add_task_dependency`,
`clokio_set_task_custom_field`.

**Projects & clients** — `clokio_list_projects`, `clokio_get_project_statuses`,
`clokio_get_project_custom_fields`, `clokio_get_project_contacts`,
`clokio_get_client`, `clokio_add_client_contact`.

**Reference** — `clokio_list_task_statuses`, `clokio_list_task_labels`,
`clokio_list_locations`.

**Employees** — `clokio_list_employees`, `clokio_lookup_employee`,
`clokio_get_employee_task_stats`, `clokio_create_employee`,
`clokio_set_employee_status`.

**Attendance** — `clokio_attendance_daily`, `clokio_attendance_range`,
`clokio_attendance_for_employee`, `clokio_attendance_summary`,
`clokio_clock_in`, `clokio_clock_out`, `clokio_break_start`, `clokio_break_end`,
`clokio_list_time_entries`, `clokio_get_balances`.

## Conventions (from the Clokio API)

- **People are identified by `employee_code`** (e.g. `00080`), not internal ids.
  Use `clokio_lookup_employee` to resolve a name to a code.
- **Attribute writes to a person**: pass `creator_employee_code` on
  `clokio_create_task` and `author_employee_code` on `clokio_add_task_comment`,
  or the entry shows as the API key owner ("External System").
- **Status slugs** come from `clokio_list_task_statuses` /
  `clokio_get_project_statuses`.
- An API key sees **public custom fields only**.

## Notes

- The tool surface tracks the Clokio Public API v1. When the API adds a route,
  add a matching tool here (the API's own OpenAPI spec at
  `/api/v1/openapi.json` is the source of truth for shapes).
- This is a thin, stateless client: no caching, no local auth logic. All
  authorization lives in the API key and the server.
