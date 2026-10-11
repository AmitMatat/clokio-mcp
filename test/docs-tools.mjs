// Every Docs tool calls the /api/v1/docs route and sends the body the API
// expects (routes/public-api.php docs group, served by
// app/Http/Controllers/EmployeeApi/Doc*.php in the backend). A capture server answers every call with a success
// envelope and records method, path, query and body.
//
// Run by hand:  node test/docs-tools.mjs
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    let body = null;
    if ((req.headers['content-type'] ?? '').includes('application/json') && raw) body = JSON.parse(raw);
    else if (raw) body = raw;
    const u = new URL(req.url, 'http://x');
    hits.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, key: req.headers['x-api-key'] ?? null });
    if (u.pathname.endsWith('/attachments/download')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('file text');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', message: 'ok', data: { ok: true } }));
  });
});
srv.listen(0, '127.0.0.1');
await once(srv, 'listening');
const base = `http://127.0.0.1:${srv.address().port}`;

const dir = await mkdtemp(join(tmpdir(), 'clokio-docs-'));
const upload = join(dir, 'spec.pdf');
await writeFile(upload, 'pdf bytes');

const calls = [
  ['clokio_list_docs', { project_id: 'all', parent_id: 'root', q: 'run', archived: 'include', page: 2, per_page: 10 }],
  ['clokio_get_doc_tree', { project_id: 7 }],
  ['clokio_search_docs', { q: 'zebra', limit: 5 }],
  ['clokio_get_doc', { id: 412 }],
  ['clokio_get_doc', { id: 412, format: 'json' }],
  ['clokio_create_doc', { title: 'T', project_id: 7, content: '# Hi' }],
  ['clokio_create_doc', { title: 'T', content: '<p>x</p>', content_format: 'html' }],
  ['clokio_update_doc_content', { id: 412, content: '{"type":"doc","content":[]}', content_format: 'json', base_version: 3 }],
  ['clokio_update_doc_content', { id: 412, content: '', base_version: 4 }],
  ['clokio_update_doc_meta', { id: 412, title: 'New', icon: null, full_width: true }],
  ['clokio_move_doc', { id: 412, parent_id: null, project_id: 9 }],
  ['clokio_archive_doc', { id: 412 }],
  ['clokio_restore_doc', { id: 412 }],
  ['clokio_delete_doc', { id: 412 }],
  ['clokio_list_doc_templates', {}],
  ['clokio_create_doc_from_template', { template: 'meeting', project_id: 7 }],
  ['clokio_list_doc_members', { id: 412 }],
  ['clokio_add_doc_member', { id: 412, employee_code: '00080', role: 'edit' }],
  ['clokio_add_doc_member', { id: 412, employee_id: 31, role: 'edit' }],
  ['clokio_update_doc_member', { id: 412, employee_code: '00080', role: 'view' }],
  ['clokio_update_doc_member', { id: 412, employee_id: 31, role: 'view' }],
  ['clokio_remove_doc_member', { id: 412, employee_code: '00080' }],
  ['clokio_remove_doc_member', { id: 412, employee_id: 31 }],
  ['clokio_list_doc_shareable_teams', { id: 412 }],
  ['clokio_add_doc_team', { id: 412, team_id: 2, role: 'comment' }],
  ['clokio_update_doc_team', { id: 412, team_id: 2, role: 'edit' }],
  ['clokio_remove_doc_team', { id: 412, team_id: 2 }],
  ['clokio_create_doc_share_link', { id: 412, expires_at: '2030-01-01' }],
  ['clokio_revoke_doc_share_link', { id: 412 }],
  ['clokio_list_doc_comments', { id: 412, filter: 'all' }],
  ['clokio_add_doc_comment', { id: 412, body: '**hi**', parent_id: 77 }],
  ['clokio_resolve_doc_comment', { id: 412, comment_id: 77 }],
  ['clokio_reopen_doc_comment', { id: 412, comment_id: 77 }],
  ['clokio_list_doc_versions', { id: 412 }],
  ['clokio_get_doc_version', { id: 412, version_id: 5 }],
  ['clokio_restore_doc_version', { id: 412, version_id: 5 }],
  ['clokio_list_doc_attachments', { id: 412 }],
  ['clokio_upload_doc_attachment', { id: 412, file_path: upload, kind: 'media' }],
  ['clokio_download_doc_attachment', { id: 412, path: 'docs/org-1/412/files/a.txt' }],
];

const lines = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  ...calls.map(([name, args], i) => JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name, arguments: args } })),
];

