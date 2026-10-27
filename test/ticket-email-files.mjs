// Files on an outgoing email (0.30.0) and closing without a survey: the
// create / reply tools upload file_paths through POST /tickets/attachments and
// send the ids in attachment_ids; a retry with the same idempotency_key reuses
// the ids and uploads nothing; clokio_update_ticket passes send_survey.
//
// Run by hand:  npm run build && node test/ticket-email-files.mjs
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

const dir = mkdtempSync(join(tmpdir(), 'clokio-mcp-files-'));
const pdf = join(dir, 'report.pdf');
const csv = join(dir, 'data.csv');
writeFileSync(pdf, '%PDF-1.4\nhello');
writeFileSync(csv, 'name,total\nDana,3\n');
const flaky = join(dir, 'flaky.pdf');
writeFileSync(flaky, '%PDF-1.4\nflaky');
let flakyFailures = 1; // the first upload of flaky.pdf fails, the next succeeds
let refuseOnce = true; // the first create with key 'refused-key' is refused on attachment_ids

let nextUpload = 500;
const hits = [];
const srv = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = new URL(req.url, 'http://x').pathname.replace('/api/v1', '');
    const multipart = (req.headers['content-type'] ?? '').startsWith('multipart/form-data');
    const fileName = multipart ? (raw.match(/filename="([^"]+)"/) ?? [])[1] ?? null : null;
    hits.push({ method: req.method, path, body: !multipart && raw ? JSON.parse(raw) : null, fileName, idem: req.headers['idempotency-key'] ?? null });

    let data = { ok: true };
    if (req.method === 'POST' && path === '/tickets/attachments' && fileName === 'flaky.pdf' && flakyFailures > 0) {
      flakyFailures--;
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'error', message: 'Server error' }));
    }
    if (req.method === 'POST' && path === '/tickets' && req.headers['idempotency-key'] === 'refused-key' && refuseOnce) {
      refuseOnce = false;
      res.writeHead(422, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'error', message: 'Unknown, expired or already used attachment id', errors: { attachment_ids: ['Unknown, expired or already used attachment id'] } }));
    }
    if (req.method === 'GET' && path === '/tickets/412') data = { ticket: { id: 412, channel: { type: 'email' } } };
    if (req.method === 'GET' && path === '/tickets/413') data = { ticket: { id: 413, channel: { type: 'whatsapp' } } };
    if (req.method === 'POST' && path === '/tickets/attachments') data = { attachment_id: nextUpload++, file_name: fileName, mime_type: 'application/pdf', size_bytes: 10, expires_at: new Date(Date.now() + 86400000).toISOString() };
    if (req.method === 'POST' && path === '/tickets') data = { ticket: { id: 77, state: 'open' }, message_id: 9, attachments: [{ id: 1, file_name: 'report.pdf', size_bytes: 10 }], draft: false, delivery: 'queued', reused: false, replayed: false };
    if (req.method === 'POST' && path === '/tickets/412/replies') data = { message_id: 10, ticket_id: 412, attachments: [], delivery: 'queued', replayed: false };
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', message: 'ok', data }));
  });
});
srv.listen(0, '127.0.0.1');
await once(srv, 'listening');
const base = `http://127.0.0.1:${srv.address().port}`;

