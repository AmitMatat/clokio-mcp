// Custom fields by label, in update and in bulk (backend task #5874 part 2).
//   - clokio_set_task_custom_field: says a value may be the option label,
//     takes null (clear) and actor_employee_code.
//   - clokio_update_task: custom_fields rides in the same PATCH body.
//   - clokio_bulk_set_task_custom_field: PATCH /tasks/bulk/custom-fields with
//     ids + custom_fields; the partial-success answer is passed through.
//
// Run by hand:  npm run build && node test/custom-fields-5874.mjs
import { checker, runTools } from './support/harness.mjs';

const { check, has, done } = checker();
const OK = (data) => ({ status: 200, json: { status: 'success', message: 'ok', data } });

const BULK = {
  updated: 1,
  not_found: [1240],
  field_not_on_project: [1235],
  invalid_value: [],
  errors: { 1235: { client_po: 'No custom field with key "client_po" on this task\'s project.' } },
};

const r = await runTools({
  toolsets: 'tasks',
  calls: [
    ['clokio_set_task_custom_field', { id: 5, field_key: 'stage', value: 'In build' }],
    ['clokio_set_task_custom_field', { id: 5, field_key: 'stage', value: null, actor_employee_code: '00777' }],
    ['clokio_update_task', { id: 6, title: 'New', custom_fields: { stage: 'Design', client_po: 'PO-9', approved: false } }],
    ['clokio_update_task', { id: 7, title: 'No fields' }],
    ['clokio_bulk_set_task_custom_field', { ids: [1234, 1235, 1240], custom_fields: { stage: 'In build', client_po: 'PO-4471' }, actor_employee_code: '00778' }],
    ['clokio_bulk_set_task_custom_field', { ids: [1], custom_fields: {} }],
    ['clokio_bulk_set_task_custom_field', { ids: [], custom_fields: { a: 1 } }],
  ],
  respond: (hit) => (hit.path === '/tasks/bulk/custom-fields' ? OK(BULK) : OK({ id: 5 })),
});

// Descriptions tell the model what the server now accepts.
has('set: the description names the option label', r.tools.clokio_set_task_custom_field?.description, 'OR its label as shown on screen');
has('set: the description says null clears', r.tools.clokio_set_task_custom_field?.description, 'null clears');
has('update: the description names custom_fields', r.tools.clokio_update_task?.description, '`custom_fields` (object field_key -> value)');
has('bulk: the description names the buckets', r.tools.clokio_bulk_set_task_custom_field?.description, 'field_not_on_project');
check('bulk: the tool is in the tasks toolset', Boolean(r.tools.clokio_bulk_set_task_custom_field), true);

// clokio_set_task_custom_field
check('set: PATCH /tasks/5/custom-fields with the label as sent', [r.hits[0].method, r.hits[0].path, r.hits[0].body], ['PATCH', '/tasks/5/custom-fields', { field_key: 'stage', value: 'In build' }]);
check('set: null is sent (clears) with the actor', r.hits[1].body, { field_key: 'stage', value: null, actor_employee_code: '00777' });

// clokio_update_task
check('update: custom_fields rides in the same body', r.hits[2].body, { title: 'New', custom_fields: { stage: 'Design', client_po: 'PO-9', approved: false } });
check('update: no custom_fields key when not given', 'custom_fields' in (r.hits[3].body ?? {}), false);

// clokio_bulk_set_task_custom_field
check('bulk: PATCH /tasks/bulk/custom-fields', [r.hits[4].method, r.hits[4].path], ['PATCH', '/tasks/bulk/custom-fields']);
check('bulk: ids, custom_fields and the actor in the body', r.hits[4].body, { ids: [1234, 1235, 1240], custom_fields: { stage: 'In build', client_po: 'PO-4471' }, actor_employee_code: '00778' });
has('bulk: the partial-success answer reaches the model', r.text(4), 'field_not_on_project');
check('bulk: an empty custom_fields is refused before any request', r.errored(5), true);
check('bulk: no ids is refused before any request', r.errored(6), true);
check('only the five valid calls reached the server', r.hits.length, 5);

done();
