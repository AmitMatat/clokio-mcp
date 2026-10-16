// Conformance test: every tool must call a path the API actually serves, with
// query parameters the API actually accepts.
//
// This exists because the first release shipped tools that could NEVER have
// worked, and nothing caught it:
//
//   - clokio_lookup_employee sent {name, email} to POST /employees/lookup,
//     which accepts only {pin}. Every call 422'd.
//   - clokio_get_balances called GET /balances. The route is /leaves/balances.
//   - clokio_list_time_entries sent start_date/end_date; the API wants
//     from/to, and REQUIRES them.
//   - clokio_list_tasks sent `assignee`; the parameter is
//     `assignee_employee_code`, and GET /tasks 422s on an unknown parameter.
//
// Every one of those was a description or a parameter name invented from
// plausibility rather than read from the contract. The OpenAPI spec is
// machine-readable and authoritative, so that guesswork is now a test failure
// instead of an integrator's afternoon.
//
// The spec is fetched from a live installation (CLOKIO_BASE_URL, default
// https://app.clokio.io) - it is served unauthenticated for exactly this kind
// of use. Run by hand:  node test/api-conformance.mjs

import { readFile } from 'node:fs/promises';

// Normally the LIVE spec, which is what integrators actually read. Point
// CLOKIO_SPEC_FILE at a local docs/api/openapi.json to check a tool change
// against a spec change before either is deployed.
const SPEC_FILE = process.env.CLOKIO_SPEC_FILE;
const BASE = (process.env.CLOKIO_BASE_URL || 'https://app.clokio.io').replace(/\/+$/, '');
const SPEC_URL = `${BASE}/api/v1/openapi.json`;

