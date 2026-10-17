# Changelog

## 0.23.0 (unreleased)

From the QA review of 0.22.0 (Clokio task #5808). This part needs no new backend: it runs on the server 0.22.1 needs. After updating, start a NEW session and check that `clokio_whoami` reports the new `mcp_version`.

- **Message ids** - `clokio_get_ticket` and `clokio_list_ticket_messages` print `message #<id>` on every message, `REPLY DRAFT (pending)` lines included, so a draft or a message can be named. (#2b)
- **`clokio_create_reply_draft` on a resolved or spam ticket** - the tool reads the ticket's state first. On a resolved or spam ticket the draft is still saved, and the answer adds a warning: the draft will not appear in the open queue, and `clokio_update_ticket state=open` reopens the ticket if a person should pick it up. The ticket is never reopened automatically (owner decision D2). If the state cannot be read, the draft is saved without the warning. The answer now writes the draft as `message #<id>`. (#2c)
- **A colleague's name is no longer wrapped as untrusted** - in ticket threads an identified employee (author type employee with an employee_code) is printed as `Dana (00031)`; contacts, bots, the WhatsApp Business app and unknown authors stay inside `<untrusted_customer_content>`. A wrapper tag inside a colleague's name is still defused. (#3)
- **`clokio_get_inbox` shows tickets** - with the tickets toolset loaded, and when `employee_code` is the key's acting employee (`acting_as` from `/me`, else `issued_by`), the answer gains a `tickets` part: the open tickets assigned to that person (`GET /tickets?assignee=me&state=open`, one wrapped line each, first 50, the next cursor named) and which of them wait for our reply (`waiting_for_reply`, from `waiting_since`). For any other employee `tickets` only says why none are shown (ticket visibility is the acting employee's), and a failed tickets read is reported there without failing the task inbox. Without the tickets toolset nothing changes and no extra call is made. A "waiting for me" filter on the server (#9c) would make this exact; until then it lists what is assigned and open. (#9e)
- **`employee_code` on the leave and time-entry tools** - `clokio_list_leaves`, `clokio_get_leave_balances` and `clokio_list_time_entries` take `employee_code`, like every other tool, and still accept `employee` (the old name) as an alias. Both with different values is refused before any request. The descriptions now name the real parameters; the API query parameter is unchanged. (L2)
- **The 92-day limit** - `clokio_list_leaves` and `clokio_list_time_entries` say that `to - from` may be at most 92 days, and refuse a longer range before the request with the server's sentence ("Date range cannot exceed 92 days.") and a hint to split it. The tool does not split the range itself: leave rows carry no id, so a leave that crosses two windows could not be told apart. (L3)
- **Half-day leaves, interim wording** - `clokio_get_leave_balances` no longer tells agents to sum `number_of_days`. Both leave descriptions say that `number_of_days` counts dates, so a half-day leave counts as a whole day until the server reports `days`, and to prefer `days` when a row has it. (L1, L4)

### Already in 0.22.0, please re-test

- **#6** saved replies in one format, **#7** the compact `clokio_set_task_assignees` answer, **#8** the short-entry warning on `clokio_stop_timer`: all three were in the published 0.22.0 (and 0.22.1).

### Not in this release, and why

- **Starting a new outbound ticket (#5):** planned for 0.24, email only, through the web's own compose service and a required Idempotency-Key; no draft option for a new ticket (owner decision D7).
- **Ticket priority, snooze and subject edit (#9a):** none is an API gap; each is a missing product feature. Nothing writes or shows priority today (it would be a new feature on web, mobile and API first), snooze stays refused until a wake path exists, and the subject is read from the emails, so editing it is not recommended (owner decision D7).
- **Creating ticket labels and filtering by several labels (#9b):** server changes; the label rules live in the web controller and move into one shared class first. Not in the owner decisions for 0.23 (D7 does not list it), so it waits for the tickets API phase after the backend round.
- **Needs-reply and created-date filters and sort on `clokio_list_tickets` (#9c):** server changes (the "waiting on this person" rule must be shared with the sidebar badge first); sort needs a new cursor. Not in the owner decisions for 0.23 (D7 does not list it). `clokio_get_inbox` already shows `waiting_since` meanwhile.
- **Creating a contact (#9d):** no product path creates a contact today (contacts are born from inbound messages); deferred until outbound compose (#5) needs it (owner decision D7).
- **Waiting for the backend (second round of 0.23.0):** deleting your own pending reply draft, the ticket-task link tools and `ticket` on `clokio_get_task`, local times on time entries, and days taken in `clokio_get_leave_balances`. Their server shapes do not exist yet, so nothing is stubbed.

## 0.22.1

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
