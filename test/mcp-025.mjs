// 0.25.0: the QA notes N1-N4 of task #5808 (comment 14541).
//   N1  (E7, part 2) the server words a missing project / draft itself; those
//       sentences pass through, and only a plain "Not found." gains the ticket
//       cause plus the older server as ONE possible cause. No follow-up reads.
//   N2  an empty time-entry list claims no time zone.
//   N3  clokio_get_leave_days_taken, with clokio_get_leave_balances as a
//       deprecated alias.
//   N4  the replay wording is in test/mcp-025-part2.mjs.
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

// ── N1 / E7: create task from ticket (the server's own sentences, no probing) ──
const create = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_create_task_from_ticket', { id: 21, project_id: 999, title: 'T' }], // missing project: the server's sentence
    ['clokio_create_task_from_ticket', { id: 22, project_id: 4, title: 'T' }], // plain Not found.
    ['clokio_create_task_from_ticket', { id: 27, project_id: 4, title: 'T' }], // a 422 is untouched
  ],
  respond: (hit) => {
    const id = Number(hit.path.split('/')[2]);
    if (id === 21) return { status: 404, json: { status: 'error', message: 'That project is not available.', data: {} } };
    if (id === 27) return { status: 422, json: { status: 'error', message: 'The given data was invalid.', errors: { title: ['x'] } } };
    return NF;
  },
});
for (let i = 0; i < 3; i++) check(`create ${i}: still an error`, create.errored(i), true);
has('missing project: the server sentence as it comes', create.text(0), 'Clokio API error (HTTP 404): That project is not available.');
check('...with no hint added', [create.text(0).includes('predates'), create.text(0).includes(OLDER_SERVER_HINT)], [false, false]);
has('plain Not found.: names the ticket', create.text(1), 'HTTP 404): Not found. Ticket #22 does not exist, or the acting employee cannot open it');
has('...and the old server as ONE possible cause', create.text(1), OLDER_SERVER_HINT);
has('...worded as one possible cause', create.text(1), 'One possible cause:');
check('a 422 has no hint', create.text(2).includes('possible cause'), false);
check('no follow-up reads at all (only the POSTs)', create.hits.map((h) => h.method), ['POST', 'POST', 'POST']);

// ── N1 / E7: delete reply draft ─────────────────────────────────────────
const del = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_delete_reply_draft', { id: 31, message_id: 500 }], // already deleted: the server's sentence
    ['clokio_delete_reply_draft', { id: 32, message_id: 600 }], // plain Not found.
  ],
  respond: (hit) => {
    const id = Number(hit.path.split('/')[2]);
    if (id === 31) return { status: 404, json: { status: 'error', message: 'This draft no longer exists.', data: {} } };
    return NF;
  },
});
check('delete: both errors', [del.errored(0), del.errored(1)], [true, true]);
has('deleted draft: the server sentence as it comes', del.text(0), 'Clokio API error (HTTP 404): This draft no longer exists.');
check('...with no hint', del.text(0).includes('possible cause'), false);
has('plain Not found.: names the ticket', del.text(1), 'Not found. Ticket #32 does not exist');
has('...and the old server as one possible cause', del.text(1), OLDER_SERVER_HINT);
check('no follow-up reads (only the DELETEs)', del.hits.map((h) => h.method), ['DELETE', 'DELETE']);

// ── N1: the list keeps the 0.23 hint (a 404 there is the ticket or the route) ──
const list = await runTools({ toolsets: 'tickets', calls: [['clokio_list_ticket_tasks', { id: 41 }]], respond: () => NF });
has('list ticket tasks keeps the conditional hint', list.text(0), OLDER_SERVER_HINT);

// ── descriptions ────────────────────────────────────────────────────────
has('create description names the project sentence', create.tools.clokio_create_task_from_ticket?.description ?? '', '"That project is not available."');
has('create description names the replay wording', create.tools.clokio_create_task_from_ticket?.description ?? '', 'already created from this ticket (replayed, no new task)');
has('delete description names the draft sentence', del.tools.clokio_delete_reply_draft?.description ?? '', '"This draft no longer exists."');
check('no description promises follow-up reads any more', /to name the cause/.test((create.tools.clokio_create_task_from_ticket?.description ?? '') + (del.tools.clokio_delete_reply_draft?.description ?? '')), false);

done();
