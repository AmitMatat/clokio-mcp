// 0.39.0: the task sub-resource tools and the ticket attachment tool take their
// task / ticket as `id` OR as `task_id` / `ticket_id` (one shared helper,
// withIdAlias). Either is accepted, exactly one is required, both given and
// different is a clear error, both equal is fine; `id` keeps working, and the
// alias is never sent on in a body.
//
// Run by hand:  npm run build && node test/id-alias-039.mjs
import { checker, runTools } from './support/harness.mjs';

const { check, has, done } = checker();

const TASK_TOOLS = [
  'clokio_set_task_assignees', 'clokio_list_task_comments', 'clokio_add_task_comment', 'clokio_update_task_comment',
  'clokio_delete_task_comment', 'clokio_list_task_description_versions', 'clokio_get_task_description_version',
  'clokio_restore_task_description_version', 'clokio_purge_task_description_versions', 'clokio_list_task_attachments',
  'clokio_download_task_attachment', 'clokio_download_task_media', 'clokio_download_task_attachments',
  'clokio_upload_task_attachment', 'clokio_upload_task_media', 'clokio_get_task_activity', 'clokio_list_task_dependencies',
  'clokio_add_task_dependency', 'clokio_remove_task_dependency', 'clokio_set_task_custom_field',
];

const run = await runTools({
  toolsets: 'tasks,tickets',
  calls: [
    ['clokio_list_task_comments', { id: 12 }], // 0 id still works
    ['clokio_list_task_comments', { task_id: 13 }], // 1 alias
    ['clokio_list_task_comments', { id: 14, task_id: 14 }], // 2 both, same
    ['clokio_list_task_comments', { id: 14, task_id: 15 }], // 3 both, different: refused
    ['clokio_list_task_comments', {}], // 4 neither: refused
    ['clokio_add_task_comment', { task_id: 16, body: 'hello' }], // 5 alias on a write
    ['clokio_add_task_dependency', { task_id: 17, depends_on_task_id: 18 }], // 6 alias, body has no task_id
    ['clokio_remove_task_dependency', { task_id: 19, dependency_id: 3 }], // 7
    ['clokio_get_task_activity', { task_id: 20, per_page: 5 }], // 8
    ['clokio_set_task_custom_field', { task_id: 21, field_key: 'k', value: 'v' }], // 9
    ['clokio_get_task_description_version', { task_id: 22, version: 2 }], // 10
    ['clokio_download_ticket_attachment', { ticket_id: 30, attachment_id: 4 }], // 11 ticket alias
    ['clokio_download_ticket_attachment', { id: 31, attachment_id: 4 }], // 12 ticket id still works
    ['clokio_download_ticket_attachment', { id: 31, ticket_id: 32, attachment_id: 4 }], // 13 different: refused
    ['clokio_download_ticket_attachment', { attachment_id: 4 }], // 14 neither: refused
    ['clokio_download_ticket_attachment', { ticket_id: 0, attachment_id: 4 }], // 15 ticket ids stay positive
  ],
  respond: (hit) => {
    if (hit.path.endsWith('/attachments/4')) return { status: 200, bytes: Buffer.from('hi'), headers: { 'content-type': 'text/plain' } };
    return undefined;
  },
});

const h = run.hits;
const find = (method, path) => h.find((x) => x.method === method && x.path === path);

check('every task sub-resource tool is registered', TASK_TOOLS.every((n) => run.tools[n]), true);
check('every one lists both id and task_id', TASK_TOOLS.every((n) => run.tools[n].inputSchema.properties.id && run.tools[n].inputSchema.properties.task_id), true);
check('neither is marked required in the schema (the handler requires one)', TASK_TOOLS.some((n) => (run.tools[n].inputSchema.required ?? []).some((r) => r === 'id' || r === 'task_id')), false);
check('the ticket attachment tool lists id and ticket_id', Boolean(run.tools.clokio_download_ticket_attachment.inputSchema.properties.ticket_id), true);

check('id still works', Boolean(find('GET', '/tasks/12/comments')), true);
check('task_id works', Boolean(find('GET', '/tasks/13/comments')), true);
check('both equal works', Boolean(find('GET', '/tasks/14/comments')), true);
check('both different is an error', run.errored(3), true);
has('both different names both values', run.text(3), 'id (14) and task_id (15)');
check('neither is an error', run.errored(4), true);
has('neither says one is required', run.text(4), 'id or task_id');
check('no request for the refused calls', [find('GET', '/tasks/15/comments'), h.filter((x) => x.path === '/tasks/14/comments').length], [undefined, 1]);

check('comment via task_id', [find('POST', '/tasks/16/comments')?.body?.body], ['<p>hello</p>']);
check('dependency via task_id, no task_id in the body', find('POST', '/tasks/17/dependencies')?.body, { depends_on_task_id: 18 });
check('remove dependency via task_id', Boolean(find('DELETE', '/tasks/19/dependencies/3')), true);
check('activity via task_id keeps its query', find('GET', '/tasks/20/activity')?.search, '?per_page=5');
check('custom field via task_id, body without task_id', find('PATCH', '/tasks/21/custom-fields')?.body, { field_key: 'k', value: 'v' });
check('description version via task_id', Boolean(find('GET', '/tasks/22/description-versions/2')), true);

check('ticket attachment via ticket_id', Boolean(find('GET', '/tickets/30/attachments/4')), true);
check('ticket attachment via id', Boolean(find('GET', '/tickets/31/attachments/4')), true);
check('ticket ids different: error', run.errored(13), true);
has('ticket ids different: named', run.text(13), 'id (31) and ticket_id (32)');
check('ticket neither: error', run.errored(14), true);
check('ticket_id 0 is refused', run.errored(15), true);
check('total requests: the valid calls only', h.length, 11);

// Employee mode shares the helper.
const me = { employee_code: '00081', name: 'A', organization: { id: 1, name: 'M' }, key: { name: 'L', expires_at: null } };
const emp = await runTools({
  env: { CLOKIO_API_KEY: undefined, CLOKIO_EMPLOYEE_KEY: 'ek_test' },
  calls: [
    ['clokio_add_task_comment', { task_id: 40, body: 'x' }], // 0
    ['clokio_log_time', { task_id: 41, started_at: '2026-10-26T09:00:00+05:45', ended_at: '2026-10-26T10:00:00+05:45' }], // 1
    ['clokio_add_task_comment', { id: 42, task_id: 43, body: 'x' }], // 2
  ],
  respond: (hit) => (hit.path === '/me' ? { status: 200, json: { status: 'success', message: 'ok', data: me } } : undefined),
});
const eh = emp.hits;
check('employee comment via task_id', Boolean(eh.find((x) => x.method === 'POST' && x.path === '/tasks/40/comments')), true);
check('employee log_time via task_id, body without id or task_id', eh.find((x) => x.method === 'POST' && x.path === '/tasks/41/time')?.body, { started_at: '2026-10-26T09:00:00+05:45', ended_at: '2026-10-26T10:00:00+05:45' });
check('employee different ids: error', emp.errored(2), true);

done();
