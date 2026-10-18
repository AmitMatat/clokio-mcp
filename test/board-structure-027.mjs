// 0.27.0: board structure and safety (backend task #5874 parts 4 and 5).
//   clokio_create_project_custom_field / clokio_update_project_custom_field
//   clokio_create_project_status / clokio_update_project_status
//   clokio_list_project_activity
//   clokio_update_task: parent_task_id, assignee_employee_codes + assignee_mode
//   clokio_bulk_update_tasks: estimated_hours
//   clokio_get_project_task_summary: group_by_custom_field
//   clokio_set_task_assignees: actor_employee_code
//
// Run by hand:  npm run build && node test/board-structure-027.mjs
import { checker, runTools } from './support/harness.mjs';
import { renderProjectActivity } from '../dist/tools/tasks.js';

const { check, has, done } = checker();

// ── the activity renderer, as a function ───────────────────────────────
const page = {
  data: [
    {
      id: 9,
      task: { id: 41, title: 'Fix\nlogin', deleted: false },
      action: 'status_changed',
      field: 'status',
      old_value: 'todo',
      new_value: 'done',
      employee: { employee_code: '00055', name: 'Amit', organization: null, external: false },
      created_at: '2026-10-19T10:00:00+03:00',
    },
    { id: 8, task: { id: 40, title: 'Gone', deleted: true }, action: 'deleted', field: null, old_value: 'Gone', new_value: null, employee: null, created_at: '2026-10-18T09:00:00+03:00' },
  ],
  meta: { project_id: 3, per_page: 2, next_cursor: 'abc_123', timezone: 'Asia/Jerusalem' },
};
const rendered = renderProjectActivity(page);
check('one line per row plus the cursor line', rendered.split('\n').length, 3);
has('a row names its task with a flattened title', rendered, 'task #41 "Fix login"');
has('a deleted task says so', rendered, 'task #40 "Gone" (deleted)');
has('the cursor is handed back', rendered, 'cursor="abc_123"');
has('the last page says so', renderProjectActivity({ data: [], meta: { next_cursor: null } }), 'End of the log');
has('an empty page says no activity', renderProjectActivity({ data: [], meta: {} }), 'No activity.');

// ── the tools over the wire ────────────────────────────────────────────
const OK = { json: { status: 'success', data: {}, meta: {} } };
const run = await runTools({
  toolsets: 'tasks',
  calls: [
    ['clokio_create_project_custom_field', { project_id: 3, name: 'Release', type: 'dropdown', options: [{ value: 'r1', label: '1.0' }] }], // 0
    ['clokio_create_project_custom_field', { project_id: 3, name: 'Release', type: 'dropdown' }], // 1 refused: no options
    ['clokio_create_project_custom_field', { project_id: 3, name: 'Note', type: 'text', options: [{ value: 'x' }] }], // 2 refused
    ['clokio_update_project_custom_field', { project_id: 3, field_key: 'release', options: [{ value: 'r1', label: '1.0' }, { value: 'r2', label: '2.0' }] }], // 3
    ['clokio_update_project_custom_field', { project_id: 3, field_key: 'release' }], // 4 refused: nothing to change
    ['clokio_update_project_custom_field', { project_id: 3, field_key: '../tasks/1', name: 'x' }], // 5 schema refuses the path
    ['clokio_create_project_status', { project_id: 3, name: 'Blocked', color: '#ff0000', position: 1 }], // 6
    ['clokio_update_project_status', { project_id: 3, slug: 'blocked', category: 'done' }], // 7
    ['clokio_update_project_status', { project_id: 3, slug: 'blocked' }], // 8 refused
    ['clokio_list_project_activity', { project_id: 3, since: '2026-10-01', action: ['status_changed', 'assigned'], per_page: 50 }], // 9
    ['clokio_update_task', { id: 7, parent_task_id: 12 }], // 10
    ['clokio_update_task', { id: 7, parent_task_id: null }], // 11
    ['clokio_update_task', { id: 7, assignee_employee_codes: ['00080', { employee_code: '00002', organization_id: 313 }], assignee_mode: 'add', due_date: '2026-12-01' }], // 12
    ['clokio_update_task', { id: 7, assignee_mode: 'add' }], // 13 refused
    ['clokio_bulk_update_tasks', { ids: [1, 2], estimated_hours: 4.5 }], // 14
    ['clokio_bulk_update_tasks', { ids: [1, 2], estimated_hours: null }], // 15 null clears, still a change
    ['clokio_bulk_update_tasks', { ids: [1], estimated_hours: 20000 }], // 16 schema refuses
    ['clokio_get_project_task_summary', { project_id: 3, group_by_custom_field: 'release' }], // 17
    ['clokio_set_task_assignees', { id: 7, employee_codes: ['00080'], mode: 'add', actor_employee_code: '00055' }], // 18
  ],
  respond: (hit) => (hit.path.endsWith('/activities') ? { json: { status: 'success', data: [], meta: { next_cursor: null } } } : OK),
});