const email = { channel: 'email', inbox_id: 21, to: ['client@example.test'], subject: 'Daily report', body: 'Attached.' };
const calls = [
  ['clokio_create_ticket', { ...email, file_paths: [pdf], idempotency_key: 'report-2026-10-27' }],
  // The same key again: a retry. It must reuse attachment 500 and upload nothing.
  ['clokio_create_ticket', { ...email, file_paths: [pdf], idempotency_key: 'report-2026-10-27' }],
  ['clokio_reply_ticket', { id: 412, body: 'Here.', file_paths: [csv], attachment_ids: [42] }],
  ['clokio_create_ticket', { channel: 'whatsapp', inbox_id: 20, to: '+972500000000', template: { name: 't', language: 'he' }, file_paths: [pdf] }],
  ['clokio_create_ticket', { ...email, draft: true, file_paths: [pdf] }],
  ['clokio_update_ticket', { id: 412, state: 'resolved', send_survey: false }],
  ['clokio_upload_ticket_attachment', { file_path: pdf }],
  // Code review 2026-10-27:
  // (107) a bad body is refused BEFORE any upload;
  ['clokio_create_ticket', { channel: 'email', inbox_id: 21, to: ['a@b.test'], body: 'no subject', file_paths: [pdf] }],
  // (108) files on a chat ticket are refused before any upload;
  ['clokio_reply_ticket', { id: 413, body: 'Hi', file_paths: [pdf] }],
  // (109) the second upload fails; (110) the retry reuses the first and uploads only the second;
  ['clokio_create_ticket', { ...email, file_paths: [csv, flaky], idempotency_key: 'partial-key' }],
  ['clokio_create_ticket', { ...email, file_paths: [csv, flaky], idempotency_key: 'partial-key' }],
  // (111) the server refuses the ids; (112) the retry uploads afresh.
  ['clokio_create_ticket', { ...email, file_paths: [pdf], idempotency_key: 'refused-key' }],
  ['clokio_create_ticket', { ...email, file_paths: [pdf], idempotency_key: 'refused-key' }],
];

const lines = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  ...calls.map(([name, args], i) => JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name, arguments: args } })),
];

const child = spawn('node', ['dist/index.js'], { env: { ...process.env, CLOKIO_BASE_URL: base, CLOKIO_API_KEY: 'clk_test', CLOKIO_TOOLSETS: 'tickets' } });
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

const text = (id) => results[id]?.result?.content?.[0]?.text ?? '';
const errored = (id) => results[id]?.result?.isError === true;

check('the calls, in order', hits.map((h) => [h.method, h.path]), [
  ['POST', '/tickets/attachments'], ['POST', '/tickets'],
  ['POST', '/tickets'],
  ['GET', '/tickets/412'], ['POST', '/tickets/attachments'], ['POST', '/tickets/412/replies'],
  ['PATCH', '/tickets/412'],
  ['POST', '/tickets/attachments'],
  // 107: nothing. 108: only the ticket read.
  ['GET', '/tickets/413'],
  // 109: csv uploaded (503), flaky failed. 110: flaky only (504), then the send.
  ['POST', '/tickets/attachments'], ['POST', '/tickets/attachments'],
  ['POST', '/tickets/attachments'], ['POST', '/tickets'],
  // 111: upload (505), refused. 112: upload again (506), sent.
  ['POST', '/tickets/attachments'], ['POST', '/tickets'],
  ['POST', '/tickets/attachments'], ['POST', '/tickets'],
]);
check('the file is sent under its own name', hits[0].fileName, 'report.pdf');
check('create sends the uploaded id', hits[1].body.attachment_ids, [500]);
check('a retry with the same key reuses the id', hits[2].body.attachment_ids, [500]);
check('the retry carries the same Idempotency-Key', [hits[1].idem, hits[2].idem], ['report-2026-10-27', 'report-2026-10-27']);
check('reply: given ids first, then the uploaded one', hits[5].body.attachment_ids, [42, 501]);
check('the answer names the attached files', text(100).includes('Files attached: report.pdf'), true);
check('files on WhatsApp are refused before any request', [errored(103), text(103).includes('Files go on an email only')], [true, true]);
check('files on a draft are refused before any request', [errored(104), text(104).includes('A draft carries no files')], [true, true]);
check('send_survey passes through', hits[6].body, { state: 'resolved', send_survey: false });
check('a bad body uploads nothing', [errored(107), text(107).includes('An email needs a subject')], [true, true]);
check('files on a chat ticket upload nothing', [errored(108), text(108).includes('email ticket only')], [true, true]);
check('a failed upload is an error', errored(109), true);
check('the retry reuses the upload that succeeded', hits[12].body.attachment_ids, [503, 504]);
check('a refusal is reported', errored(111), true);
check('after a refusal the retry uploads afresh', hits[16].body.attachment_ids, [506]);
check('the upload tool answers the new id', text(106).includes('502'), true);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