// Tools call request() with a path; these are the calls the tools make. Kept
// as data rather than scraped from source so that a rename shows up here as a
// deliberate edit. `path` is the spec path (with {placeholders}); `query` is
// every query key the tool can send.
const TOOL_CALLS = [
  // attendance.ts
  { tool: 'clokio_attendance_daily', method: 'get', path: '/attendance/daily', query: ['date', 'employee_code'] },
  { tool: 'clokio_attendance_range', method: 'get', path: '/attendance/range', query: ['date_from', 'date_to', 'employee_code'] },
  { tool: 'clokio_attendance_for_employee', method: 'get', path: '/attendance/employee/{employeeCode}', query: ['month', 'year'] },
  { tool: 'clokio_attendance_employee_day', method: 'get', path: '/attendance/employee/{employeeCode}/today', query: ['date'] },
  { tool: 'clokio_attendance_today_detailed', method: 'get', path: '/attendance/today/detailed', query: ['date'] },
  { tool: 'clokio_attendance_summary', method: 'get', path: '/attendance/summary', query: ['month', 'year'] },
  { tool: 'clokio_clock_in', method: 'post', path: '/attendance/clock-in', query: [] },
  { tool: 'clokio_clock_out', method: 'post', path: '/attendance/clock-out', query: [] },
  { tool: 'clokio_break_start', method: 'post', path: '/attendance/break-start', query: [] },
  { tool: 'clokio_break_end', method: 'post', path: '/attendance/break-end', query: [] },
  { tool: 'clokio_list_time_entries', method: 'get', path: '/time-entries', query: ['from', 'to', 'employee', 'project_id', 'per_page'] },
  // Logging time (backend #5775). `body` lists every body key the tool can
  // send; it is checked against the spec's curated requestBody when one exists.
  { tool: 'clokio_log_time', method: 'post', path: '/time-entries', query: [], body: ['task_id', 'date', 'start', 'end', 'duration_minutes', 'description'] },
  { tool: 'clokio_start_timer', method: 'post', path: '/timer/start', query: [], body: ['task_id', 'description', 'force'] },
  { tool: 'clokio_stop_timer', method: 'post', path: '/timer/stop', query: [], body: [] },
  { tool: 'clokio_get_active_timer', method: 'get', path: '/timer/active', query: [] },
  { tool: 'clokio_update_time_entry', method: 'patch', path: '/time-entries/{id}', query: [], body: ['task_id', 'date', 'start', 'end', 'duration_minutes', 'description'] },
  { tool: 'clokio_delete_time_entry', method: 'delete', path: '/time-entries/{id}', query: [] },
  { tool: 'clokio_list_leaves', method: 'get', path: '/leaves', query: ['from', 'to', 'employee', 'status', 'per_page'] },
  { tool: 'clokio_get_leave_balances', method: 'get', path: '/leaves/balances', query: ['employee'] },

  // employees.ts
  { tool: 'clokio_list_employees', method: 'get', path: '/employees', query: ['search', 'email', 'status', 'department', 'per_page'] },
  { tool: 'clokio_lookup_employee_by_pin', method: 'post', path: '/employees/lookup', query: [] },
  { tool: 'clokio_get_employee_task_stats', method: 'get', path: '/employees/{employeeCode}/task-stats', query: ['stale_days', 'definitions'] },
  { tool: 'clokio_get_inbox', method: 'get', path: '/employees/{employeeCode}/inbox', query: ['since'] },
  { tool: 'clokio_create_employee', method: 'post', path: '/employees', query: [] },
  { tool: 'clokio_set_employee_status', method: 'patch', path: '/employees/{employeeCode}/status', query: [] },

  // projects.ts
  { tool: 'clokio_list_projects', method: 'get', path: '/projects', query: ['search', 'status', 'per_page'] },
  { tool: 'clokio_get_project_statuses', method: 'get', path: '/projects/{projectId}/statuses', query: [] },
  { tool: 'clokio_get_project_custom_fields', method: 'get', path: '/projects/{projectId}/custom-fields', query: [] },
  { tool: 'clokio_get_project_contacts', method: 'get', path: '/projects/{projectId}/contacts', query: [] },
  { tool: 'clokio_get_client', method: 'get', path: '/clients/{clientId}', query: [] },
  { tool: 'clokio_add_client_contact', method: 'post', path: '/clients/{clientId}/contacts', query: [] },
  { tool: 'clokio_list_task_statuses', method: 'get', path: '/task-statuses', query: [] },
  { tool: 'clokio_list_task_labels', method: 'get', path: '/task-labels', query: [] },
  { tool: 'clokio_list_locations', method: 'get', path: '/locations', query: [] },
  { tool: 'clokio_list_webhooks', method: 'get', path: '/webhooks', query: ['active'] },
  { tool: 'clokio_whoami', method: 'get', path: '/me', query: [] },

  // tasks.ts
  {
    tool: 'clokio_list_tasks',
    method: 'get',
    path: '/tasks',
    query: [
      'project_id', 'status', 'priority', 'assignee_employee_code', 'label', 'search',
      'open', 'recurring', 'series_of', 'parent_task_id', 'created_before', 'created_after', 'due_before', 'due_after', 'updated_since',
      'include_comments', 'per_page', 'page', 'cursor', 'sort', 'compact',
    ],
  },
  { tool: 'clokio_get_task', method: 'get', path: '/tasks/{id}', query: ['comments_limit'] },
  { tool: 'clokio_create_task', method: 'post', path: '/tasks', query: [] },
  { tool: 'clokio_update_task', method: 'patch', path: '/tasks/{id}', query: [] },
  { tool: 'clokio_delete_task', method: 'delete', path: '/tasks/{id}', query: [] },
  { tool: 'clokio_set_task_assignees', method: 'patch', path: '/tasks/{id}/assignees', query: [] },
  { tool: 'clokio_list_project_people', method: 'get', path: '/projects/{projectId}/people', query: [] },
  { tool: 'clokio_list_task_comments', method: 'get', path: '/tasks/{id}/comments', query: [] },
  { tool: 'clokio_add_task_comment', method: 'post', path: '/tasks/{id}/comments', query: [] },
  { tool: 'clokio_update_task_comment', method: 'patch', path: '/tasks/{id}/comments/{commentId}', query: [] },
  { tool: 'clokio_list_task_attachments', method: 'get', path: '/tasks/{id}/attachments', query: [] },
  { tool: 'clokio_download_task_attachment', method: 'get', path: '/tasks/{id}/attachments/{attachmentId}', query: [] },
  { tool: 'clokio_download_task_media', method: 'get', path: '/tasks/{id}/media', query: ['path'] },
  // Bulk download first LISTS the task's attachments, then fetches each by id
  // (the same two endpoints the single list + download tools use). The list
  // endpoint is the one its own request() call hits; the per-file GETs go
  // through the already-covered download path.
  { tool: 'clokio_download_task_attachments', method: 'get', path: '/tasks/{id}/attachments', query: [] },
  { tool: 'clokio_upload_task_attachment', method: 'post', path: '/tasks/{id}/attachments', query: [] },
  { tool: 'clokio_upload_task_media', method: 'post', path: '/tasks/{id}/media', query: [] },
  { tool: 'clokio_get_task_activity', method: 'get', path: '/tasks/{id}/activity', query: ['from', 'to', 'per_page', 'page'] },
  { tool: 'clokio_list_task_dependencies', method: 'get', path: '/tasks/{id}/dependencies', query: [] },
  { tool: 'clokio_add_task_dependency', method: 'post', path: '/tasks/{id}/dependencies', query: [] },
  { tool: 'clokio_remove_task_dependency', method: 'delete', path: '/tasks/{id}/dependencies/{depId}', query: [] },
  { tool: 'clokio_set_task_custom_field', method: 'patch', path: '/tasks/{id}/custom-fields', query: [] },
  { tool: 'clokio_bulk_update_tasks', method: 'patch', path: '/tasks/bulk', query: [] },

  // docs.ts - /api/v1/docs, acting as the key's effective actor. Tools that
  // pick a route by argument (member by code vs by id) list BOTH calls.
  // `awaits` names query parameters the 0.18.1 backend fixes add; until that
  // backend is deployed these checks FAIL, labelled "waits on backend". Drop
  // the `awaits` field once they pass.
  { tool: 'clokio_list_docs', method: 'get', path: '/docs', query: ['project_id', 'parent_id', 'q', 'archived', 'page', 'per_page'] },
  { tool: 'clokio_get_doc_tree', method: 'get', path: '/docs', query: ['tree', 'project_id', 'archived', 'page', 'per_page'] },
  { tool: 'clokio_search_docs', method: 'get', path: '/docs/search', query: ['q', 'project_id', 'limit'] },
  { tool: 'clokio_get_doc', method: 'get', path: '/docs/{id}', query: ['format', 'include_title'] },
  { tool: 'clokio_create_doc', method: 'post', path: '/docs', query: [] },
  { tool: 'clokio_update_doc_content', method: 'put', path: '/docs/{id}/content', query: [] },
  { tool: 'clokio_update_doc_meta', method: 'patch', path: '/docs/{id}', query: [] },
  { tool: 'clokio_move_doc', method: 'post', path: '/docs/{id}/move', query: [] },
  { tool: 'clokio_archive_doc', method: 'post', path: '/docs/{id}/archive', query: [] },
  { tool: 'clokio_restore_doc', method: 'post', path: '/docs/{id}/restore', query: [] },
  { tool: 'clokio_delete_doc', method: 'delete', path: '/docs/{id}', query: [] },
  { tool: 'clokio_list_doc_templates', method: 'get', path: '/docs/templates', query: [] },
  { tool: 'clokio_create_doc_from_template', method: 'post', path: '/docs/from-template', query: [] },
  { tool: 'clokio_list_doc_members', method: 'get', path: '/docs/{id}/members', query: ['include_avatars'] },
  { tool: 'clokio_list_doc_shareable_teams', method: 'get', path: '/docs/{id}/shareable-teams', query: [] },
  { tool: 'clokio_add_doc_member', method: 'post', path: '/docs/{id}/members', query: [] },
  { tool: 'clokio_update_doc_member', method: 'patch', path: '/docs/{id}/members', query: [] },
  { tool: 'clokio_update_doc_member', method: 'patch', path: '/docs/{id}/members/{employeeId}', query: [] },
  { tool: 'clokio_remove_doc_member', method: 'delete', path: '/docs/{id}/members', query: ['employee_code'] },
  { tool: 'clokio_remove_doc_member', method: 'delete', path: '/docs/{id}/members/{employeeId}', query: [] },
  { tool: 'clokio_add_doc_team', method: 'post', path: '/docs/{id}/teams', query: [] },
  { tool: 'clokio_update_doc_team', method: 'patch', path: '/docs/{id}/teams/{teamId}', query: [] },
  { tool: 'clokio_remove_doc_team', method: 'delete', path: '/docs/{id}/teams/{teamId}', query: [] },
  { tool: 'clokio_create_doc_share_link', method: 'post', path: '/docs/{id}/share-link', query: [] },
  { tool: 'clokio_revoke_doc_share_link', method: 'delete', path: '/docs/{id}/share-link', query: [] },
  { tool: 'clokio_list_doc_comments', method: 'get', path: '/docs/{id}/comments', query: ['filter', 'block_id'] },
  { tool: 'clokio_add_doc_comment', method: 'post', path: '/docs/{id}/comments', query: [] },
  { tool: 'clokio_resolve_doc_comment', method: 'post', path: '/docs/{id}/comments/{commentId}/resolve', query: [] },
  { tool: 'clokio_reopen_doc_comment', method: 'post', path: '/docs/{id}/comments/{commentId}/reopen', query: [] },
  { tool: 'clokio_list_doc_versions', method: 'get', path: '/docs/{id}/versions', query: [] },
  { tool: 'clokio_get_doc_version', method: 'get', path: '/docs/{id}/versions/{versionId}', query: ['format', 'include_title'] },
  { tool: 'clokio_restore_doc_version', method: 'post', path: '/docs/{id}/versions/{versionId}/restore', query: [] },
  { tool: 'clokio_list_doc_attachments', method: 'get', path: '/docs/{id}/attachments', query: [] },
  { tool: 'clokio_upload_doc_attachment', method: 'post', path: '/docs/{id}/attachments', query: [] },
  { tool: 'clokio_download_doc_attachment', method: 'get', path: '/docs/{id}/attachments/download', query: ['path'] },
  // tickets.ts
  { tool: 'clokio_list_tickets', method: 'get', path: '/tickets', query: ['state', 'inbox_id', 'assignee', 'label_id', 'contact_id', 'updated_since', 'q', 'per_page', 'cursor'] },
  { tool: 'clokio_get_ticket', method: 'get', path: '/tickets/{id}', query: [] },
  { tool: 'clokio_get_ticket', method: 'get', path: '/tickets/{id}/messages', query: ['per_page'] },
  { tool: 'clokio_list_ticket_messages', method: 'get', path: '/tickets/{id}/messages', query: ['cursor', 'per_page'] },
  { tool: 'clokio_reply_ticket', method: 'post', path: '/tickets/{id}/replies', query: [] },
  { tool: 'clokio_add_ticket_note', method: 'post', path: '/tickets/{id}/notes', query: [] },
  { tool: 'clokio_create_reply_draft', method: 'post', path: '/tickets/{id}/drafts', query: [] },
  { tool: 'clokio_download_ticket_attachment', method: 'get', path: '/tickets/{id}/attachments/{attachmentId}', query: [] },
  { tool: 'clokio_update_ticket', method: 'patch', path: '/tickets/{id}', query: [] },
  { tool: 'clokio_add_ticket_label', method: 'post', path: '/tickets/{id}/labels', query: [] },
  { tool: 'clokio_remove_ticket_label', method: 'delete', path: '/tickets/{id}/labels/{labelId}', query: [] },
  { tool: 'clokio_list_contacts', method: 'get', path: '/contacts', query: ['q', 'page'] },
  { tool: 'clokio_get_contact', method: 'get', path: '/contacts/{id}', query: [] },
  { tool: 'clokio_update_contact', method: 'patch', path: '/contacts/{id}', query: [] },
  { tool: 'clokio_list_inboxes', method: 'get', path: '/inboxes', query: [] },
  { tool: 'clokio_list_ticket_labels', method: 'get', path: '/ticket-labels', query: [] },
  { tool: 'clokio_list_saved_replies', method: 'get', path: '/saved-replies', query: ['inbox_id'] },
];

