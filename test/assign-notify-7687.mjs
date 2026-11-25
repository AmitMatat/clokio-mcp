// Task #7687: assigning through the API now notifies the people added or
// removed, as the web does; `notify: false` keeps a change silent.
//
// Run by hand:  npm run build && node test/assign-notify-7687.mjs
import { checker, runTools } from './support/harness.mjs';

const { check, done } = checker();

const run = await runTools({
  toolsets: 'tasks',
  calls: [
    ['clokio_set_task_assignees', { id: 1, employee_codes: ['00080'], mode: 'add' }],
    ['clokio_set_task_assignees', { id: 1, employee_codes: ['00080'], mode: 'add', notify: false }],
    ['clokio_create_task', { project_id: 9, title: 'Quiet', assignee_employee_codes: ['00080'], notify: false }],
    ['clokio_create_task', { project_id: 9, title: 'Loud', assignee_employee_codes: ['00080'] }],
    ['clokio_update_task', { id: 1, assignee_employee_codes: ['00080'], notify: false }],
    ['clokio_update_task', { id: 1, title: 'Renamed' }],
    ['clokio_update_task', { id: 1, notify: false }],
    ['clokio_update_task', { id: 1, title: 'Only a title', notify: false }],
    ['clokio_create_task', { project_id: 9, title: 'Nobody', notify: false }],
  ],
  respond: (hit) => (hit.method === 'POST' ? { status: 201, json: { status: 'success', data: { id: 5 } } } : undefined),
});

const body = (i) => run.hits.find((h) => h.callIndex === i)?.body ?? {};

check('set assignees: notify is not sent when omitted (the server notifies by default)', 'notify' in body(0), false);
check('set assignees: notify false is sent', body(1).notify, false);
check('create: notify false is sent', body(2).notify, false);
check('create: notify is not sent when omitted', 'notify' in body(3), false);
check('update: notify false is sent', body(4).notify, false);
check('update: notify is not sent when omitted', 'notify' in body(5), false);

check('update: notify alone is not a change (refused, nothing sent)', [run.errored(6), run.hits.filter((h) => h.callIndex === 6).length], [true, 0]);
check('update: notify without assignees is not sent (an older server refuses unknown keys)', 'notify' in body(7), false);
check('create: notify without assignees is not sent', 'notify' in body(8), false);

const desc = run.tools.clokio_set_task_assignees?.description ?? '';
check('the tool no longer says the API sends no notification', desc.includes('sends the assignee no notification'), false);
check('the tool says the people are notified', /notif/i.test(desc) && desc.includes('notify: false'), true);
for (const name of ['clokio_set_task_assignees', 'clokio_create_task', 'clokio_update_task']) {
  check(`${name} offers notify`, Boolean(run.tools[name]?.inputSchema?.properties?.notify), true);
}

done();
