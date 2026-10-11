// Client safety for the Docs tools, which call /api/v1/docs... with the one
// CLOKIO_API_KEY (X-API-Key), like every other tool.
//
// Properties under test:
//   - docs calls land on /api/v1/docs and carry X-API-Key (and nothing else);
//   - the /api/v1 prefix guard refuses a path that climbs out, with nothing
//     sent, and seg() keeps a hostile id inside;
//   - a redirect on a JSON call is refused (the key never reaches the sink);
//   - a redirect on a DOWNLOAD is followed by hand with NO credential, and a
//     non-http(s) target is refused;
//   - the download `path` travels as an encoded query value, not as segments;
//   - the docs toolset registers by default, CLOKIO_TOOLSETS can select or
//     drop it, and the API's no-actor 403 reaches the model verbatim.
//
// Break-verify: drop the prefix check in buildUrl(), or pass headers on the
// redirected fetch in requestRawBytes(), and the matching checks fail.
//
// Run by hand:  node test/docs-client-safety.mjs
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ClokioApiError, request, requestRawBytes, seg } from '../dist/client.js';

const API_KEY = 'clk_key_that_must_not_leak';

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(got)}${ok ? '' : `   (want ${JSON.stringify(want)})`}`);
};

// ---- servers ---------------------------------------------------------------

const sinkHits = [];
const sink = createServer((req, res) => {
  sinkHits.push({
    url: req.url,
    apiKey: req.headers['x-api-key'] ?? null,
  });
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('signed storage body');
});
sink.listen(0, '127.0.0.1');
await once(sink, 'listening');
const sinkUrl = `http://127.0.0.1:${sink.address().port}`;

const apiHits = [];
const api = createServer((req, res) => {
  apiHits.push({
    method: req.method,
    url: req.url,
    apiKey: req.headers['x-api-key'] ?? null,
    other: Object.keys(req.headers).filter((h) => h.startsWith('x-') && h !== 'x-api-key'),
  });
  if (req.url.startsWith('/api/v1/redirect-json')) {
    res.writeHead(302, { location: `${sinkUrl}/captured` });
    return res.end();
  }
  if (req.url.startsWith('/api/v1/docs/5/attachments/download') && req.url.includes('big')) {
    res.writeHead(302, { location: `${sinkUrl}/signed?sig=1` });
    return res.end();
  }
  if (req.url.startsWith('/api/v1/docs/5/attachments/download') && req.url.includes('dataurl')) {
    res.writeHead(302, { location: 'data:text/plain,hello' });
    return res.end();
  }
  if (req.url.startsWith('/api/v1/docs/5/attachments/download')) {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-disposition': 'attachment; filename="notes.txt"',
    });
    return res.end('inline body');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'success', message: 'ok', data: { ok: true } }));
});
api.listen(0, '127.0.0.1');
await once(api, 'listening');
const baseUrl = `http://127.0.0.1:${api.address().port}`;

const cfg = { baseUrl, apiKey: API_KEY };
const reset = () => {
  apiHits.length = 0;
  sinkHits.length = 0;
};

// ---- docs calls go to /api/v1 with X-API-Key -------------------------------

reset();
await request(cfg, '/docs', { query: { project_id: 'all' } });
check('docs call hits /api/v1/docs', apiHits[0]?.url, '/api/v1/docs?project_id=all');
check('docs call sends X-API-Key', apiHits[0]?.apiKey, API_KEY);
check('and no other X- credential header', apiHits[0]?.other?.length, 0);

let err = null;

// ---- prefix guard + seg ----------------------------------------------------

for (const hostile of ['/../employee/docs', '/docs/../../employee/docs', '/../../etc']) {
  reset();
  err = null;
  try {
    await request(cfg, hostile);
  } catch (e) {
    err = e;
  }
  check(`guard refuses ${hostile}`, /outside \/api\/v1/.test(err?.message ?? ''), true);
  check(`  and nothing was sent for ${hostile}`, apiHits.length, 0);
}

check('seg encodes a slash and query', seg('1/../x?y=1'), '1%2F..%2Fx%3Fy%3D1');
let segErr = null;
try {
  seg('..');
} catch (e) {
  segErr = e;
}
check('seg refuses a bare ..', segErr instanceof ClokioApiError, true);

reset();
await request(cfg, `/docs/${seg('../../employee/docs')}`);
check('a seg-wrapped hostile id stays inside /api/v1/docs/', apiHits[0]?.url.startsWith('/api/v1/docs/'), true);

// ---- JSON redirect is refused ----------------------------------------------

reset();
err = null;
try {
  await request(cfg, '/redirect-json');
} catch (e) {
  err = e;
}
check('a redirect on a JSON docs call is an error', err instanceof ClokioApiError, true);
check('the sink received nothing', sinkHits.length, 0);

// ---- downloads -------------------------------------------------------------

reset();
const plain = await requestRawBytes(cfg, '/docs/5/attachments/download', { path: 'docs/org-1/5/files/a b&c?.txt' });
check('download body', plain.buffer.toString('utf8'), 'inline body');
check('content-disposition file name surfaced', plain.fileName, 'notes.txt');
const sentUrl = new URL(apiHits[0]?.url, baseUrl);
check('download path stays a single query value', sentUrl.searchParams.get('path'), 'docs/org-1/5/files/a b&c?.txt');
check('download path did not add path segments', sentUrl.pathname, '/api/v1/docs/5/attachments/download');

reset();
const big = await requestRawBytes(cfg, '/docs/5/attachments/download', { path: 'big' });
check('redirected download is followed', big.buffer.toString('utf8'), 'signed storage body');
check('the storage origin was reached once', sinkHits.length, 1);
check('and saw NO key', sinkHits[0]?.apiKey, null);

