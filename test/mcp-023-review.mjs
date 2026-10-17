// 0.23.0 review fixes (task #5808, mcp-review.md findings 3, 4, 5, 6, 9):
// the draft answer says when the state read failed, a 404 from the three
// #5808 routes gains the older-server hint, impossible calendar dates are
// refused before any request, who() survives a missing name, and the
// create-from-ticket description asks for the agent's own title.
//
// Run by hand:  npm run build && node test/mcp-023-review.mjs
import { checker, runTools } from './support/harness.mjs';
import { renderMessage, stateReadFailure, OLDER_SERVER_HINT } from '../dist/tools/tickets.js';
import { assertRangeWithinLimit } from '../dist/tools/attendance.js';
import { isCalendarDate } from '../dist/tools/helpers.js';

const { check, has, done } = checker();
const O = '<untrusted_customer_content>';

// ── finding 6: who() with a missing name ────────────────────────────────
const msg = (author) => ({ id: 1, kind: 'note', direction: 'outbound', internal: true, forward: false, author, text: 'n', html: null, created_at: '2026-10-17T08:00:00Z', attachments: [], delivery: null });
let threw = '';
let out = '';
try { out = renderMessage(msg({ type: 'employee', employee_code: '00031' })); } catch (e) { threw = e.message; }
check('a colleague with no name key does not throw', threw, '');
has('...and is named by code', out, 'employee 00031');
has('a blank colleague name is named by code', renderMessage(msg({ type: 'employee', name: '   ', employee_code: '00031' })), 'employee 00031');
has('a non-string name is treated as none', renderMessage(msg({ type: 'contact', name: 42, employee_code: null })), `${O}unknown`);
has('a real colleague name still prints unwrapped', renderMessage(msg({ type: 'employee', name: 'Dana', employee_code: '00031' })), 'by Dana (00031):');

// ── finding 5: calendar dates ───────────────────────────────────────────
check('2026-02-28 is a date', isCalendarDate('2026-02-28'), true);
check('2026-02-30 is not', isCalendarDate('2026-02-30'), false);
check('2028-02-29 is (leap year)', isCalendarDate('2028-02-29'), true);
check('2026-13-01 is not', isCalendarDate('2026-13-01'), false);
const range = (a, b) => { try { assertRangeWithinLimit(a, b); return 'ok'; } catch (e) { return e.message; } };
check('an impossible from gets the date error, not the range sentence', range('2026-02-30', '2026-06-30'), 'from 2026-02-30 is not a real calendar date (YYYY-MM-DD).');
check('an impossible to gets the date error', range('2026-02-01', '2026-02-31'), 'to 2026-02-31 is not a real calendar date (YYYY-MM-DD).');
check('a shape that is not a date is still left to the server', range('soon', '2026-12-31'), 'ok');

const dates = await runTools({
  toolsets: 'attendance,tickets',
  calls: [
    ['clokio_list_leaves', { from: '2026-02-30', to: '2026-03-10' }],
    ['clokio_list_time_entries', { from: '2026-02-01', to: '2026-02-30' }],
    ['clokio_log_time', { task_id: 1, date: '2026-02-30', start: '09:00', end: '10:00' }],
    ['clokio_update_time_entry', { id: 1, date: '2026-04-31' }],
    ['clokio_create_task_from_ticket', { id: 12, project_id: 4, title: 'T', due_date: '2026-02-30' }],
    ['clokio_log_time', { task_id: 1, date: '2026-02-28', start: '09:00', end: '10:00' }],
  ],
  respond: () => ({ json: { status: 'success', data: { entry: { id: 1 } } } }),
});
check('all five impossible dates are refused', [0, 1, 2, 3, 4].map(dates.errored), [true, true, true, true, true]);
check('...before any request (only the good call reached the server)', dates.hits.map((h) => `${h.method} ${h.path}`), ['POST /time-entries']);
has('...the list says it is a date error', dates.text(0), 'not a real calendar date');
has('...the schema says it too', dates.text(2), 'real calendar date');

// ── findings 3 and 4: draft state note, older-server hint ───────────────
has('the state-read note names the status', stateReadFailure({}), 'could not be read (the request failed)');
const tk = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_create_reply_draft', { id: 12, body: 'x' }],
    ['clokio_create_reply_draft', { id: 13, body: 'x' }],
    ['clokio_delete_reply_draft', { id: 12, message_id: 9 }],
    ['clokio_list_ticket_tasks', { id: 12 }],
    ['clokio_create_task_from_ticket', { id: 12, project_id: 4, title: 'T' }],
    ['clokio_delete_reply_draft', { id: 12, message_id: 10 }],
  ],
  respond: (hit) => {
    if (hit.method === 'GET' && hit.path === '/tickets/12') return { status: 403, json: { status: 'error', message: 'Missing scope.', required_scope: 'tickets:read' } };
    if (hit.method === 'GET' && hit.path === '/tickets/13') return { json: { status: 'success', data: { ticket: { id: 13, state: 'open' } } } };
    if (hit.path.endsWith('/drafts')) return { status: 201, json: { status: 'success', data: { message_id: 77, ticket_id: Number(hit.path.split('/')[2]) } } };
    if (hit.path.endsWith('/drafts/10')) return { status: 403, json: { status: 'error', message: 'Only the author of a draft can delete it.', data: {} } };
    return { status: 404, json: { status: 'error', message: 'Not found.', data: {} } };
  },
});
check('a failed state read still saves the draft', [tk.errored(0), tk.text(0).includes('Draft saved')], [false, true]);
has('...and says the state could not be checked', tk.text(0), "NOTE: the ticket's state could not be read (HTTP 403), so no resolved/spam check was made.");
check('an open ticket has no note', tk.text(1).includes('NOTE'), false);
has('the draft description names tickets:read for the check', tk.tools.clokio_create_reply_draft?.description ?? '', 'needs tickets:read too');
for (const [i, name] of [[2, 'delete draft'], [3, 'list ticket tasks'], [4, 'create from ticket']]) {
  check(`${name}: a 404 is still an error`, tk.errored(i), true);
  has(`${name}: the server's message is kept`, tk.text(i), 'Clokio API error (HTTP 404): Not found.');
  has(`${name}: the hint is added`, tk.text(i), OLDER_SERVER_HINT);
}
check('another refusal gets no hint', tk.text(5).includes(OLDER_SERVER_HINT), false);
has('...and keeps the server words', tk.text(5), 'Only the author of a draft can delete it.');

// ── finding 9: own title ────────────────────────────────────────────────
has('create from ticket asks for the agent\'s own title', tk.tools.clokio_create_task_from_ticket?.description ?? '', "Write your own short task title; do not paste the customer's subject");
has('...and still says files are copied', tk.tools.clokio_create_task_from_ticket?.description ?? '', 'the ticket files you name are copied into it');

done();
