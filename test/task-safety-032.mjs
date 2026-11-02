// 0.32.0: safe description edits, description history, comment delete, aliases,
// the inbox's field_changes, search_in and relevance.
//
// Run by hand:  npm run build && node test/task-safety-032.mjs
import { checker, runTools } from './support/harness.mjs';

const { check, has, done } = checker();

const OK = { json: { status: 'success', data: {} } };
const run = await runTools({
  toolsets: 'tasks,employees',
  calls: [
    ['clokio_update_task', { id: 5, description: 'plain', if_updated_at: '2026-11-02T18:02:09+02:00' }], // 0
    ['clokio_update_task', { id: 5, description_append: '**more**' }], // 1
    ['clokio_update_task', { id: 5, description_replace: { find: '<p>a</p>', replace: '<p>b</p>' } }], // 2
    ['clokio_update_task', { id: 5, title: 'Only a title' }], // 3
    ['clokio_update_task', { id: 5, if_updated_at: '2026-01-01' }], // 4 refused: nothing to change
    ['clokio_list_tasks', { search: 'goal', search_in: 'description', sort: 'relevance', fields: ['id', 'task_url'] }], // 5
    ['clokio_delete_task_comment', { id: 5, comment_id: 9 }], // 6
    ['clokio_list_task_description_versions', { id: 5 }], // 7
    ['clokio_get_task_description_version', { id: 5, version: 2 }], // 8
    ['clokio_restore_task_description_version', { id: 5, version: 2, if_updated_at: '2026-11-02T18:02:09+02:00' }], // 9
    ['clokio_restore_task_description_version', { id: 5, version: 2 }], // 10 schema refuses
    ['clokio_purge_task_description_versions', { id: 5, versions: [1, 2], from_version: 3, to_version: 4 }], // 11
    ['clokio_purge_task_description_versions', { id: 5 }], // 12 refused
    ['clokio_purge_task_description_versions', { id: 5, from_version: 3 }], // 13 refused
    ['clokio_set_project_aliases', { project_id: 7, aliases: ['שורש', 'Source'] }], // 14
    ['clokio_get_inbox', { employee_code: '00055', field_changes_limit: 10 }], // 15
    ['clokio_list_projects', { search: 'the store' }], // 16
  ],
  respond: () => OK,
});

const req = (method, path, n = 0) => run.hits.filter((h) => h.method === method && h.path === path)[n];
const update = (n) => req('PATCH', '/tasks/5', n);

check('whole description with the guard', [update(0).body.description, update(0).body.if_updated_at], ['<p>plain</p>', '2026-11-02T18:02:09+02:00']);
has('append is converted from Markdown', update(1).body.description_append, '<strong>more</strong>');
check('replace is sent as written', update(2).body.description_replace, { find: '<p>a</p>', replace: '<p>b</p>' });
check('a call without the new fields sends none of them', Object.keys(update(3).body).filter((k) => k.startsWith('description') || k === 'if_updated_at'), []);
has('if_updated_at alone is nothing to change', run.text(4), 'Nothing to change');
check('no request for that', run.hits.filter((h) => h.method === 'PATCH').length, 4);

const list = req('GET', '/tasks');
check('list query', [list.query.search_in, list.query.sort, list.query.fields], ['description', 'relevance', 'id,task_url']);

check('delete comment', !!req('DELETE', '/tasks/5/comments/9'), true);
check('list versions', !!req('GET', '/tasks/5/description-versions'), true);
check('one version', !!req('GET', '/tasks/5/description-versions/2'), true);
const restores = run.hits.filter((h) => h.path === '/tasks/5/description-versions/2/restore');
check('restore without the guard is refused before any request', restores.length, 1);
check('restore carries the guard', [restores[0].method, restores[0].body.if_updated_at], ['POST', '2026-11-02T18:02:09+02:00']);
const purges = run.hits.filter((h) => h.path === '/tasks/5/description-versions/purge');
check('only the complete purge is sent', purges.length, 1);
check('purge body', purges[0].body, { versions: [1, 2], from_version: 3, to_version: 4 });
has('purge needs versions', run.text(12), 'Name the versions');
has('a half range is refused', run.text(13), 'go together');
check('aliases', req('PUT', '/projects/7/aliases').body, { aliases: ['שורש', 'Source'] });
check('inbox limit', req('GET', '/employees/00055/inbox').query.field_changes_limit, '10');
check('project search is passed as typed', req('GET', '/projects').query.search, 'the store');

for (const name of ['clokio_delete_task_comment', 'clokio_purge_task_description_versions']) {
  check(`${name} is destructive`, run.tools[name].annotations.destructiveHint, true);
  has(`${name} warns that sent text cannot be recalled`, run.tools[name].description, 'must still be changed');
}
has('update tells agents to read first', run.tools.clokio_update_task.description, 'read the task with clokio_get_task right before editing');
has('update tells agents not to retry without the guard', run.tools.clokio_update_task.description, 'do not resend without if_updated_at');
check('reads are read-only', run.tools.clokio_list_task_description_versions.annotations.readOnlyHint, true);

done();
