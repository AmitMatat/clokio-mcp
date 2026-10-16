// 0.20.0, shared boards (Clokio spec 2026-10-16): the people tool calls the
// people route, both assignee writes forward strings AND {employee_code,
// organization_id} objects untouched, and the item schema refuses an
// organisation CODE (D6: the numeric id only).
//
// Run by hand after `npm run build`:  node test/shared-board-people.mjs
import { createServer } from 'node:http';
import { once } from 'node:events';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(got)}`);
};

const captured = [];
const srv = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    captured.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: { id: 1 } }));
  });
});
srv.listen(0, '127.0.0.1');
await once(srv, 'listening');

process.env.CLOKIO_API_KEY = 'clk_x';
process.env.CLOKIO_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
delete process.env.CLOKIO_DEFAULT_ACTOR;
const { loadConfig } = await import('../dist/client.js');
const cfg = loadConfig();

const tools = {};
const stubServer = { registerTool: (name, _def, cb) => { tools[name] = cb; } };
const { registerTaskTools, assigneeReference } = await import('../dist/tools/tasks.js');
registerTaskTools(stubServer, cfg);

await tools.clokio_list_project_people({ project_id: 1995 });
check('the people tool calls GET /projects/{id}/people', `${captured.at(-1).method} ${captured.at(-1).url}`, 'GET /api/v1/projects/1995/people');

const mixed = ['00080', { employee_code: '00002', organization_id: 313 }];
await tools.clokio_set_task_assignees({ id: 5781, mode: 'add', employee_codes: mixed });
check('set_task_assignees forwards strings and objects as given', captured.at(-1).body.employee_codes, mixed);

await tools.clokio_create_task({ project_id: 1995, title: 'x', assignee_employee_codes: mixed });
check('create_task forwards strings and objects as given', captured.at(-1).body.assignee_employee_codes, mixed);

check('a bare code is accepted', assigneeReference.safeParse('00002').success, true);
check('an object is accepted', assigneeReference.safeParse({ employee_code: '00002', organization_id: 313 }).success, true);
check('an organisation CODE is refused', assigneeReference.safeParse({ employee_code: '00002', organization_id: 'ABC' }).success, false);
check('a missing organization_id is refused', assigneeReference.safeParse({ employee_code: '00002' }).success, false);
check('an extra key is refused', assigneeReference.safeParse({ employee_code: '00002', organization_id: 313, name: 'x' }).success, false);
check('organization_id 0 is refused', assigneeReference.safeParse({ employee_code: '00002', organization_id: 0 }).success, false);

srv.close();
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
