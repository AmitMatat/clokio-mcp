// Employee mode: CLOKIO_EMPLOYEE_KEY instead of CLOKIO_API_KEY.
//
// An admin's clk_ key reaches the whole organisation. A personal X-Employee-Key
// reaches exactly what that person may do in Clokio - their roles and project
// permissions, judged by the server on every call - and any employee can issue
// one from their own profile. This run proves the server, given only an
// employee key, talks to /api/employee with X-Employee-Key, registers only the
// tools that surface supports, names nobody but the key's own employee, and
// says who it is acting as at startup.
//
// Run by hand:  node test/employee-mode.mjs   (after npm run build)
import { spawnSync } from 'node:child_process';
import { checker, runTools } from './support/harness.mjs';

const { check, has, done } = checker();

const me = { employee_code: '00081', name: 'Anil Pujara', organization: { id: 1, name: 'Matat' }, key: { name: 'Laptop', expires_at: null } };
const employeeEnv = { CLOKIO_API_KEY: undefined, CLOKIO_EMPLOYEE_KEY: 'ek_test' };

const r = await runTools({
  env: employeeEnv,
  calls: [
    ['clokio_whoami', {}],
    ['clokio_list_tasks', { status: 'todo', limit: 5 }],
    ['clokio_create_task', { project_id: 7, title: 'From a colleague', description: '**Bold** and a list:\n- one' }],
    ['clokio_add_task_comment', { id: 12, body: '@Kamal Raj Silwal done, see `x`' }],
    ['clokio_update_task', { id: 12, status: 'done' }],
    ['clokio_log_time', { id: 12, started_at: '2026-10-26T09:00:00+05:45', ended_at: '2026-10-26T10:30:00+05:45' }],
    ['clokio_create_doc', { title: 'Notes', content: '# Hi' }],
  ],
  respond: (hit) => (hit.path === '/me' ? { status: 200, json: { status: 'success', data: me } } : undefined),
});

const names = Object.keys(r.tools);
check('employee mode registers tools', names.length > 0, true);
for (const n of ['clokio_whoami', 'clokio_list_projects', 'clokio_list_tasks', 'clokio_get_task', 'clokio_create_task', 'clokio_update_task', 'clokio_add_task_comment', 'clokio_upload_task_attachment', 'clokio_download_task_attachment', 'clokio_log_time', 'clokio_list_docs', 'clokio_create_doc', 'clokio_add_doc_comment']) {
  check(`employee mode has ${n}`, names.includes(n), true);
}
for (const n of ['clokio_list_employees', 'clokio_set_task_assignees', 'clokio_delete_task', 'clokio_bulk_update_tasks', 'clokio_clock_in', 'clokio_list_tickets', 'clokio_create_employee', 'clokio_list_task_comments']) {
  check(`employee mode does NOT offer ${n}`, names.includes(n), false);
}
check('no employee-mode tool takes an employee_code to credit a writer', names.filter((n) => JSON.stringify(r.tools[n].inputSchema).match(/(author|created_by|actor|uploaded_by)_employee_code/)), []);

const apiHits = r.hits.filter((h) => h.path !== '/me');
check('every request goes to /api/employee', r.hits.every((h) => h.prefix === '/api/employee'), true);
check('every request carries X-Employee-Key', r.hits.every((h) => h.employeeKey === 'ek_test'), true);
check('no request carries X-API-Key', r.hits.every((h) => h.key === null), true);
check('startup asked /me once', r.hits.filter((h) => h.path === '/me').length >= 1, true);
has('startup says who it acts as', r.stderr(), 'acting as Anil Pujara (00081)');

has('whoami answers with the employee', r.text(0), '00081');
const list = r.hits.find((h) => h.method === 'GET' && h.path === '/tasks');
check('list_tasks passes the queue filters the surface accepts', list?.query, { status: 'todo', limit: '5' });
const create = r.hits.find((h) => h.method === 'POST' && h.path === '/tasks');
check('create_task sends the project and title', [create?.body?.project_id, create?.body?.title], [7, 'From a colleague']);
check('create_task description is HTML', create?.body?.description, '<p><strong>Bold</strong> and a list:</p><ul><li>one</li></ul>');
check('create_task names no creator', 'created_by_employee_code' in (create?.body ?? {}), false);
const comment = r.hits.find((h) => h.method === 'POST' && h.path === '/tasks/12/comments');
check('comment body is HTML with the mention left as text', comment?.body?.body, '<p>@Kamal Raj Silwal done, see <code>x</code></p>');
check('comment names no author', 'author_employee_code' in (comment?.body ?? {}), false);
const patch = r.hits.find((h) => h.method === 'PATCH' && h.path === '/tasks/12');
check('update_task sends only what was given', patch?.body, { status: 'done' });
const time = r.hits.find((h) => h.method === 'POST' && h.path === '/tasks/12/time');
check('log_time sends the window', [time?.body?.started_at, time?.body?.ended_at], ['2026-10-26T09:00:00+05:45', '2026-10-26T10:30:00+05:45']);
const doc = r.hits.find((h) => h.method === 'POST' && h.path === '/docs');
check('create_doc reaches the employee docs surface', doc?.body?.title, 'Notes');
check('no call errored', r.out.map((_, i) => r.errored(i)), r.out.map(() => false));

