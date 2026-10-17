// Shared by the 0.22 tests: a capture server standing in for Clokio, and the
// built server (dist/index.js) driven over stdio. `respond(hit)` returns
// { status, json } or { status, bytes, headers }; undefined = a plain success.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

export function checker() {
  let fails = 0;
  const check = (label, got, want) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    const ok = g === w;
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${g}${ok ? '' : `   (want ${w})`}`);
  };
  const has = (label, text, needle) => check(label, typeof text === 'string' && text.includes(needle), true);
  const done = () => {
    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
    process.exit(fails ? 1 : 0);
  };
  return { check, has, done };
}

export async function runTools({ toolsets, calls, respond }) {
  const hits = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url, 'http://x');
      const hit = {
        method: req.method,
        path: u.pathname.replace('/api/v1', ''),
        query: Object.fromEntries(u.searchParams),
        search: u.search,
        body: raw ? JSON.parse(raw) : null,
        key: req.headers['x-api-key'] ?? null,
        idempotencyKey: req.headers['idempotency-key'] ?? null,
      };
      hits.push(hit);
      const out = respond?.(hit) ?? { status: 200, json: { status: 'success', message: 'ok', data: {} } };
      if (out.bytes !== undefined) {
        res.writeHead(out.status ?? 200, out.headers ?? {});
        res.end(out.bytes);
        return;
      }
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(JSON.stringify(out.json));
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const base = `http://127.0.0.1:${srv.address().port}`;

  const lines = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    ...calls.map(([name, args], i) => JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name, arguments: args } })),
  ];

  const env = { ...process.env, CLOKIO_BASE_URL: base, CLOKIO_API_KEY: 'clk_test' };
  if (toolsets) env.CLOKIO_TOOLSETS = toolsets;
  const child = spawn('node', ['dist/index.js'], { env });
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

  const tools = Object.fromEntries((results[2]?.result?.tools ?? []).map((t) => [t.name, t]));
  const out = calls.map((_, i) => results[100 + i]);
  return {
    hits,
    tools,
    out,
    text: (i) => out[i]?.result?.content?.[0]?.text ?? '',
    content: (i) => out[i]?.result?.content ?? [],
    errored: (i) => Boolean(out[i]?.result?.isError || out[i]?.error),
  };
}
