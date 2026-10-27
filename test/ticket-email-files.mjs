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
    if (req.method === 'POST' && path === '/tickets/attachments') data = { attachment_id: nextUpload++, file_name: fileName, mime_type: 'application/pdf', size_bytes: 10 };
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
  ['POST', '/tickets/attachments'], ['POST', '/tickets/412/replies'],
  ['PATCH', '/tickets/412'],
  ['POST', '/tickets/attachments'],
]);
check('the file is sent under its own name', hits[0].fileName, 'report.pdf');
check('create sends the uploaded id', hits[1].body.attachment_ids, [500]);
check('a retry with the same key reuses the id', hits[2].body.attachment_ids, [500]);
check('the retry carries the same Idempotency-Key', [hits[1].idem, hits[2].idem], ['report-2026-10-27', 'report-2026-10-27']);
check('reply: given ids first, then the uploaded one', hits[4].body.attachment_ids, [42, 501]);
check('the answer names the attached files', text(100).includes('Files attached: report.pdf'), true);
check('files on WhatsApp are refused before any request', [errored(103), text(103).includes('Files go on an email only')], [true, true]);
check('files on a draft are refused before any request', [errored(104), text(104).includes('A draft carries no files')], [true, true]);
check('send_survey passes through', hits[5].body, { state: 'resolved', send_survey: false });
check('the upload tool answers the new id', text(106).includes('502'), true);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
