// 0.25.0 part 1: the MCP-only QA notes N1-N4 of task #5808 (comment 14541).
//   N1  a plain 404 from create-task-from-ticket / delete-draft names its real
//       cause (ticket, project, message, or an older server), found by
//       follow-up reads; a 404 in other words passes through unchanged.
//   N2  an empty time-entry list claims no time zone.
//   N3  clokio_get_leave_days_taken, with clokio_get_leave_balances as a
//       deprecated alias.
//   N4  (no server replay signal exists; the wording stays as it is - see
//       the 0.25.0 CHANGELOG entry.)
//
// Run by hand:  npm run build && node test/mcp-025.mjs
import { checker, runTools } from './support/harness.mjs';
import { renderTimeEntries } from '../dist/tools/attendance.js';
import { OLDER_SERVER_HINT } from '../dist/tools/tickets.js';

const { check, has, done } = checker();
const NF = { status: 404, json: { status: 'error', message: 'Not found.', data: {} } };
const OK = (data) => ({ json: { status: 'success', data } });

// ── N2: empty list ──────────────────────────────────────────────────────
const empty = renderTimeEntries({ data: [], meta: { current_page: 1, last_page: 1, total: 0 } }).split('\n');
has('empty list says there are no entries', empty[0], 'No time entries.');
check('...and claims no UTC', empty.join('\n').includes('UTC'), false);
check('...nor a named zone', /Asia\//.test(empty.join('\n')), false);
has('...and still says update takes local times', empty[0], "takes the person's LOCAL date and times");
check('...one header line, then the page line', empty.length, 2);

const emptyRun = await runTools({
  toolsets: 'attendance',
  calls: [['clokio_list_time_entries', { from: '2026-10-01', to: '2026-10-02' }]],
  respond: () => ({ json: { status: 'success', data: [], meta: { current_page: 1, last_page: 1, total: 0 } } }),
});
has('the tool answer for an empty page', emptyRun.text(0), 'No time entries.');
check('...with no UTC header', emptyRun.text(0).includes('Times are UTC'), false);

// ── N3: the new name and the alias ──────────────────────────────────────
const TAKEN = { employee_code: '00080', year: 2026, types: [{ code: 'sick', name: 'Sick', taken: 3, pending: 0.5 }] };
const lv = await runTools({
  toolsets: 'attendance',
  calls: [
    ['clokio_get_leave_days_taken', { employee_code: '00080', year: 2026 }],
    ['clokio_get_leave_balances', { employee_code: '00080', year: 2026 }],
    ['clokio_get_leave_days_taken', {}],
  ],
  respond: () => OK(TAKEN),
});
const t = lv.tools;
check('the new tool is registered', Boolean(t.clokio_get_leave_days_taken), true);
check('the old name is still registered', Boolean(t.clokio_get_leave_balances), true);
check('the old name is deprecated and names the new tool', t.clokio_get_leave_balances?.description?.startsWith('DEPRECATED: use clokio_get_leave_days_taken'), true);
check('the new name is not marked deprecated', t.clokio_get_leave_days_taken?.description?.includes('DEPRECATED'), false);
check('both are read-only', [t.clokio_get_leave_days_taken?.annotations?.readOnlyHint, t.clokio_get_leave_balances?.annotations?.readOnlyHint], [true, true]);
check('same input schema', JSON.stringify(t.clokio_get_leave_days_taken?.inputSchema), JSON.stringify(t.clokio_get_leave_balances?.inputSchema));
check('both call the same route with the same query', lv.hits.map((h) => `${h.method} ${h.path} ${h.query.employee} ${h.query.year}`), ['GET /leaves/balances 00080 2026', 'GET /leaves/balances 00080 2026']);
check('same answer from both', lv.text(0), lv.text(1));
check('the new name still requires employee_code', [lv.errored(2), lv.text(2).includes('employee_code is required')], [true, true]);

// ── N1: create task from ticket ─────────────────────────────────────────
// Scenarios keyed by ticket id; the POST always answers the plain 404.
const create = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_create_task_from_ticket', { id: 21, project_id: 999, title: 'T' }], // new server, missing project
    ['clokio_create_task_from_ticket', { id: 22, project_id: 4, title: 'T' }], // missing ticket
    ['clokio_create_task_from_ticket', { id: 23, project_id: 4, title: 'T' }], // older server
    ['clokio_create_task_from_ticket', { id: 24, project_id: 998, title: 'T' }], // no tasks:read, project missing
    ['clokio_create_task_from_ticket', { id: 25, project_id: 4, title: 'T' }], // no tasks:read, no tickets:read
    ['clokio_create_task_from_ticket', { id: 26, project_id: 4, title: 'T' }], // a 404 in other words
    ['clokio_create_task_from_ticket', { id: 27, project_id: 4, title: 'T' }], // a 422 is untouched
  ],
  respond: (hit) => {
    const id = Number(hit.path.split('/')[2]);
    if (hit.method === 'POST') {
      if (id === 26) return { status: 404, json: { status: 'error', message: 'That project is not available.', data: {} } };
      if (id === 27) return { status: 422, json: { status: 'error', message: 'The given data was invalid.', errors: { title: ['x'] } } };
      return NF;
    }
    if (hit.path.startsWith('/projects/')) return hit.path === '/projects/4/statuses' ? OK([]) : NF;
    const isList = hit.path.endsWith('/tasks');
    if (id === 21) return isList ? OK({ ticket: { id: 21 }, tasks: [] }) : OK({ ticket: { id: 21 } });
    if (id === 22) return NF;
    if (id === 23) return isList ? NF : OK({ ticket: { id: 23 } });
    if (id === 24) return isList ? { status: 403, json: { status: 'error', message: 'Missing scope.', required_scope: 'tasks:read' } } : OK({ ticket: { id: 24 } });
    if (id === 25) return { status: 403, json: { status: 'error', message: 'Missing scope.' } };
    return NF;
  },
});
for (let i = 0; i < 7; i++) check(`create ${i}: still an error`, create.errored(i), true);
has('missing project: names the project', create.text(0), 'Project #999 does not exist or is not available');
check('...and does not blame the server', create.text(0).includes('predates'), false);
has('...keeps the server words first', create.text(0), 'HTTP 404): Not found. Project #999');
has('missing ticket: names the ticket', create.text(1), 'Ticket #22 does not exist, or the acting employee cannot open it');
check('...and does not blame the server', create.text(1).includes('predates'), false);
has('older server: says so plainly', create.text(2), 'Ticket #23 opens, but this Clokio server has no tasks route on it: it predates task #5808.');
has('no tasks:read, project probe 404: names the project', create.text(3), 'Project #998 does not exist');
has('nothing readable: lists the causes', create.text(4), 'could not be narrowed (the follow-up read failed: HTTP 403)');
has('...naming the project among them', create.text(4), 'project #4 is missing');
has('...and the old-server hint as one of them', create.text(4), OLDER_SERVER_HINT);
has('a 404 in other words is shown as is', create.text(5), 'That project is not available.');
check('...with no hint and no probe', [create.text(5).includes('predates'), create.hits.some((h) => h.method === 'GET' && h.path.startsWith('/tickets/26'))], [false, false]);
check('a 422 makes no probe', create.hits.some((h) => h.method === 'GET' && h.path.startsWith('/tickets/27')), false);
check('the create was sent once per call (no retry of the write)', create.hits.filter((h) => h.method === 'POST').length, 7);

