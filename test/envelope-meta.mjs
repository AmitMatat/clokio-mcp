// The envelope unwrap must KEEP meta.
//
// request() unwrapped `data` and threw `meta` away, so meta.next_cursor,
// meta.total and meta.last_page never reached the model - while the tool
// descriptions told it to page with a cursor whose value had already been
// discarded. A caller could not tell a full first page from the whole result
// set. Reported 2026-09-26.
//
// A single-object read carries no meta and must stay unwrapped, or every
// get_task/whoami caller sees a shape change.
//
// Run by hand:  node test/envelope-meta.mjs
import { createServer } from 'node:http';
import { once } from 'node:events';
import { request } from '../dist/client.js';

const srv = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url.includes('/tasks/5')) {
    return res.end(JSON.stringify({ status: 'success', data: { id: 5, title: 'one task' } }));
  }
  res.end(JSON.stringify({
    status: 'success',
    data: [{ id: 1 }, { id: 2 }],
    meta: { total: 4205, per_page: 2, current_page: 1, next_cursor: 'abc123' },
  }));
});
srv.listen(0, '127.0.0.1');
await once(srv, 'listening');
const cfg = { baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: 'clk_x' };

let fails = 0;
const check = (l, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok?'PASS':'FAIL'} ${l}: ${JSON.stringify(got)}`); };

const list = await request(cfg, '/tasks');
check('a list keeps meta.next_cursor', list?.meta?.next_cursor, 'abc123');
check('and meta.total', list?.meta?.total, 4205);
check('with data still present', Array.isArray(list?.data), true);

const one = await request(cfg, '/tasks/5');
check('a single object with NO meta stays unwrapped', one?.title, 'one task');

srv.close();
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
