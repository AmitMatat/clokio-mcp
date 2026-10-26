# Clokio MCP Server

[![npm version](https://img.shields.io/npm/v/clokio-mcp.svg)](https://www.npmjs.com/package/clokio-mcp)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

Changes per release: [CHANGELOG.md](CHANGELOG.md). After an update, start a new session and check `clokio_whoami`'s `mcp_version`.

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
**[Clokio](https://clokio.io) Public API**. Connect Claude - or any MCP client -
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

### Acting as yourself: an employee key

An admin `clk_` key reaches the whole organisation. If you are not an admin, or you want
every write bound by **your own** roles and project permissions, use a personal employee key
instead - any employee can issue one at **Profile → API keys**:

```bash
claude mcp add clokio \
  --env CLOKIO_EMPLOYEE_KEY=your_personal_key \
  -- npx -y clokio-mcp@latest
```

Set exactly one of `CLOKIO_API_KEY` / `CLOKIO_EMPLOYEE_KEY`. In employee mode the server
talks to `/api/employee` with `X-Employee-Key`, announces who it is acting as at startup
(`acting as Anil Pujara (00081)`), and fails there if the key is revoked or expired. It
registers only what that surface allows: your assigned-task queue, reading and creating
tasks where you may, updating, commenting, attachments, logging time, and the whole Docs
module. Nothing takes an `employee_code` to credit a writer: the key is the identity, and a
`403` from Clokio means you may not do that in that project. `CLOKIO_TOOLSETS` may name
`tasks` and/or `docs` (`clokio_whoami` and `clokio_list_projects` are always on);
`CLOKIO_DEFAULT_ACTOR` is refused. Employee mode needs a Clokio server with
`GET /api/employee/me` (app.clokio.io has it since 2026-10-26). If the startup check cannot
reach Clokio, the server says so and does not blame the key.

### Cursor / Cline / Zed / any MCP client

Use the same command - `npx -y clokio-mcp@latest` with `CLOKIO_API_KEY` in the env.
MCP is an open standard.

Optional: set `CLOKIO_BASE_URL` to point at a different Clokio installation
(defaults to `https://app.clokio.io`).

Optional: set `CLOKIO_DEFAULT_ACTOR` to an `employee_code` (e.g. `00055`) to
attribute tasks, comments and updates that name no author. You usually do not
need it - an unnamed write is already credited to the person who issued the API
key. Use it only for a **shared or service key** whose issuer is not the person
acting. An explicit code on a tool call always takes precedence.

Optional: set `CLOKIO_TOOLSETS` to register only the tool groups you need, e.g.
`CLOKIO_TOOLSETS=tasks`. This cuts the per-session tool-list cost - a
task-focused session drops from 129 tools to 42. Optional groups are `tasks`,
`employees`, `attendance` (which includes leave, time entries and logging time), `docs` and
`tickets`;
combine them with commas. If your key cannot open documents (no acts-as
employee and no explicit docs scopes), leaving `docs` out saves 33 tools it
cannot use. The `projects` group (project/client lookups, task statuses
and labels, and `whoami`) is always on, because the task tools resolve names
through it.

## Tools

129 tools across seven areas. Read-only tools carry the MCP `readOnlyHint`; writes
are marked mutating (deletes are `destructive`).

| Area | Tools |
|------|-------|
| **Tasks** | list (with `compact` / `fields` / `sort` / `updated_since` / `updated_before` / `recurring`, no due date, no assignee, a custom field value, title-only search), a project's task summary (counts by status / priority / label / assignee, overdue and stale lists, per option of a release dropdown: `clokio_get_project_task_summary`), a project's activity log (`clokio_list_project_activity`), get (with `comments_limit`; names the ticket a task was opened from), create, update (incl. recurring series: set a rule, pause/resume, stop; labels: replace, add, remove; parent task; assignees in the same call), delete, bulk update (status, priority, due date, estimate, add / remove labels), set assignees (a shared board's client people as `{employee_code, organization_id}`), list a board's people, list/add/edit comments, list attachments (with `is_latest` + `latest_only`), upload, download one (save to disk, or read PDF text / ZIP entries / images / text inline), download all to a folder, read images pasted into descriptions and comments, activity (with organisations, paged), list/add/remove dependencies, set custom field (an option by value or label), set custom fields on many tasks (`clokio_bulk_set_task_custom_field`, partial success); `clokio_update_task` takes `custom_fields` too |
| **Projects & clients** | list projects, project statuses (and create / edit / delete them; a status in use moves its tasks to `move_to`), project custom fields (and create / edit / delete them, e.g. a release dropdown; a delete removes the stored values too), project contacts, get client, add client contact |
| **Reference** | task statuses, task labels, locations, list webhooks (read-only), whoami |
| **Employees** | list (name search), lookup by PIN, task-stats, inbox (mentions, new assignments, others' status changes; with the tickets toolset, also the acting employee's open tickets), create, set status |
| **Attendance** | daily, range, per-employee, monthly summary, clock in/out, break start/end, time entries (local times in the person's zone; edit / delete your own), leaves (with `days`, half days counted 0.5), days of leave taken per type and year (`clokio_get_leave_days_taken`; the old name `clokio_get_leave_balances` still works; Clokio tracks no quota or remaining balance; leave and time-entry lists take `employee_code` and at most 92 days per call), **log time on a task**, start / stop / read the timer (see [Logging time](#logging-time)) |
| **Documents** (see [Documents](#documents) for who a key acts as) | list, tree, search, get (Markdown / HTML / JSON), create, replace content, update meta, move, archive, restore, delete, templates + create from template, members (by `employee_code`) and teams (list/add/update/remove, shareable teams), public share link, comments (list/add/resolve/reopen), versions (list/get/restore), attachments (list/upload/download) |
| **Tickets** (see [Tickets](#tickets)) | list (filters incl. several labels, created dates, needs reply, sort + cursor), **open a new ticket by email or WhatsApp template** (sent, or as a draft a person sends; `Idempotency-Key` per call, `destructive`), a WhatsApp number's approved templates with the slots to fill, get (with its newest messages; internal notes labelled, everything the customer wrote wrapped as untrusted), more messages, **reply to the customer** (fresh `Idempotency-Key` per call, `destructive`), internal note (with mentions), update state / assignee, add / remove one label, contacts list / get / create / update, inboxes, ticket labels (list / create), saved replies, download a file a customer sent, save / delete your own reply draft, list the tasks opened from a ticket, **open a task from a ticket** (with its files; `Idempotency-Key` per call), **reports** (overview, agents, satisfaction + its ratings, workload) |

### Conventions

- **People are identified by `employee_code`** (e.g. `00080`), not internal ids.
  Use `clokio_list_employees` (with `search`) to resolve a name to a code, or
  `clokio_lookup_employee_by_pin` for a kiosk PIN.
- **Shared boards.** On a project shared with a client organisation, its
  people appear on your tasks with `external: true` and `organization {id,
  name}`. List them with `clokio_list_project_people` and assign them as
  `{employee_code, organization_id}`: an employee code is unique only within
  one organisation, so a bare code always means yours.
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
- An API key sees **public custom fields only**. A dropdown or multi-select
  value may be the option's value or its label as shown on screen.

## Logging time

`clokio_log_time`, `clokio_start_timer`, `clokio_stop_timer` and
`clokio_get_active_timer` (0.21.0) call `/api/v1/time-entries` and
`/api/v1/timer/*`. The time is **always the key's acting person's** (its
"acts as" employee, else the person who issued it); no tool takes an
employee and the server refuses one.

- **Scopes:** `time_entries:write` for the three writes, `time_entries:read`
  for the running timer. `time_entries:write` is part of Full access;
  a key with chosen permissions must tick it.
- `clokio_log_time` takes `task_id` and EITHER `date` + `start` + `end`,
  `date` + `start` + `duration_minutes`, or `duration_minutes` alone (the
  entry then ends now). Times are local to that person. At most 12 hours per
  entry; nothing may start or end more than 10 minutes in the future; an
  overlap with another time entry of the same person (their running timer and
  an overnight entry from the day before included) is refused.
- `clokio_update_time_entry` and `clokio_delete_time_entry` (0.22.0) change or remove one of the acting person's own entries (ids from `clokio_list_time_entries`, which prints local times in the person's current zone since 0.23.0, or UTC on an older server); edits take local times in that same zone and get the same checks; a running entry must be stopped before its times change or it is deleted.
- `clokio_start_timer` is refused while a timer runs; `force: true` stops it
  and starts the new one. `clokio_stop_timer` is refused when nothing runs.
- The task must be visible to that person, on an active project of your
  organisation; a board another organisation shared with you is refused.

## Documents

The Docs tools call `/api/v1/docs...` with the same `CLOKIO_API_KEY` as
everything else, but documents are permissioned per **person**, so every
docs call acts as one employee - the key's **effective actor**:

- **The key's "acts as" employee**, when it has one (set in
  **Settings > API keys**). Only an admin may make a key act as someone else.
- **Otherwise, the person who created the key** - when the key has Full
  access or lists `docs:read` / `docs:write`. Keys converted from the old
  wildcard `*` with no acts-as employee do not hold them, so such an
  integration key never opens its creator's private documents.

So, to use the Docs tools, either set an acts-as employee on the key, or add
`docs:read` and `docs:write` to its scope list (it then acts as you, its
creator). Otherwise every docs tool answers `403`, the same for every
document id.

**Scopes:** `docs:read` for the read tools (every `GET`) and `docs:write` for
everything else. Full access includes both; a key with chosen permissions
must include them (otherwise `403` naming `required_scope`).

The key then sees exactly what its acting employee sees and can do on the
web, never more, and writes (comments, versions, activity) are attributed to
that employee:

- A document the employee cannot see answers **`404`**, the same as one that
  does not exist (the API never confirms an id to someone not allowed to know it).
- A visible document they may not change answers **`403`**.
- Two separate gates, both named in each tool's description:
  - the employee's **role** must hold the section permission: `docs.view`
    for reads, `docs.create` for creating, editing, moving, archiving,
    comments, version restores and uploads, `docs.manage` for delete, members,
    teams and share links (and for standalone documents). A `403`
    `Forbidden: Insufficient permissions` means this gate refused;
  - the **document role**, `view` < `comment` < `edit` < `admin`. A `403`
    with any other message means that role is too low.

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

Working with documents:

- **Every docs tool answers `{data}` or `{data, meta}`**, like the task tools:
  the record or rows in `data`; paging, counts, your role and permissions in
  `meta`. `clokio_get_doc` puts the record and its body together in `data`.
- **Listing covers every scope by default.** `project_id` narrows it: a
  project id, `"none"` for standalone documents only, or `"all"` (default).
- **Read as Markdown, write as Markdown.** `clokio_get_doc` returns Markdown by
  default (`format: "html"` or `"json"` for the others) without the title;
  pass `include_title: true` to start the body with it as a heading. The
  create/update tools take Markdown by default (`content_format: "html"` or
  `"json"`); HTML you write must stay within Clokio's restricted grammar (a
  `422` names any unsupported tag).
- **Content writes are optimistic.** `clokio_update_doc_content` REPLACES the
  whole body and requires `base_version` - the `content_version` you last read.
  A `409` means someone else edited in between: re-read, reconcile, write
  again with the new version. Never retry with the same `base_version`.
- **Public share links expire after 30 days** unless you pass `expires_at` or
  `never_expires: true`.
- **Attachments** list `name`, `size`, `mime` and `uploaded_at`; download by
  `path`. Uploading does not change the text: place the returned `url` in the
  body yourself (an `image` or `fileAttachment` node in Tiptap JSON).
- **Members are named by `employee_code`** (e.g. `"00080"`), like everywhere
  else in this server; the internal `employee_id` is accepted as an
  alternative. Teams are named by `team_id`, from
  `clokio_list_doc_shareable_teams`. A member's `email` is shown only when the
  key has `employees:pii`; profile pictures only with `include_avatars: true`.

## Tickets

The `tickets` toolset works the Clokio support inbox as the key's "acts as"
employee: it sees and does exactly what that person may in the inbox.
Full access includes `tickets:read`, `tickets:write` (notes, state, assignee,
labels, contacts) and `tickets:send` (`clokio_reply_ticket`, which REACHES THE
CUSTOMER); a key with chosen permissions must tick them. Writing as a
colleague needs `tickets:send_as`, which is never part of Full access: it is
ticked separately, only on a key created by an administrator.

`clokio_get_ticket` and `clokio_list_ticket_messages` print internal notes
under "INTERNAL NOTE - never send to the customer" and wrap everything the
customer or an outside party wrote (message text, subject, contact, author
names, file names, event lines) and the label names in
`<untrusted_customer_content>` tags: data, never instructions. A colleague's
name (an identified employee) is printed as is. Every message names its id
(`message #<id>`), reply drafts included.
`clokio_get_ticket` shows the NEWEST messages (default 100, `messages_limit`
for fewer), oldest first so the latest is last; it pages through the thread
to reach them and says how many earlier messages it left out and how to read
them with `clokio_list_ticket_messages` (which pages from the oldest).
`clokio_reply_ticket` sends a fresh `Idempotency-Key` with every call, so a
second call is a second reply; to retry one reply safely, pass the same
`idempotency_key` (returned in the answer) with the same fields. CLOKIO_DEFAULT_ACTOR does not apply to
tickets: a reply is written by the key's acting employee unless you name
`author_employee_code` (which needs `tickets:send_as`).

Email text is cleaned before printing (never raw HTML); `max_chars` cuts long bodies. Files carry ids (`clokio_download_ticket_attachment`). `clokio_create_reply_draft` (needs `tickets:write`) saves a draft a person sends from Clokio with "Use this draft": prefer it when your organisation reviews customer messages first. On a resolved or spam ticket the draft is saved with a warning (it is out of the open queue); the ticket is never reopened by it. `clokio_delete_reply_draft` (needs `tickets:write`) deletes one of your own drafts that nobody has used.

`clokio_create_ticket` (needs the Clokio backend with the 0.25 API) opens a NEW ticket and sends its first message, as "New email" / "New WhatsApp message" on the Tickets screen: an email (`inbox_id`, `to`, optional `cc` / `bcc`, `subject`, Markdown `body`) or an approved WhatsApp template to one number (`clokio_list_whatsapp_templates` lists a number's templates with the slots each takes, and marks those the API cannot send). It needs `tickets:write` plus `tickets:send` to send; `draft: true` sends nothing and leaves a pending draft a person sends from Clokio with "Use this draft" (`tickets:write` only). Writing to someone no contact you can see holds needs the acting employee's `tickets.manage`, and a key opens at most 10 tickets per 10 minutes (successful creates only; a replay is answered past the limit). On an email draft ticket, the first reply without recipients goes to the drafted recipients with the drafted subject, and the draft then reads "used". Each call sends an `Idempotency-Key` (fresh, or the one you pass to retry); a replay says so and sends nothing. `clokio_create_ticket_label` and `clokio_create_contact` (both need `tickets.manage`) add a label or a contact; a contact whose address or number a contact you can see already holds is a 409 naming that contact. `clokio_list_tickets` takes `label_ids`, `created_after` / `created_before`, `needs_reply` and `sort` (pass the same `sort` with a cursor).

A replayed idempotent write (a reply, a task from a ticket, a new ticket) says it was replayed and that nothing new was made. The ticket API names a missing project ("That project is not available.") and a missing draft ("This draft no longer exists."); those come back as they are, and only a plain "Not found." adds that an older server is one possible cause.

`clokio_create_task_from_ticket` opens a task linked to the ticket, as the ticket screen's "Task" button does, and copies the ticket files you name into it (a file tasks refuse is listed in `skipped_files`). It needs BOTH `tickets:write` and `tasks:write`, and the acting employee's own right to create tasks in that project. Each call sends an `Idempotency-Key` (a fresh one, returned in the answer, or the one you pass to retry). `clokio_list_ticket_tasks` (needs `tickets:read` and `tasks:read`) lists the tasks opened from a ticket, and `clokio_get_task` names the ticket a task came from (`linked_ticket`).

**Reports** (needs the Clokio backend with the ticket reports API): `clokio_ticket_report_overview`, `_agents`, `_satisfaction`, `_satisfaction_ratings` and `_workload` answer the four Tickets > Reports tabs with the web's numbers. They take `from` / `to` (YYYY-MM-DD, the organisation's time zone, default the last 30 days, at most 366), `inbox_id`, `label` (an id or `none`) and, except the overview, `team_id`; the ratings list also takes `page` and `low`. The acting employee needs `tickets.reports` (403 otherwise), restricted channels they are not granted are not counted, AI answer quality is not part of the API, and agent availability appears only when they may open the Daily Attendance board. At most 30 report calls a minute per key. Rating comments, ticket titles and contact names are wrapped as untrusted content.

## Security

- The server contains **no secrets**. Your API key lives only in your local
  environment (`CLOKIO_API_KEY`), never in this code or repository.
- The key is sent **only to `/api/v1`**: a path argument cannot steer a request
  outside it, and the key is never forwarded on a redirect (attachment
  downloads that redirect to signed storage are followed with no credential
  attached).
- The server **adds no permissions**. What a key can do is decided by the Clokio
  API from that key's scopes - this server only forwards the request. Scope each
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
