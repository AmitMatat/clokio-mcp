// 0.22.0 time tools (backend spec 2026-10-16-mcp-qa-0.22 sections 1, 2, 3):
// edit and delete an entry of the acting person, entry rows with id and
// RUNNING, and the under-a-minute warning on stop.
//
// Run by hand:  npm run build && node test/time-edit-tools.mjs
import { checker, runTools } from './support/harness.mjs';
import { timeEntryLine, shortEntryWarning } from '../dist/tools/attendance.js';

const { check, has, done } = checker();

const ENTRY = { id: 46906, employee_code: '00055', date: '2026-10-16', check_in: '2026-10-16T06:00:00Z', check_out: '2026-10-16T07:30:00Z', work_hour: 1.5, task: { id: 5803, title: 'MCP QA' }, description: 'MCP QA run', running: false };
const RUNNING = { ...ENTRY, id: 46910, check_out: null, work_hour: null, running: true };

// Pure renderers.
check('an entry line', timeEntryLine(ENTRY), '#46906 2026-10-16 06:00-07:30 UTC 1.5h | 00055 | task #5803 MCP QA | MCP QA run');
check('a running entry says RUNNING', timeEntryLine(RUNNING).includes('06:00-RUNNING'), true);
check('an older server row says it has no id', timeEntryLine({ ...ENTRY, id: undefined }).startsWith('(no id: server older than 2026-10-16)'), true);
check('a 40-second entry warns', shortEntryWarning({ id: 7, check_in: '2026-10-16T06:00:00Z', check_out: '2026-10-16T06:00:40Z' }), 'This entry lasted 40 seconds. If it was a mistake, delete it with clokio_delete_time_entry id=7.');
check('a minute is not short', shortEntryWarning({ id: 7, check_in: '2026-10-16T06:00:00Z', check_out: '2026-10-16T06:01:00Z' }), null);

const run = await runTools({
  toolsets: 'attendance',
  calls: [
    ['clokio_list_time_entries', { from: '2026-10-01', to: '2026-10-31' }],
    ['clokio_update_time_entry', { id: 46906, start: '08:30', end: '10:15' }],
    ['clokio_update_time_entry', { id: 46906, description: null }],
    ['clokio_delete_time_entry', { id: 46906 }],
    ['clokio_stop_timer', {}],
    // Refused locally, no HTTP call:
    ['clokio_update_time_entry', { id: 46906 }],
    ['clokio_update_time_entry', { id: 46906, end: '10:00', duration_minutes: 30 }],
    ['clokio_update_time_entry', { id: 46906, start: '8:30' }],
  ],
  respond: (hit) => {
    if (hit.method === 'GET' && hit.path === '/time-entries') return { json: { status: 'success', data: [ENTRY, RUNNING], meta: { current_page: 1, last_page: 1, per_page: 25, total: 2 } } };
    if (hit.method === 'PATCH') return { json: { status: 'success', message: 'Time entry updated.', data: { entry: ENTRY } } };
    if (hit.method === 'DELETE') return { json: { status: 'success', message: 'Time entry deleted.', data: { entry: ENTRY } } };
    if (hit.path === '/timer/stop') return { json: { status: 'success', message: 'Timer stopped.', data: { entry: { ...ENTRY, id: 46911, check_out: '2026-10-16T06:00:02Z' } } } };
    return undefined;
  },
});

check('the good calls succeed', [0, 1, 2, 3, 4].map(run.errored), [false, false, false, false, false]);
check('an empty edit is refused', run.errored(5), true);
check('end AND duration is refused', run.errored(6), true);
check('a malformed start is refused', run.errored(7), true);
check('the HTTP calls, in order', run.hits.map((h) => [h.method, h.path]), [
  ['GET', '/time-entries'], ['PATCH', '/time-entries/46906'], ['PATCH', '/time-entries/46906'], ['DELETE', '/time-entries/46906'], ['POST', '/timer/stop'],
]);
check('the edit body is only what changes', run.hits[1].body, { start: '08:30', end: '10:15' });
check('a null description is sent (it resets to the task title)', run.hits[2].body, { description: null });
has('the list prints one line per entry', run.text(0), '#46906 2026-10-16 06:00-07:30 UTC 1.5h | 00055 | task #5803 MCP QA');
has('the list says the times are UTC', run.text(0), 'Times are UTC');
has('the list ends with the page line', run.text(0), 'Page 1 of 1 (total 2)');
has('the update answers the entry line', run.text(1), 'Updated: #46906');
check('the delete answer', run.text(3), 'Deleted entry 46906: 2026-10-16 06:00-07:30 UTC, task #5803 MCP QA');
has('stop warns about a 2-second entry', run.text(4), 'This entry lasted 2 seconds. If it was a mistake, delete it with clokio_delete_time_entry id=46911.');
check('no request names an employee', run.hits.some((h) => h.body && ('employee_code' in h.body || 'employee_id' in h.body)), false);

const t = run.tools;
check('update is mutating, delete is destructive', [t.clokio_update_time_entry?.annotations?.readOnlyHint, t.clokio_delete_time_entry?.annotations?.destructiveHint], [false, true]);
has('update names the acting person', t.clokio_update_time_entry?.description ?? '', 'ACTING person');
has('update says a running entry takes no times', t.clokio_update_time_entry?.description ?? '', 'stop it before changing its times');
has('update says start/end are local', t.clokio_update_time_entry?.description ?? '', 'LOCAL');
has('delete says a running entry must be stopped first', t.clokio_delete_time_entry?.description ?? '', 'stopped first');

done();
