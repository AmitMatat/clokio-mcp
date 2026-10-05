# Clokio MCP Server

[![npm version](https://img.shields.io/npm/v/clokio-mcp.svg)](https://www.npmjs.com/package/clokio-mcp)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
**[Clokio](https://clokio.io) Public API**. Connect Claude — or any MCP client —
to your Clokio workspace to read and manage tasks, projects, clients, employees
and attendance in natural language.

Every request is authenticated with **your own** Clokio API key (`clk_...`),
sent in the **`X-API-Key`** header. The key carries its own scopes, so this
server never re-implements authorization: it is a thin, stateless client, and a
`403` / `422` from the API is surfaced verbatim.

> **Auth header:** the Clokio Public API accepts the key only in `X-API-Key`.
> An `Authorization: Bearer <key>` header is **not** recognised and returns
> `401`. If you call the API directly (not through this server), use `X-API-Key`.

## Install

You need a Clokio API key. Create and scope keys in the admin dashboard at
**Settings → API Keys** (`/admin/api-keys/`). Each person uses their own key, so
permissions and the audit trail stay per-user.

### Claude Code

```bash
claude mcp add clokio \
  --env CLOKIO_API_KEY=clk_your_key_here \
  -- npx -y clokio-mcp@latest
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clokio": {
      "command": "npx",
      "args": ["-y", "clokio-mcp@latest"],
      "env": { "CLOKIO_API_KEY": "clk_your_key_here" }
    }
  }
}
```

### Cursor / Cline / Zed / any MCP client

Use the same command — `npx -y clokio-mcp@latest` with `CLOKIO_API_KEY` in the env.
MCP is an open standard.

Optional: set `CLOKIO_BASE_URL` to point at a different Clokio installation
(defaults to `https://app.clokio.io`).

Optional: set `CLOKIO_DEFAULT_ACTOR` to an `employee_code` (e.g. `00055`) to
attribute tasks, comments and updates that name no author. You usually do not
need it — an unnamed write is already credited to the person who issued the API
key. Use it only for a **shared or service key** whose issuer is not the person
acting. An explicit code on a tool call always takes precedence.

Optional: set `CLOKIO_TOOLSETS` to register only the tool groups you need, e.g.
`CLOKIO_TOOLSETS=tasks`. This cuts the per-session tool-list cost — a
task-focused session drops from 50 tools to 31. Optional groups are `tasks`,
`employees` and `attendance` (which includes leave and time entries); combine
them with commas. The `projects` group (project/client lookups, task statuses
and labels, and `whoami`) is always on, because the task tools resolve names
through it.

## Tools

50 tools across five areas. Read-only tools carry the MCP `readOnlyHint`; writes
are marked mutating (deletes are `destructive`).

| Area | Tools |
|------|-------|
| **Tasks** | list (with `compact` / `sort` / `updated_since`), get (with `comments_limit`), create, update, delete, bulk update, set assignees, list/add/edit comments, list attachments (with `is_latest` + `latest_only`), upload, download one (save to disk, or read PDF text / ZIP entries / images / text inline), download all to a folder, activity, list/add/remove dependencies, set custom field |
| **Projects & clients** | list projects, project statuses, project custom fields, project contacts, get client, add client contact |
| **Reference** | task statuses, task labels, locations, list webhooks (read-only), whoami |
| **Employees** | list (name search), lookup by PIN, task-stats, inbox (mentions, new assignments, others' status changes), create, set status |
| **Attendance** | daily, range, per-employee, monthly summary, clock in/out, break start/end, time entries, leaves, leave balances |

### Conventions

- **People are identified by `employee_code`** (e.g. `00080`), not internal ids.
  Use `clokio_list_employees` (with `search`) to resolve a name to a code, or
  `clokio_lookup_employee_by_pin` for a kiosk PIN.
- **Attribution is automatic.** An unnamed write is credited to the key's
  issuer (see `clokio_whoami`), so you rarely set an author. Pass
  `created_by_employee_code` / `author_employee_code` only to credit someone
  else, or set `CLOKIO_DEFAULT_ACTOR` for a shared key.
- **Write Markdown.** Descriptions and comment bodies accept Markdown (paragraphs, lists,
  `**bold**`, `` `code` ``, links, headings, fenced code); the server converts it to the HTML
  Clokio stores. Text that already starts with an HTML tag is passed through untouched.
- **Status slugs** come from `clokio_list_task_statuses` /
  `clokio_get_project_statuses`.
- An API key sees **public custom fields only**.

## Security

- The server contains **no secrets**. Your API key lives only in your local
  environment (`CLOKIO_API_KEY`), never in this code or repository.
- The server **adds no permissions**. What a key can do is decided by the Clokio
  API from that key's scopes — this server only forwards the request. Scope each
  key to what its holder needs.
- All authorization, tenancy (`organization_id` scoping) and rate limiting are
  enforced server-side by the Clokio API, exactly as for any other API consumer.

## Local development

```bash
git clone https://github.com/AmitMatat/clokio-mcp.git
cd clokio-mcp
npm install     # includes devDependencies (typescript)
npm run build   # rebuilds dist/
```

The prebuilt `dist/` is committed so `npx` can run the server with no build step
(this also keeps it working when `NODE_ENV=production`, where npm skips
devDependencies). Rebuild and commit `dist/` alongside any source change.

The tool surface tracks the Clokio Public API v1; its OpenAPI spec is served
(unauthenticated) at `/api/v1/openapi.json` and is the source of truth for
request shapes.

## License

MIT © Matat Technologies LTD
