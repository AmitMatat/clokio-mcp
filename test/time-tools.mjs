// The four time-logging tools (backend task #5775) call the routes the
// backend serves with the body it expects, and NEVER send an employee: the
// time is always the key's acting person's. Shape errors the server would
// 422 (end AND duration, start without date) are refused locally, with no
// HTTP call. Also pins the descriptions' promises: acting person, the scope
// "*" does not grant, overlap refused, 12 hours at most.
//
// Run by hand:  npm run build && node test/time-tools.mjs
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

let fails = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${g}${ok ? '' : `   (want ${w})`}`);
};

const hits = [];
const srv = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const u = new URL(req.url, 'http://x');
    hits.push({ method: req.method, path: u.pathname.replace('/api/v1', ''), body: raw ? JSON.parse(raw) : null, key: req.headers['x-api-key'] ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', message: 'ok', data: { entry: { id: 1, running: false } } }));
  });
});
srv.listen(0, '127.0.0.1');
await once(srv, 'listening');
const base = `http://127.0.0.1:${srv.address().port}`;

const calls = [
  ['clokio_log_time', { task_id: 731, date: '2026-10-16', start: '09:00', end: '10:30', description: 'Header' }],
  ['clokio_log_time', { task_id: 731, duration_minutes: 45 }],
  ['clokio_start_timer', { task_id: 731, force: true }],
  ['clokio_stop_timer', {}],
  ['clokio_get_active_timer', {}],
  // Refused locally (no HTTP call):
  ['clokio_log_time', { task_id: 731, date: '2026-10-16', start: '09:00', end: '10:00', duration_minutes: 60 }],
  ['clokio_log_time', { task_id: 731, start: '09:00', end: '10:00' }],
  ['clokio_log_time', { task_id: 731, date: '2026-10-16' }],
  // Over the 12-hour cap: the schema refuses it.
  ['clokio_log_time', { task_id: 731, duration_minutes: 721 }],
  // An employee is not an argument at all: unknown keys are stripped, never sent.
  ['clokio_start_timer', { task_id: 731, employee_code: '00080' }],
];

const lines = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
  ...calls.map(([name, args], i) => JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name, arguments: args } })),
];

const child = spawn('node', ['dist/index.js'], { env: { ...process.env, CLOKIO_BASE_URL: base, CLOKIO_API_KEY: 'clk_test', CLOKIO_TOOLSETS: 'attendance' } });
const results = {};
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); if (m.id === 2 || m.id >= 100) results[m.id] = m; } catch {}
  }
});
for (const line of lines) {
  const id = JSON.parse(line).id;
  child.stdin.write(line + '\n');
  if (id === 2 || id >= 100) {
    const t0 = Date.now();
    while (!results[id] && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  }
}
child.kill();
srv.close();

const errored = (id) => Boolean(results[id]?.result?.isError || results[id]?.error);
check('the five good calls succeed', [100, 101, 102, 103, 104].map(errored), [false, false, false, false, false]);
check('end AND duration is refused', errored(105), true);
check('start without date is refused', errored(106), true);
check('neither end nor duration is refused', errored(107), true);
check('721 minutes is refused', errored(108), true);
check('an employee_code argument never fails the call', errored(109), false);

check('the HTTP calls, in order', hits.map((h) => [h.method, h.path]), [
  ['POST', '/time-entries'], ['POST', '/time-entries'], ['POST', '/timer/start'], ['POST', '/timer/stop'], ['GET', '/timer/active'], ['POST', '/timer/start'],
]);
check('manual body', hits[0]?.body, { task_id: 731, date: '2026-10-16', start: '09:00', end: '10:30', description: 'Header' });
check('duration-only body', hits[1]?.body, { task_id: 731, duration_minutes: 45 });
check('start body', hits[2]?.body, { task_id: 731, force: true });
check('stop sends no fields', hits[3]?.body === null || Object.keys(hits[3].body).length === 0, true);
check('no request ever names an employee', hits.some((h) => h.body && ('employee_code' in h.body || 'employee_id' in h.body)), false);
check('every call carried X-API-Key', hits.every((h) => h.key === 'clk_test'), true);

const tools = Object.fromEntries((results[2]?.result?.tools ?? []).map((t) => [t.name, t]));
for (const name of ['clokio_log_time', 'clokio_start_timer', 'clokio_stop_timer', 'clokio_get_active_timer']) {
  check(`${name} is registered`, Boolean(tools[name]), true);
  check(`${name} names the acting person`, /ACTING person/.test(tools[name]?.description ?? ''), true);
}
const logDesc = tools.clokio_log_time?.description ?? '';
check('log_time names the scope and that "*" does not grant it', /time_entries:write/.test(logDesc) && /does NOT grant/.test(logDesc), true);
check('log_time says overlap is refused', /overlapping .* refused/.test(logDesc), true);
check('log_time says 12 hours at most', /12 hours/.test(logDesc), true);
check('the writes are marked mutating', ['clokio_log_time', 'clokio_start_timer', 'clokio_stop_timer'].map((n) => tools[n]?.annotations?.readOnlyHint), [false, false, false]);
check('the active read is read-only', tools.clokio_get_active_timer?.annotations?.readOnlyHint, true);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
