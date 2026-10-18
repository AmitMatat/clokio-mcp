// 0.27.0: list filters and the project task summary (backend task #5874 part 3).
//   clokio_list_tasks              no_due_date, no_assignee, custom_field, search_in, updated_before
//   clokio_get_project_task_summary  GET /projects/{projectId}/task-summary
//
// Run by hand:  npm run build && node test/list-filters-027.mjs
import { checker, runTools } from './support/harness.mjs';
import { listFilterQuery } from '../dist/tools/tasks.js';

const { check, has, done } = checker();

// ── the client-side refusals and the query shape, as a function ────────
const threw = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return String(e.message);
  }
};
has('no_due_date with due_before is refused', threw(() => listFilterQuery({ no_due_date: true, due_before: '2026-12-01' })), 'cannot be combined with due_before');
has('no_due_date with due_after is refused', threw(() => listFilterQuery({ no_due_date: true, due_after: '2026-01-01' })), 'cannot be combined');
check('no_due_date=false with a window is fine', threw(() => listFilterQuery({ no_due_date: false, due_before: '2026-12-01' })), null);
has('no_assignee with an assignee is refused', threw(() => listFilterQuery({ no_assignee: true, assignee_employee_code: '00017' })), 'cannot be combined with assignee_employee_code');
has('custom_field without project_id is refused', threw(() => listFilterQuery({ custom_field: { stage: 'Design' } })), 'need project_id');
check(
  'custom_field is spread into bracket keys, a boolean as 1/0',
  listFilterQuery({ project_id: 3, custom_field: { stage: 'In build', escalated: true, done_check: false, hours: 12.5 } }),
  {
    no_due_date: undefined,
    no_assignee: undefined,
    search_in: undefined,
    updated_before: undefined,
    'custom_field[stage]': 'In build',
    'custom_field[escalated]': 1,
    'custom_field[done_check]': 0,
    'custom_field[hours]': 12.5,
  },
);

// ── the tools over the wire ────────────────────────────────────────────
const OK = { json: { status: 'success', data: [], meta: { total: 0, per_page: 25, next_cursor: null } } };
const run = await runTools({
  toolsets: 'tasks',
  calls: [
    ['clokio_list_tasks', { project_id: 3, no_due_date: true, no_assignee: false, search: 'invoice', search_in: 'title', updated_before: '2026-10-01' }], // 0
    ['clokio_list_tasks', { project_id: 3, custom_field: { stage: 'In build', escalated: true } }], // 1
    ['clokio_list_tasks', { custom_field: { stage: 'x' } }], // 2 refused: no project_id
    ['clokio_list_tasks', { no_due_date: true, due_after: '2026-01-01' }], // 3 refused
    ['clokio_list_tasks', { no_assignee: true, assignee_employee_code: '00017' }], // 4 refused
    ['clokio_list_tasks', { project_id: 3, search_in: 'body' }], // 5 schema refuses
    ['clokio_list_tasks', { project_id: 3, custom_field: {} }], // 6 schema refuses an empty object
    ['clokio_get_project_task_summary', { project_id: 9 }], // 7
    ['clokio_get_project_task_summary', { project_id: 9, include_closed: true, top_level: false, stale_days: 30 }], // 8
    ['clokio_get_project_task_summary', { project_id: 9, stale_days: 400 }], // 9 schema refuses
    ['clokio_list_tasks', { project_id: 3 }], // 10 no new key sent
  ],
  respond: () => OK,
});

check('a plain list sends the five new keys', run.hits[0]?.query, {
  no_due_date: '1',
  no_assignee: '0',
  search_in: 'title',
  updated_before: '2026-10-01',
  project_id: '3',
  search: 'invoice',
});
check('custom_field goes out as bracket keys', run.hits[1]?.query, {
  'custom_field[stage]': 'In build',
  'custom_field[escalated]': '1',
  project_id: '3',
});
check('custom_field without project_id errors', run.errored(2), true);
has('...in words', run.text(2), 'need project_id');
check('no_due_date with a window errors', run.errored(3), true);
check('no_assignee with an assignee errors', run.errored(4), true);
check('an unknown search_in errors', run.errored(5), true);
check('an empty custom_field errors', run.errored(6), true);
check('the summary calls its route', `${run.hits[2]?.method} ${run.hits[2]?.path}`, 'GET /projects/9/task-summary');
check('the summary sends no parameter it was not given', run.hits[2]?.query, {});
check('the summary sends its three parameters', run.hits[3]?.query, { include_closed: '1', top_level: '0', stale_days: '30' });
check('stale_days over 365 errors before any request', run.errored(9), true);
check('a list without the new filters sends none of them', run.hits[4]?.query, { project_id: '3' });
check('exactly five requests went out (2-6 and 9 refused locally)', run.hits.length, 5);

// ── the descriptions say what an agent needs ───────────────────────────
const list = run.tools['clokio_list_tasks'];
const summary = run.tools['clokio_get_project_task_summary'];
const prop = (tool, key) => tool?.inputSchema?.properties?.[key]?.description ?? '';
has('custom_field names project_id', prop(list, 'custom_field'), 'REQUIRES project_id');
has('custom_field explains the label rule', prop(list, 'custom_field'), 'option value or its label');
has('custom_field explains multi-select', prop(list, 'custom_field'), 'CONTAINS');
has('no_assignee explains client people', prop(list, 'no_assignee'), 'client person');
has('search_in names the default', prop(list, 'search_in'), 'the default');
has('the list points at the summary', list?.description, 'clokio_get_project_task_summary');
has('the summary explains the per-assignee count', summary?.description, 'for EACH of them');
has('the summary says open only by default', summary?.description, 'OPEN tasks only unless include_closed');
check('the summary is read-only', summary?.annotations?.readOnlyHint, true);

done();
