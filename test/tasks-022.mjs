// 0.22.0 task tools: set_task_assignees answers only id, link and people (#5);
// get_task_activity names each person's organisation and pages (#4).
//
// Run by hand:  npm run build && node test/tasks-022.mjs
import { checker, runTools } from './support/harness.mjs';
import { compactAssignees, activityActor } from '../dist/tools/tasks.js';

const { check, has, done } = checker();

const DANA = { employee_code: '00031', name: 'Dana', organization: { id: 1, name: 'Matat' }, external: false };
const GUEST = { employee_code: '00007', name: 'Lior', organization: { id: 9, name: 'Acme' }, external: true };
const HIDDEN = { employee_code: '00099', name: 'Sam', organization: null, external: true };

check('the compact answer', compactAssignees(5803, { id: 5803, title: 'x', description: 'long', task_url: 'https://app.example/tasks/5803/view', assignees: [DANA, GUEST], external_assignees: [{ employee_code: '00007', organization_id: 9 }] }), {
  id: 5803, task_url: 'https://app.example/tasks/5803/view', assignees: [DANA, GUEST], external_assignees: [{ employee_code: '00007', organization_id: 9 }],
});
check('a missing task_url falls back to the app link', compactAssignees(12, { assignees: [] }).task_url, 'https://app.clokio.io/tasks/12/view');
check('external_assignees derived from external people when absent', compactAssignees(12, { assignees: [DANA, GUEST, HIDDEN] }).external_assignees, [{ employee_code: '00007', organization_id: 9 }, { employee_code: '00099', organization_id: null }]);
check('an own actor', activityActor(DANA), 'Dana (00031, Matat)');
check('an external actor', activityActor(GUEST), 'Lior (00007, Acme, external)');
check('an external actor whose organisation is hidden', activityActor(HIDDEN), 'Sam (00099, external)');
check('a system row', activityActor(null), 'system');

const run = await runTools({
  toolsets: 'tasks',
  calls: [
    ['clokio_set_task_assignees', { id: 5803, employee_codes: ['00031'], mode: 'add' }],
    ['clokio_get_task_activity', { id: 5803, from: '2026-10-01', per_page: 10, page: 2 }],
  ],
  respond: (hit) => {
    if (hit.method === 'PATCH') return { json: { status: 'success', data: { id: 5803, title: 'Big task', description: 'x'.repeat(5000), task_url: 'https://app.example/tasks/5803/view', assignees: [DANA] } } };
    if (hit.path === '/tasks/5803/activity') return { json: { status: 'success', data: [{ id: 1, action: 'status_changed', field: 'status', old_value: 'todo', new_value: 'done', employee: GUEST, created_at: '2026-10-16T08:00:00+03:00' }], meta: { current_page: 2, last_page: 3, per_page: 10, total: 21 } } };
    return undefined;
  },
});

check('both calls succeed', [run.errored(0), run.errored(1)], [false, false]);
check('the assignees answer drops the task body', run.text(0).includes('xxxxxxxxxx'), false);
has('the assignees answer keeps the link', run.text(0), 'https://app.example/tasks/5803/view');
check('activity query', run.hits[1].query, { from: '2026-10-01', per_page: '10', page: '2' });
has('activity names the organisation and external', run.text(1), 'Lior (00007, Acme, external): status_changed status (todo -> done)');
has('activity says how to page', run.text(1), 'Page 2 of 3 (total 21)');

done();
