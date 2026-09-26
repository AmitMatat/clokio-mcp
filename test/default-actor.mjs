// CLOKIO_DEFAULT_ACTOR: an unnamed write is credited to it, an explicit code wins.
//
// The API already falls back to the KEY'S ISSUER for an unnamed write, so this
// env var is only for a shared/service key whose issuer is not the acting
// person. Precedence: explicit tool argument > CLOKIO_DEFAULT_ACTOR > (server
// falls back to the key issuer if neither is sent).
//
// Run by hand:  node test/default-actor.mjs
import { createServer } from 'node:http';
import { once } from 'node:events';

let fails = 0;
const check = (l, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok?'PASS':'FAIL'} ${l}: ${JSON.stringify(got)}`); };

// Capture what the tools send, without a real server.
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
const base = `http://127.0.0.1:${srv.address().port}`;

// loadConfig reads the env; set it before importing.
process.env.CLOKIO_API_KEY = 'clk_x';
process.env.CLOKIO_BASE_URL = base;
process.env.CLOKIO_DEFAULT_ACTOR = '00099';
const { loadConfig } = await import('../dist/client.js');
const cfg = loadConfig();
check('loadConfig picked up the default actor', cfg.defaultActor, '00099');

// Rebuild the tool handlers against a stub McpServer to invoke them directly.
const tools = {};
const stubServer = { registerTool: (name, _def, cb) => { tools[name] = cb; } };
const { registerTaskTools } = await import('../dist/tools/tasks.js');
registerTaskTools(stubServer, cfg);

// 1. create with NO created_by -> default actor is sent
await tools.clokio_create_task({ project_id: 1, title: 'x' });
check('unnamed create uses the default actor', captured.at(-1).body.created_by_employee_code, '00099');

// 2. create WITH an explicit code -> explicit wins
await tools.clokio_create_task({ project_id: 1, title: 'x', created_by_employee_code: '00001' });
check('explicit created_by wins over the default', captured.at(-1).body.created_by_employee_code, '00001');

// 3. comment with no author -> default
await tools.clokio_add_task_comment({ id: 1, body: 'hi' });
check('unnamed comment uses the default actor', captured.at(-1).body.author_employee_code, '00099');

// 4. update with no actor -> default
await tools.clokio_update_task({ id: 1, status: 'done' });
check('unnamed update uses the default actor', captured.at(-1).body.actor_employee_code, '00099');

// 5. update with explicit actor -> explicit wins
await tools.clokio_update_task({ id: 1, status: 'done', actor_employee_code: '00002' });
check('explicit actor wins over the default', captured.at(-1).body.actor_employee_code, '00002');

srv.close();
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
