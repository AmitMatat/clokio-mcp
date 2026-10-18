// 0.27.0 final review (2026-10-19, C1): every field_key input takes the
// backend's own key rule (/^[A-Za-z0-9_-]{1,50}$/, the route constraint on
// {fieldKey}), and estimated_hours is 0-9999.99 everywhere (the backend's
// one ESTIMATED_HOURS_MAX for create, update and bulk).
//
// Break-verified 2026-10-19: the custom_field filter keys back to
// z.string().min(1).max(50) alone stays green (listFilterQuery() refuses
// the key too: covered twice); with listFilterQuery()'s check removed as
// well, "a filter key with ] is refused" fails (the request goes out). The
// bulk max back to 10000 -> "a bulk estimate of 10000 is refused" fails.
//
// Run by hand:  npm run build && node test/final-review-027.mjs
import { checker, runTools } from './support/harness.mjs';
import { ESTIMATED_HOURS_MAX, FIELD_KEY_PATTERN, listFilterQuery } from '../dist/tools/tasks.js';

const { check, has, done } = checker();

check('the key rule is the backend route rule', String(FIELD_KEY_PATTERN), String(/^[A-Za-z0-9_-]{1,50}$/));
check('one estimate ceiling', ESTIMATED_HOURS_MAX, 9999.99);

let thrown = '';
try {
  listFilterQuery({ project_id: 3, custom_field: { 'a]b': 'x' } });
} catch (e) {
  thrown = String(e.message);
}
has('listFilterQuery refuses a key that would break the query string', thrown, 'is not a field_key');
check('listFilterQuery keeps a good key', listFilterQuery({ project_id: 3, custom_field: { sprint_3: 'x' } })['custom_field[sprint_3]'], 'x');

const run = await runTools({
  toolsets: 'tasks',
  calls: [
    ['clokio_list_tasks', { project_id: 3, custom_field: { 'a]b': 'x' } }], // 0 refused
    ['clokio_list_tasks', { project_id: 3, custom_field: { 'x&y=1': 'x' } }], // 1 refused
    ['clokio_list_tasks', { project_id: 3, custom_field: { 'release-2': 'r1' } }], // 2 ok
    ['clokio_set_task_custom_field', { id: 7, field_key: 'a b', value: 'x' }], // 3 refused
    ['clokio_update_task', { id: 7, custom_fields: { 'bad/key': 'x' } }], // 4 refused
    ['clokio_get_project_task_summary', { project_id: 3, group_by_custom_field: '../x' }], // 5 refused
    ['clokio_bulk_update_tasks', { ids: [1], estimated_hours: 10000 }], // 6 refused
    ['clokio_bulk_update_tasks', { ids: [1], estimated_hours: 9999.99 }], // 7 ok
    ['clokio_create_task', { project_id: 3, title: 'Big', estimated_hours: 10000 }], // 8 refused
    ['clokio_update_task', { id: 7, estimated_hours: 10000 }], // 9 refused
    ['clokio_set_task_custom_field', { id: 7, field_key: 'client_po', value: 'PO-1' }], // 10 ok
  ],
});

check('a filter key with ] is refused', run.errored(0), true);
check('a filter key with & and = is refused', run.errored(1), true);
check('a good filter key goes out', run.hits[0]?.query?.['custom_field[release-2]'], 'r1');
check('set custom field: a key with a space is refused', run.errored(3), true);
check('update custom_fields: a key with a slash is refused', run.errored(4), true);
check('summary grouping: a path-like key is refused', run.errored(5), true);
check('a bulk estimate of 10000 is refused', run.errored(6), true);
check('a bulk estimate of 9999.99 goes out', run.hits[1]?.body, { ids: [1], estimated_hours: 9999.99 });
check('create: 10000 is refused', run.errored(8), true);
check('update: 10000 is refused', run.errored(9), true);
check('set custom field: a good key goes out', run.hits[2]?.body?.field_key, 'client_po');
check('exactly three requests went out', run.hits.length, 3);
has('bulk says 9999.99', run.tools.clokio_bulk_update_tasks?.description, '0-9999.99');
has('update_task says how a subtask moves', run.tools.clokio_update_task?.inputSchema?.properties?.project_id?.description, 'parent_task_id: null');

done();