// ── N1: delete reply draft ──────────────────────────────────────────────
const msg = (id, extra = {}) => ({ id, kind: 'note', direction: 'outbound', internal: true, forward: false, author: { type: 'employee', name: 'Dana', employee_code: '00031' }, text: 'x', html: null, created_at: '2026-10-17T08:00:00Z', attachments: [], delivery: null, ...extra });
const del = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_delete_reply_draft', { id: 31, message_id: 500 }], // already deleted (not on the ticket)
    ['clokio_delete_reply_draft', { id: 32, message_id: 600 }], // missing ticket
    ['clokio_delete_reply_draft', { id: 33, message_id: 700 }], // older server: the draft is there
    ['clokio_delete_reply_draft', { id: 34, message_id: 800 }], // no tickets:read
    ['clokio_delete_reply_draft', { id: 35, message_id: 900 }], // message on page 2, older server
  ],
  respond: (hit) => {
    const id = Number(hit.path.split('/')[2]);
    if (hit.method === 'DELETE') return NF;
    if (id === 32) return NF;
    if (id === 34) return { status: 403, json: { status: 'error', message: 'Missing scope.', required_scope: 'tickets:read' } };
    if (!hit.path.endsWith('/messages')) return OK({ ticket: { id } });
    if (id === 31) return { json: { status: 'success', data: { messages: [msg(499)] }, meta: { next_cursor: null } } };
    if (id === 33) return { json: { status: 'success', data: { messages: [msg(700, { draft: { state: 'pending', used_at: null } })] }, meta: { next_cursor: null } } };
    if (id === 35) {
      return hit.query.cursor
        ? { json: { status: 'success', data: { messages: [msg(900, { draft: { state: 'pending', used_at: null } })] }, meta: { next_cursor: null } } }
        : { json: { status: 'success', data: { messages: [msg(1)] }, meta: { next_cursor: 'c2' } } };
    }
    return NF;
  },
});
for (let i = 0; i < 5; i++) check(`delete ${i}: still an error`, del.errored(i), true);
has('already deleted: says so', del.text(0), 'Ticket #31 has no message #500: it was already deleted, or it belongs to another ticket.');
check('...and does not blame the server', del.text(0).includes('predates'), false);
has('missing ticket: names the ticket', del.text(1), 'Ticket #32 does not exist');
has('older server: the message is there, so the route is missing', del.text(2), 'this Clokio server predates task #5808 and cannot delete drafts yet');
has('no tickets:read: lists the causes', del.text(3), 'could not be narrowed (the follow-up read failed: HTTP 403)');
has('...the deleted message among them', del.text(3), 'message #800 is not on it');
has('the message walk follows the cursor', del.text(4), 'Message #900 is on ticket #35');
check('...reading page 2 with the cursor', del.hits.some((h) => h.path === '/tickets/35/messages' && h.query.cursor === 'c2'), true);

// ── N1: the list keeps the 0.23 hint (a 404 there is the ticket or the route) ──
const list = await runTools({ toolsets: 'tickets', calls: [['clokio_list_ticket_tasks', { id: 41 }]], respond: () => NF });
has('list ticket tasks keeps the conditional hint', list.text(0), OLDER_SERVER_HINT);

// ── descriptions ────────────────────────────────────────────────────────
has('create description explains the 404 cause', create.tools.clokio_create_task_from_ticket?.description ?? '', 'to name the cause');
has('delete description explains the 404 cause', del.tools.clokio_delete_reply_draft?.description ?? '', 'to name the cause');

done();