let fails = 0;
const fail = (msg) => {
  fails++;
  console.log(`FAIL ${msg}`);
};

let spec;
let source;
if (SPEC_FILE) {
  spec = JSON.parse(await readFile(SPEC_FILE, 'utf8'));
  source = SPEC_FILE;
} else {
  const res = await fetch(SPEC_URL, { redirect: 'error' });
  if (!res.ok) {
    console.log(`Could not read the spec at ${SPEC_URL} (HTTP ${res.status}).`);
    process.exit(2);
  }
  spec = await res.json();
  source = SPEC_URL;
}

// Spec paths carry the /api/v1 prefix; tool paths are relative to it, because
// client.js adds the prefix itself.
const specPaths = new Map(
  Object.entries(spec.paths).map(([p, ops]) => [p.replace(/^\/api\/v1/, ''), ops])
);

console.log(`Spec: ${source} (${specPaths.size} paths)\n`);

for (const call of TOOL_CALLS) {
  const ops = specPaths.get(call.path);
  if (!ops) {
    fail(`${call.tool}: path ${call.path} is not in the API spec`);
    continue;
  }
  const op = ops[call.method];
  if (!op) {
    fail(`${call.tool}: the API serves ${call.path} but not ${call.method.toUpperCase()} on it`);
    continue;
  }

  const known = new Set((op.parameters ?? []).map((p) => p.name));
  const unknown = call.query.filter((q) => !known.has(q));
  if (unknown.length) {
    const waiting = unknown.filter((q) => (call.awaits ?? []).includes(q));
    fail(
      `${call.tool}: ${call.method.toUpperCase()} ${call.path} does not accept ` +
        `${unknown.join(', ')} (it accepts: ${[...known].join(', ') || 'no query parameters'})` +
        (waiting.length === unknown.length ? ' [waits on backend 0.18.1 fixes]' : '')
    );
    continue;
  }

  // A REQUIRED parameter the tool can never send is a tool that always 422s.
  const missingRequired = (op.parameters ?? [])
    .filter((p) => p.required && p.in === 'query')
    .map((p) => p.name)
    .filter((n) => !call.query.includes(n));
  if (missingRequired.length) {
    fail(`${call.tool}: cannot send REQUIRED parameter(s) ${missingRequired.join(', ')}`);
    continue;
  }

  // A body key the endpoint does not list is refused (422) by routes that
  // allow-list their bodies; check it against the curated schema.
  const props = op.requestBody?.content?.['application/json']?.schema?.properties;
  if (call.body && props) {
    const extra = call.body.filter((k) => !(k in props));
    if (extra.length) {
      fail(`${call.tool}: sends body field(s) ${extra.join(', ')} that ${call.path} does not accept`);
      continue;
    }
  }

  console.log(`PASS ${call.tool} -> ${call.method.toUpperCase()} ${call.path}`);
}

// Every tool the server registers must appear above, or a new tool could ship
// unchecked - which is exactly how the broken ones got out.
const registered = new Set();
for (const file of ['tasks', 'projects', 'employees', 'attendance', 'docs', 'tickets']) {
  const src = await readFile(new URL(`../src/tools/${file}.ts`, import.meta.url), 'utf8');
  for (const m of src.matchAll(/name:\s*'(clokio_[a-z_]+)'/g)) registered.add(m[1]);
}
const covered = new Set(TOOL_CALLS.map((c) => c.tool));
for (const name of registered) {
  if (!covered.has(name)) fail(`${name} is registered as a tool but has no conformance entry`);
}
for (const name of covered) {
  if (!registered.has(name)) fail(`${name} has a conformance entry but is not a registered tool`);
}

console.log(
  fails === 0
    ? `\nALL PASS (${covered.size} tools, ${TOOL_CALLS.length} calls checked against the live spec)`
    : `\n${fails} FAILED`
);
process.exit(fails === 0 ? 0 : 1);
