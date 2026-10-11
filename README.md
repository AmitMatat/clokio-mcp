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
`CLOKIO_TOOLSETS=tasks`. This cuts the per-session tool-list cost - a
task-focused session drops from 83 tools to 31. Optional groups are `tasks`,
`employees`, `attendance` (which includes leave and time entries) and `docs`;
combine them with commas. If your key cannot open documents (no acts-as
employee and no explicit docs scopes), leaving `docs` out saves 33 tools it
cannot use. The `projects` group (project/client lookups, task statuses
and labels, and `whoami`) is always on, because the task tools resolve names
through it.

## Tools

83 tools across six areas. Read-only tools carry the MCP `readOnlyHint`; writes
are marked mutating (deletes are `destructive`).

| Area | Tools |
|------|-------|
| **Tasks** | list (with `compact` / `sort` / `updated_since` / `recurring`), get (with `comments_limit`), create, update (incl. recurring series: set a rule, pause/resume, stop), delete, bulk update, set assignees, list/add/edit comments, list attachments (with `is_latest` + `latest_only`), upload, download one (save to disk, or read PDF text / ZIP entries / images / text inline), download all to a folder, activity, list/add/remove dependencies, set custom field |
| **Projects & clients** | list projects, project statuses, project custom fields, project contacts, get client, add client contact |
| **Reference** | task statuses, task labels, locations, list webhooks (read-only), whoami |
| **Employees** | list (name search), lookup by PIN, task-stats, inbox (mentions, new assignments, others' status changes), create, set status |
| **Attendance** | daily, range, per-employee, monthly summary, clock in/out, break start/end, time entries, leaves, leave balances |
| **Documents** (see [Documents](#documents) for who a key acts as) | list, tree, search, get (Markdown / HTML / JSON), create, replace content, update meta, move, archive, restore, delete, templates + create from template, members (by `employee_code`) and teams (list/add/update/remove, shareable teams), public share link, comments (list/add/resolve/reopen), versions (list/get/restore), attachments (list/upload/download) |

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
- **Recurring tasks are templates.** Pass `recurrence` on create/update
  (`{frequency, every?, days_of_week?, day_of_month?, anchor?}`) and the task
  becomes the series template; **moving it to a done status starts the
  schedule**. A fresh copy (same content, assignees, labels, estimate) is
  created early on each matching day, due that day, independent of earlier
  copies. Pause/resume with `recurrence_active`, stop with `recurrence: null`;
  `recurrence.armed` on a task says whether the series is live, a copy names
  its template as `recurrence.spawned_from`, and `series_of` on the list tool
  returns every occurrence of one series.
- An API key sees **public custom fields only**.

## Documents

The Docs tools call `/api/v1/docs...` with the same `CLOKIO_API_KEY` as
everything else, but documents are permissioned per **person**, so every
docs call acts as one employee - the key's **effective actor**:

- **The key's "acts as" employee**, when it has one (set in
  **Settings > API keys**). Only an admin may make a key act as someone else.
- **Otherwise, the person who created the key** - but only when the key lists
  `docs:read` / `docs:write` **explicitly**. The wildcard `*` does not grant
  docs scopes to a key with no acts-as employee, so an ordinary full-access
  integration key never opens its creator's private documents.

So, to use the Docs tools, either set an acts-as employee on the key, or add
`docs:read` and `docs:write` to its scope list (it then acts as you, its
creator). Otherwise every docs tool answers `403`, the same for every
document id.

**Scopes:** `docs:read` for the read tools (every `GET`) and `docs:write` for
everything else. On a key with an acts-as employee the wildcard `*` grants
both; a key with an explicit scope list must include them (otherwise `403`
naming `required_scope`).

The key then sees exactly what its acting employee sees and can do on the
web, never more, and writes (comments, versions, activity) are attributed to
that employee:

- A document the employee cannot see answers **`404`**, the same as one that
  does not exist (the API never confirms an id to someone not allowed to know it).
- A visible document they may not change answers **`403`**.
- The employee's role gates each call: `docs.view` for reads, `docs.create`
  for content writes, `docs.manage` for delete and sharing. Per document,
  roles are `view` < `comment` < `edit` < `admin`; each tool's description
  names what it needs.

| Tool | Endpoint |
|------|----------|
| `clokio_list_docs` | `GET /docs` |
| `clokio_get_doc_tree` | `GET /docs?tree=1` |
| `clokio_search_docs` | `GET /docs/search` |
| `clokio_get_doc` | `GET /docs/{id}` |
| `clokio_create_doc` | `POST /docs` |
| `clokio_update_doc_content` | `PUT /docs/{id}/content` |
| `clokio_update_doc_meta` | `PATCH /docs/{id}` |
| `clokio_move_doc` | `POST /docs/{id}/move` |
| `clokio_archive_doc` / `clokio_restore_doc` | `POST /docs/{id}/archive` / `restore` |
| `clokio_delete_doc` | `DELETE /docs/{id}` |
| `clokio_list_doc_templates` / `clokio_create_doc_from_template` | `GET /docs/templates` / `POST /docs/from-template` |
| `clokio_list_doc_members` | `GET /docs/{id}/members` (members, teams, inherited, share link) |
| `clokio_list_doc_shareable_teams` | `GET /docs/{id}/shareable-teams` |
| `clokio_add_doc_member` / `clokio_update_doc_member` / `clokio_remove_doc_member` | `POST` / `PATCH` / `DELETE /docs/{id}/members` (by `employee_code`), or `PATCH` / `DELETE .../members/{employeeId}` |
| `clokio_add_doc_team` / `clokio_update_doc_team` / `clokio_remove_doc_team` | `POST /docs/{id}/teams`, `PATCH` / `DELETE .../teams/{teamId}` |
| `clokio_create_doc_share_link` / `clokio_revoke_doc_share_link` | `POST` / `DELETE /docs/{id}/share-link` |
| `clokio_list_doc_comments` / `clokio_add_doc_comment` | `GET` / `POST /docs/{id}/comments` |
| `clokio_resolve_doc_comment` / `clokio_reopen_doc_comment` | `POST .../comments/{commentId}/resolve` / `reopen` |
| `clokio_list_doc_versions` / `clokio_get_doc_version` / `clokio_restore_doc_version` | `GET .../versions`, `GET .../versions/{versionId}`, `POST .../versions/{versionId}/restore` |
| `clokio_list_doc_attachments` / `clokio_upload_doc_attachment` / `clokio_download_doc_attachment` | `GET` / `POST /docs/{id}/attachments`, `GET .../attachments/download?path=` |

Working with content:

- **Read as Markdown, write as Markdown.** `clokio_get_doc` returns Markdown by
  default (`format: "html"` or `"json"` for the others), and the create/update
  tools take Markdown by default (`content_format: "html"` or `"json"`). HTML
  read back is not writable as-is; HTML you write must stay inside a strict
  12-tag grammar (no headings, no attributes except `img[src]` and `a[href]`).
- **Content writes are optimistic.** `clokio_update_doc_content` REPLACES the
  whole body and requires `base_version` - the `content_version` you last read.
  A `409` means someone else edited in between: re-read, reconcile, write
  again with the new version. Never retry with the same `base_version`.
- **Uploading does not change the text.** `clokio_upload_doc_attachment`
  returns a `url`; place it in the body yourself (an `image` or
  `fileAttachment` node in Tiptap JSON).
- **Members are named by `employee_code`** (e.g. `"00080"`), like everywhere
  else in this server; the internal `employee_id` is accepted as an
  alternative. Teams are named by `team_id`, from
  `clokio_list_doc_shareable_teams`. A member's `email` is shown only when the
  key has `employees:pii`.

## Security

- The server contains **no secrets**. Your API key lives only in your local
  environment (`CLOKIO_API_KEY`), never in this code or repository.
- The key is sent **only to `/api/v1`**: a path argument cannot steer a request
  outside it, and the key is never forwarded on a redirect (attachment
  downloads that redirect to signed storage are followed with no credential
  attached).
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
