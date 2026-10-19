// 0.27.1 (Clokio task #5874 QA round 1, owner rulings 2026-10-19): delete a
// project status (move_to for its tasks) and a project custom field, and
// `fields` on clokio_list_tasks.
//
// Break-verified 2026-10-19: the handler's `move_to === slug` refusal removed
// -> "move_to equal to slug is refused" fails (the request goes out); the
// `fields` join removed (sent as an array) -> "fields goes out as a comma
// list" fails; `mutates: 'destructive'` on the field delete set to true ->
// "the field delete is marked destructive" fails.
//
// Run by hand:  npm run build && node test/qa-0271.mjs
import { checker, runTools } from './support/harness.mjs';
import { TASK_LIST_FIELDS } from '../dist/tools/tasks.js';

const { check, has, done } = checker();

check('the selectable keys are the backend list', [...TASK_LIST_FIELDS], [
  'id', 'title', 'status', 'priority', 'due_date', 'parent_id', 'project_id',
  'assignee_codes', 'external_assignees', 'labels', 'updated_at', 'custom_fields',
]);

const run = await runTools({
  toolsets: 'tasks',
  calls: [
    ['clokio_delete_project_status', { project_id: 3, slug: 'review', move_to: 'todo', actor_employee_code: '00055' }], // 0 ok
    ['clokio_delete_project_status', { project_id: 3, slug: 'review' }], // 1 ok, no body keys
    ['clokio_delete_project_status', { project_id: 3, slug: 'review', move_to: 'review' }], // 2 refused
    ['clokio_delete_project_status', { project_id: 3, slug: '../x' }], // 3 refused
    ['clokio_delete_project_custom_field', { project_id: 3, field_key: 'client_po' }], // 4 ok
    ['clokio_delete_project_custom_field', { project_id: 3, field_key: 'a/b' }], // 5 refused
    ['clokio_list_tasks', { project_id: 3, fields: ['id', 'title', 'status', 'title'] }], // 6 ok
    ['clokio_list_tasks', { fields: ['id', 'description'] }], // 7 refused
    ['clokio_list_tasks', { fields: [] }], // 8 refused
  ],
});

check('delete status: method', run.hits[0]?.method, 'DELETE');
check('delete status: path', run.hits[0]?.path, '/projects/3/statuses/review');
check('delete status: body', run.hits[0]?.body, { move_to: 'todo', actor_employee_code: '00055' });
check('delete status without move_to sends an empty body', run.hits[1]?.body, {});
check('move_to equal to slug is refused', run.errored(2), true);
check('a path-like slug is refused', run.errored(3), true);
check('delete field: path', run.hits[2]?.path, '/projects/3/custom-fields/client_po');
check('delete field: method', run.hits[2]?.method, 'DELETE');
check('a bad field_key is refused', run.errored(5), true);
check('fields goes out as a comma list, duplicates once', run.hits[3]?.query?.fields, 'id,title,status');
check('an unknown field name is refused', run.errored(7), true);
check('an empty fields list is refused', run.errored(8), true);
check('exactly four requests went out', run.hits.length, 4);

check('the field delete is marked destructive', run.tools.clokio_delete_project_custom_field?.annotations?.destructiveHint, true);
check('the status delete is marked destructive', run.tools.clokio_delete_project_status?.annotations?.destructiveHint, true);
has('the status delete says tasks move', run.tools.clokio_delete_project_status?.description, 'move_to is REQUIRED');
has('the field delete says values go too', run.tools.clokio_delete_project_custom_field?.description, 'TOGETHER WITH every value stored');
has('the status editor points at the delete', run.tools.clokio_update_project_status?.description, 'clokio_delete_project_status');
has('list_tasks describes fields', run.tools.clokio_list_tasks?.inputSchema?.properties?.fields?.description, 'implies compact');

done();