// ---- startup refusals (no server needed: they fail before any request)
function start(env) {
  const r = spawnSync('node', ['dist/index.js'], { input: '', env: { ...process.env, CLOKIO_API_KEY: undefined, ...env }, encoding: 'utf8', timeout: 8000 });
  return { code: r.status, stderr: r.stderr };
}
const both = start({ CLOKIO_API_KEY: 'clk_x', CLOKIO_EMPLOYEE_KEY: 'ek_x' });
check('both keys set refuses to start', both.code !== 0, true);
has('and names both variables', both.stderr, 'CLOKIO_API_KEY');
has('and names both variables (2)', both.stderr, 'CLOKIO_EMPLOYEE_KEY');
const neither = start({});
check('no key refuses to start', neither.code !== 0, true);
has('and tells the employee option exists', neither.stderr, 'CLOKIO_EMPLOYEE_KEY');
const actor = start({ CLOKIO_EMPLOYEE_KEY: 'ek_x', CLOKIO_DEFAULT_ACTOR: '00055' });
check('a default actor is refused in employee mode', actor.code !== 0, true);
has('and says why', actor.stderr, 'CLOKIO_DEFAULT_ACTOR');
const attendance = start({ CLOKIO_EMPLOYEE_KEY: 'ek_x', CLOKIO_TOOLSETS: 'attendance' });
check('a toolset the employee surface lacks is refused', attendance.code !== 0, true);
has('and lists what employee mode offers', attendance.stderr, 'docs');

// ---- a dead key fails at startup, not on the first write
const dead = await runTools({ env: employeeEnv, calls: [], respond: (hit) => (hit.path === '/me' ? { status: 401, json: { status: 'error', message: 'Invalid or revoked API key.' } } : undefined) });
check('a revoked key leaves no tools', Object.keys(dead.tools).length, 0);
has('and says the key was refused', dead.stderr(), 'revoked');

// ---- review of PR #2 (2026-10-26), each break-verified: put the old line
// back and the named check fails.
const meOk = (hit) => (hit.path === '/me' ? { status: 200, json: { status: 'success', data: me } } : undefined);
const fix = await runTools({
  env: employeeEnv,
  calls: [
    ['clokio_list_tasks', { include_done: true }],
    ['clokio_list_tasks', { include_done: false }],
    ['clokio_whoami', {}],
    ['clokio_update_task', { id: 12, due_date: null, estimated_hours: null, description: null }],
    ['clokio_add_task_comment', { id: 12, body: '   \n  ' }],
    ['clokio_add_task_comment', { id: 12, body: '- x\n'.repeat(14000) }],
  ],
  respond: meOk,
});
const lists = fix.hits.filter((h) => h.method === 'GET' && h.path === '/tasks');
// 1. include_done as 1/0: the server's boolean rule refuses "true"/"false".
check('include_done true is sent as 1', lists[0]?.query?.include_done, '1');
check('include_done false is sent as 0', lists[1]?.query?.include_done, '0');
// 2. whoami reports the running build, like the admin whoami.
has('whoami carries mcp_version', fix.text(2), 'mcp_version');
// 6. null clears a date, the estimate and the description.
const clear = fix.hits.find((h) => h.method === 'PATCH' && h.path === '/tasks/12');
check('update_task sends null to clear', clear?.body, { description: null, due_date: null, estimated_hours: null });
// 7. limits judged after the Markdown conversion, before any request.
check('a whitespace-only comment is refused before sending', fix.errored(4), true);
check('a comment past 65535 once converted is refused before sending', fix.errored(5), true);
check('neither reached the server', fix.hits.filter((h) => h.path === '/tasks/12/comments').length, 0);

// 3. whoami is always there, even when only docs are named.
const docsOnly = await runTools({ env: { ...employeeEnv, CLOKIO_TOOLSETS: 'docs' }, calls: [], respond: meOk });
check('docs-only employee mode still has clokio_whoami', 'clokio_whoami' in docsOnly.tools, true);
check('docs-only employee mode has no task tools', 'clokio_create_task' in docsOnly.tools, false);

// 8. its own toolset message: never the admin list or "projects is always on".
const projectsSet = start({ CLOKIO_EMPLOYEE_KEY: 'ek_x', CLOKIO_TOOLSETS: 'projects' });
check('an unknown employee toolset is refused', projectsSet.code !== 0, true);
check('and the message does not list the admin toolsets', /attendance|tickets|employees/.test(projectsSet.stderr), false);

// 4. only a 401/403 blames the key; a server error or a missing /me does not.
const down = await runTools({ env: employeeEnv, calls: [], respond: (hit) => (hit.path === '/me' ? { status: 503, json: { status: 'error', message: 'Down for a deploy' } } : undefined) });
check('a 503 at startup leaves no tools', Object.keys(down.tools).length, 0);
check('and does not tell the person to replace the key', /revoked|issue a new one/.test(down.stderr()), false);
has('and says the key was not refused', down.stderr(), 'not refused');
const noMe = await runTools({ env: employeeEnv, calls: [], respond: (hit) => (hit.path === '/me' ? { status: 404, json: { status: 'error', message: 'Not found.' } } : undefined) });
has('a server without /me is named as such', noMe.stderr(), 'newer Clokio');

// 9. the harness never leaks an employee key from the shell into admin runs.
const leaked = await runTools({ env: { CLOKIO_EMPLOYEE_KEY: undefined }, calls: [] });
process.env.CLOKIO_EMPLOYEE_KEY = 'ek_from_shell';
const admin = await runTools({ calls: [] });
delete process.env.CLOKIO_EMPLOYEE_KEY;
check('an admin run starts even with CLOKIO_EMPLOYEE_KEY in the shell', Object.keys(admin.tools).length, Object.keys(leaked.tools).length);

done();