const env = { ...process.env, CLOKIO_BASE_URL: base, CLOKIO_API_KEY: 'clk_test', CLOKIO_TOOLSETS: 'docs' };
const child = spawn('node', ['dist/index.js'], { env });
const results = {};
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      if (m.id >= 100) results[m.id] = m;
    } catch {}
  }
});
// Sequential, so hits[] lines up with calls[].
for (const line of lines) {
  const id = JSON.parse(line).id;
  child.stdin.write(line + '\n');
  if (id >= 100) {
    const t0 = Date.now();
    while (!results[id] && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  }
}
child.kill();
srv.close();

const errors = Object.values(results).filter((r) => r.result?.isError);
check('no tool call errored', errors.map((e) => e.result.content[0].text), []);
check('every call reached the API once', hits.length, calls.length);
check('every call carried X-API-Key', hits.every((h) => h.key === 'clk_test'), true);

const P = '/api/v1';
const expect = [
  ['GET', '/docs', { project_id: 'all', parent_id: 'root', q: 'run', archived: 'include', page: '2', per_page: '10' }, null],
  ['GET', '/docs', { tree: '1', project_id: '7' }, null],
  ['GET', '/docs/search', { q: 'zebra', limit: '5' }, null],
  ['GET', '/docs/412', { format: 'markdown' }, null],
  ['GET', '/docs/412', { format: 'json' }, null],
  ['POST', '/docs', {}, { title: 'T', project_id: 7, content_markdown: '# Hi' }],
  ['POST', '/docs', {}, { title: 'T', content_html: '<p>x</p>' }],
  ['PUT', '/docs/412/content', {}, { content: { type: 'doc', content: [] }, base_version: 3 }],
  ['PUT', '/docs/412/content', {}, { content: { type: 'doc', content: [] }, base_version: 4 }],
  ['PATCH', '/docs/412', {}, { title: 'New', icon: null, full_width: true }],
  ['POST', '/docs/412/move', {}, { parent_id: null, project_id: 9 }],
  ['POST', '/docs/412/archive', {}, null],
  ['POST', '/docs/412/restore', {}, null],
  ['DELETE', '/docs/412', {}, null],
  ['GET', '/docs/templates', {}, null],
  ['POST', '/docs/from-template', {}, { template: 'meeting', project_id: 7 }],
  ['GET', '/docs/412/members', {}, null],
  ['POST', '/docs/412/members', {}, { employee_code: '00080', role: 'edit' }],
  ['POST', '/docs/412/members', {}, { employee_id: 31, role: 'edit' }],
  ['PATCH', '/docs/412/members', {}, { employee_code: '00080', role: 'view' }],
  ['PATCH', '/docs/412/members/31', {}, { role: 'view' }],
  ['DELETE', '/docs/412/members', { employee_code: '00080' }, null],
  ['DELETE', '/docs/412/members/31', {}, null],
  ['GET', '/docs/412/shareable-teams', {}, null],
  ['POST', '/docs/412/teams', {}, { team_id: 2, role: 'comment' }],
  ['PATCH', '/docs/412/teams/2', {}, { role: 'edit' }],
  ['DELETE', '/docs/412/teams/2', {}, null],
  ['POST', '/docs/412/share-link', {}, { expires_at: '2030-01-01' }],
  ['DELETE', '/docs/412/share-link', {}, null],
  ['GET', '/docs/412/comments', { filter: 'all' }, null],
  ['POST', '/docs/412/comments', {}, { body: '<p><strong>hi</strong></p>', parent_id: 77 }],
  ['POST', '/docs/412/comments/77/resolve', {}, null],
  ['POST', '/docs/412/comments/77/reopen', {}, null],
  ['GET', '/docs/412/versions', {}, null],
  ['GET', '/docs/412/versions/5', { format: 'markdown' }, null],
  ['POST', '/docs/412/versions/5/restore', {}, null],
  ['GET', '/docs/412/attachments', {}, null],
  ['POST', '/docs/412/attachments', {}, 'multipart'],
  ['GET', '/docs/412/attachments/download', { path: 'docs/org-1/412/files/a.txt' }, null],
];

expect.forEach(([method, path, query, body], i) => {
  const h = hits[i] ?? {};
  const label = calls[i][0];
  check(`${label} -> ${method} ${path}`, `${h.method} ${h.path}`, `${method} ${P}${path}`);
  check(`${label} query`, h.query, query);
  if (body === 'multipart') {
    check(`${label} multipart carries kind=media and the file`, /name="kind"\r\n\r\nmedia/.test(h.body) && /filename="spec.pdf"/.test(h.body), true);
  } else {
    check(`${label} body`, h.body, body);
  }
});

check('download returns the text', results[100 + calls.length - 1]?.result?.content?.[0]?.text, 'file text');

// Exactly one of employee_code / employee_id, refused before any request.
{
  const before = hits.length;
  const env2 = { ...env };
  const lines2 = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: 'clokio_add_doc_member', arguments: { id: 1, role: 'view' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 901, method: 'tools/call', params: { name: 'clokio_remove_doc_member', arguments: { id: 1, employee_id: 3, employee_code: '00003' } } }),
  ];
  const srv2 = createServer((req, res) => { hits.push({ stray: true }); res.end('{}'); });
  srv2.listen(0, '127.0.0.1');
  await once(srv2, 'listening');
  env2.CLOKIO_BASE_URL = `http://127.0.0.1:${srv2.address().port}`;
  const c2 = spawn('node', ['dist/index.js'], { env: env2 });
  let out2 = '';
  c2.stdout.on('data', (d) => (out2 += d));
  c2.stdin.write(lines2.join('\n') + '\n');
  const t0 = Date.now();
  while (!(out2.includes('"id":900') && out2.includes('"id":901')) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
  c2.kill();
  srv2.close();
  const r = {};
  for (const l of out2.split('\n')) { try { const d = JSON.parse(l); r[d.id] = d; } catch {} }
  check('neither code nor id is refused', /exactly one of employee_code/.test(r[900]?.result?.content?.[0]?.text ?? ''), true);
  check('both code and id is refused', /exactly one of employee_code/.test(r[901]?.result?.content?.[0]?.text ?? ''), true);
  check('and neither refusal reached the API', hits.length, before);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