reset();
err = null;
try {
  await requestRawBytes(cfg, '/docs/5/attachments/download', { path: 'dataurl' });
} catch (e) {
  err = e;
}
check('a data: redirect target is refused', /data:/.test(err?.message ?? ''), true);

// ---- the docs toolset over MCP ----------------------------------------------

// A stub API that refuses docs the way a key with no effective actor is
// refused, so the message is checked end to end through the tool layer.
// The production message (ActsAsAuthority::NO_EFFECTIVE_ACTOR).
const ACTS_AS_MSG =
  'This API key does not act as an employee, and the person who created it has no active employee record in this organization, so it cannot open documents. Set the key to act as an employee.';
const refuser = createServer((req, res) => {
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', message: ACTS_AS_MSG, data: {} }));
});
refuser.listen(0, '127.0.0.1');
await once(refuser, 'listening');
const refuserUrl = `http://127.0.0.1:${refuser.address().port}`;

async function runServer(env, calls) {
  const lines = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    ...calls.map((c, i) => JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: c })),
  ];
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLOKIO_TOOLSETS;
  const { spawn } = await import('node:child_process');
  const child = spawn('node', ['dist/index.js'], {
    env: { ...cleanEnv, CLOKIO_API_KEY: 'clk_test', CLOKIO_BASE_URL: refuserUrl, ...env },
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stdin.write(lines.join('\n') + '\n');
  const want = [2, ...calls.map((_, i) => 10 + i)];
  const t0 = Date.now();
  const parsed = () => {
    const out = {};
    for (const line of stdout.split('\n')) {
      try {
        const d = JSON.parse(line);
        if (d.id !== undefined) out[d.id] = d;
      } catch {}
    }
    return out;
  };
  while (!want.every((id) => parsed()[id]) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20));
  child.kill();
  return parsed();
}

const all = await runServer({}, [{ name: 'clokio_get_doc', arguments: { id: 1 } }]);
const names = all[2]?.result?.tools?.map((t) => t.name) ?? [];
check('docs tools register by default', names.includes('clokio_get_doc') && names.includes('clokio_list_doc_shareable_teams'), true);
check('alongside the task tools', names.includes('clokio_create_task'), true);

// Each docs tool names the SECTION permission its route's sectionGate()
// checks (backend app/Http/Controllers/EmployeeApi/Doc*.php), so a 403
// "Forbidden: Insufficient permissions" is explainable from the description.
const SECTION = {
  'docs.view': ['clokio_list_docs', 'clokio_get_doc_tree', 'clokio_search_docs', 'clokio_get_doc', 'clokio_list_doc_templates', 'clokio_list_doc_members', 'clokio_list_doc_shareable_teams', 'clokio_list_doc_comments', 'clokio_list_doc_versions', 'clokio_get_doc_version', 'clokio_list_doc_attachments', 'clokio_download_doc_attachment'],
  'docs.create': ['clokio_create_doc', 'clokio_update_doc_content', 'clokio_update_doc_meta', 'clokio_move_doc', 'clokio_archive_doc', 'clokio_restore_doc', 'clokio_create_doc_from_template', 'clokio_add_doc_comment', 'clokio_resolve_doc_comment', 'clokio_reopen_doc_comment', 'clokio_restore_doc_version', 'clokio_upload_doc_attachment'],
  'docs.manage': ['clokio_delete_doc', 'clokio_add_doc_member', 'clokio_update_doc_member', 'clokio_remove_doc_member', 'clokio_add_doc_team', 'clokio_update_doc_team', 'clokio_remove_doc_team', 'clokio_create_doc_share_link', 'clokio_revoke_doc_share_link'],
};
const descOf = Object.fromEntries((all[2]?.result?.tools ?? []).map((t) => [t.name, t.description]));
const docTools = Object.keys(descOf).filter((n) => /^clokio_.*doc/.test(n));
const mapped = Object.values(SECTION).flat();
check('every docs tool has a section mapping', docTools.filter((n) => !mapped.includes(n)).join(', '), '');
const wrong = [];
for (const [perm, tools] of Object.entries(SECTION)) {
  for (const t of tools) if (!(descOf[t] ?? '').includes(`Needs ${perm}`)) wrong.push(`${t} (want ${perm})`);
}
check('each docs tool description names its section permission', wrong.join(', '), '');
check('clokio_list_docs explains the Insufficient permissions 403', (descOf.clokio_list_docs ?? '').includes('Insufficient permissions'), true);
check('the no-actor 403 reaches the model verbatim', (all[10]?.result?.content?.[0]?.text ?? '').includes(ACTS_AS_MSG), true);
check('and is an error result', all[10]?.result?.isError, true);

const docsOnly = await runServer({ CLOKIO_TOOLSETS: 'docs' }, []);
const docsNames = docsOnly[2]?.result?.tools?.map((t) => t.name) ?? [];
check('CLOKIO_TOOLSETS=docs keeps the docs tools', docsNames.includes('clokio_list_docs'), true);
check('CLOKIO_TOOLSETS=docs drops the task tools', docsNames.includes('clokio_create_task'), false);

const noDocs = await runServer({ CLOKIO_TOOLSETS: 'tasks' }, []);
const noDocsNames = noDocs[2]?.result?.tools?.map((t) => t.name) ?? [];
check('CLOKIO_TOOLSETS=tasks drops the docs tools', noDocsNames.includes('clokio_list_docs'), false);

refuser.close();
api.close();
sink.close();

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
