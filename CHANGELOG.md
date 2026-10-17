# Changelog

## Unreleased

Needs the Clokio backend released on 2026-10-17 (main c0da1a3fc) or later.

- **`clokio_get_leave_balances`** - the description now says plainly that Clokio does not track leave balances: the answer is always an empty list, not "zero days left". Count taken days with `clokio_list_leaves` (status APPROVED, sum `number_of_days`).
- **`clokio_list_leaves`** - `status` also accepts `REVOKED` (approved, then withdrawn by an approver) and `CANCELLED` (withdrawn by the employee before a decision).

## 0.22.0 (unreleased)

From the QA review of 0.21.0 and two field reports. Needs the Clokio backend of 2026-10-16 or later (the new routes answer 404 on an older server), so publish only after that backend is deployed. After updating, start a NEW session and check that `clokio_whoami` reports `mcp_version` 0.22.0: a running session keeps the build it started with.

- **New: `clokio_update_time_entry`** - correct your own time entry (task, date, start/end or duration, description) with the same checks as logging time: nothing in the future, no overlap (including your running timer), at most 12 hours. A running entry takes only task and description. Moving the start keeps the length: sending only `start` shifts the entry, and `duration_minutes` alone keeps the start and sets the length. (#1)
- **New: `clokio_delete_time_entry`** - delete your own time entry; a running timer must be stopped first. (#1)
- **`clokio_list_time_entries`** - one line per entry with its `id` and RUNNING for a timer still running (times in UTC). (#2)
- **`clokio_stop_timer`** - warns when the stopped entry lasted under a minute and names the delete tool, in a `warning` field on the answer. Short entries are still saved, as on the web and mobile (product decision). (#3)
- **`clokio_get_task_activity`** - shows each person's organisation and whether they are external, like `clokio_get_task`; departed employees and coding agents are now named instead of blank. Adds `from`, `to`, `per_page`, `page`. (#4)
- **`clokio_set_task_assignees`** - returns only the task id, link and assignees instead of the whole task (see Output format changes). (#5)
- **`clokio_get_ticket` / `clokio_list_ticket_messages`** - email text is cleaned (no layout blank lines or table residue, never raw HTML), with an optional `max_chars` per message. (#6)
- **New: `clokio_download_ticket_attachment`**, and attachment ids on every ticket message - read screenshots and documents customers send (image inline, PDF text, or save to disk). (#7)
- **New: `clokio_create_reply_draft`** - save a reply as a draft for a person to review and send from Clokio ("Use this draft"); nothing reaches the customer. See Known gaps for when a draft counts as used. (#8)
- **`clokio_list_saved_replies`** - one format by default (`format: text|html`), `include_template`, and a `q` filter. (#11)
- **New: `clokio_download_task_media`**, and **`clokio_list_task_attachments` now answers `{attachments, inline_media}`** (a shape change: it used to answer the attachments alone). The images and videos pasted into a task's description or comments (customers' bug screenshots) are listed and readable; before, `/tasks/media/...` sent a key to the login page. Only media the task's description or a public comment contains is served. (field report F1)
- **Assignees** - a client's person written as one string like `"313:00002"` is refused with the exact object to send (`{"employee_code": "00002", "organization_id": 313}`). The object form itself has worked since 0.20.0; if it seemed missing, the session was running an older cached build (see `mcp_version` above). (field report F2)
- **API keys** - the wording now says a key has Full access or chosen permissions.
- **Ticket attachments are untrusted content** - `clokio_download_ticket_attachment` returns a text file, a PDF's extracted text and a ZIP's entry names inside `<untrusted_customer_content>` with the closing tag defused, like every other customer string in the thread. Images stay images; task and doc attachments are returned as before.

### Output format changes

Callers that parse these tools' output must adjust:

- **`clokio_get_task_activity`** now returns text, one line per activity plus a page line, not JSON. A value's newlines and runs of whitespace collapse to one space, so every activity stays on its own line.
- **`clokio_list_saved_replies`** now returns text lines, not JSON.
- **`clokio_list_time_entries`** prints one line per entry (`#id date in-out UTC hours | employee_code | task | description`), not JSON. Dropped from the output: project, client, tags, billable and the employee's name. Narrow by project with the `project_id` filter, and read a task's project with `clokio_get_task`; client, tags and billable are no longer shown by any list tool (the API still has them, and the object answers of `clokio_log_time`, `clokio_start_timer` and `clokio_stop_timer` still carry them for that one entry).
- **`clokio_set_task_assignees`** answers a compact object (task id, link, assignees), not the whole task.
- **`clokio_list_task_attachments`** answers `{attachments, inline_media}` instead of the attachments array. If the task or its comments cannot be read, `attachments` still comes back, with `inline_media: []` and an `inline_media_note` saying so; a failed attachments read still fails the tool.
- **`clokio_stop_timer`** always answers the API's object, like the other timer tools, with a `warning` field added when the entry lasted under a minute (it never answers a text string).

### Known gaps

- **Drafts (`clokio_create_reply_draft`):** a draft is marked used when the reply is written, not when it is delivered, and only when it is sent from the web composer. The mobile app shows drafts as plain internal notes.

### Not in this release, and why

- **Files on `clokio_reply_ticket` (#7, second half):** the inbox's file rules (one file vs WhatsApp's five, captions, size checks) still live inside the web reply controller; accepting files over the API now would make a second copy of them. They move into one shared class first; planned for 0.23. Meanwhile, draft the text with `clokio_create_reply_draft` and let the person attach the file.
- **Ticket-task links (#9):** the web flow is session-bound and the API creates tasks differently on purpose; it needs its own small design. Planned for 0.23.
- **Starting a new outbound ticket (#10):** email and WhatsApp compose (mailboxes, signatures, templates, contact matching) is a large surface of its own.
- **The smaller ticket gaps (#12):** priority, snooze, subject, creating labels and contacts, more list filters and tickets in `clokio_get_inbox` are all server changes; they go to a later tickets API phase.
- **Discarding sub-minute timer entries server-side (#3):** the web and the mobile app keep short entries too; changing that is a product decision across all three. 0.22.0 adds the warning and the delete tool instead.