check('create field: POST to the project', `${run.hits[0]?.method} ${run.hits[0]?.path}`, 'POST /projects/3/custom-fields');
check('create field: the body', run.hits[0]?.body, { name: 'Release', type: 'dropdown', options: [{ value: 'r1', label: '1.0' }] });
check('a dropdown without options errors locally', run.errored(1), true);
has('...in words', run.text(1), 'needs options');
check('a text field with options errors locally', run.errored(2), true);
check('update field: PATCH by field_key', `${run.hits[1]?.method} ${run.hits[1]?.path}`, 'PATCH /projects/3/custom-fields/release');
check('update field: the whole option list', run.hits[1]?.body?.options?.length, 2);
check('update field with nothing errors locally', run.errored(4), true);
check('a field_key that walks the path is refused', run.errored(5), true);
check('create status: POST', `${run.hits[2]?.method} ${run.hits[2]?.path}`, 'POST /projects/3/statuses');
check('create status: the body', run.hits[2]?.body, { name: 'Blocked', color: '#ff0000', position: 1 });
check('update status: PATCH by slug', `${run.hits[3]?.method} ${run.hits[3]?.path}`, 'PATCH /projects/3/statuses/blocked');
check('update status: only what was given', run.hits[3]?.body, { category: 'done' });
check('update status with nothing errors locally', run.errored(8), true);
check('activity: its route', `${run.hits[4]?.method} ${run.hits[4]?.path}`, 'GET /projects/3/activities');
has('activity: action goes out as action[]', run.hits[4]?.search, 'action%5B%5D=status_changed&action%5B%5D=assigned');
has('activity: since and per_page', run.hits[4]?.search, 'since=2026-10-01');
has('activity: the answer is rendered', run.text(9), 'End of the log');
check('re-parent sends parent_task_id', run.hits[5]?.body, { parent_task_id: 12 });
check('detach sends null', run.hits[6]?.body, { parent_task_id: null });
check('assignees in the update', run.hits[7]?.body, {
  due_date: '2026-12-01',
  assignee_employee_codes: ['00080', { employee_code: '00002', organization_id: 313 }],
  assignee_mode: 'add',
});
check('assignee_mode alone errors locally', run.errored(13), true);
check('bulk estimate', run.hits[8]?.body, { ids: [1, 2], estimated_hours: 4.5 });
check('bulk estimate null is a change', run.hits[9]?.body, { ids: [1, 2], estimated_hours: null });
check('an estimate over 9999.99 errors before any request', run.errored(16), true);
check('summary grouping', run.hits[10]?.query, { group_by_custom_field: 'release' });
check('set assignees credits the actor', run.hits[11]?.body, { employee_codes: ['00080'], mode: 'add', actor_employee_code: '00055' });
check('exactly twelve requests went out', run.hits.length, 12);

// ── the descriptions say what an agent needs ───────────────────────────
const tool = (n) => run.tools[n];
const prop = (n, key) => tool(n)?.inputSchema?.properties?.[key]?.description ?? '';
has('create field explains releases', tool('clokio_create_project_custom_field')?.description, 'A release or sprint is a dropdown field');
has('create field names the scope', tool('clokio_create_project_custom_field')?.description, 'projects:write');
has('update field says the whole list', tool('clokio_update_project_custom_field')?.description, 'WHOLE new list');
has('update field says removing a held option is refused', tool('clokio_update_project_custom_field')?.description, 'Removing an option tasks still hold is refused');
has('create status says active only', tool('clokio_create_project_status')?.description, 'always ACTIVE');
has('update status says no delete', tool('clokio_update_project_status')?.description, 'cannot be deleted');
has('update_task explains one level', tool('clokio_update_task')?.description, 'one level deep');
has('update_task says a refused person refuses the whole update', tool('clokio_update_task')?.description, 'nothing in the call is written');
has('summary grouping explains releases', prop('clokio_get_project_task_summary', 'group_by_custom_field'), 'what is in each');
has('activity says internal comments never appear', tool('clokio_list_project_activity')?.description, 'internal comments never do');
check('activity is read-only', tool('clokio_list_project_activity')?.annotations?.readOnlyHint, true);
check('the config writes are mutating', ['clokio_create_project_custom_field', 'clokio_update_project_custom_field', 'clokio_create_project_status', 'clokio_update_project_status'].map((n) => tool(n)?.annotations?.readOnlyHint), [false, false, false, false]);

done();
