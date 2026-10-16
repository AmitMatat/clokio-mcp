// 0.22.0 field reports: inline task media (F1) and the assignee refusal (F2).
//
// Run by hand:  npm run build && node test/task-media-022.mjs
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checker, runTools } from './support/harness.mjs';
import { inlineMediaPaths, inlineMediaRows } from '../dist/attachments.js';
import { assigneeReference } from '../dist/tools/tasks.js';

const { check, has, done } = checker();

const A = 'tasks/org-1/5741/media/YQKeCpiAbc123.jpg';
const B = 'tasks/org-1/5700/media/Zz9.png';
const html = `<p>Bug:</p><img src="/tasks/media/${A}"><img src="/tasks/media/${A}">` +
  `<img src="https://bucket.fra1.digitaloceanspaces.com/${B}?X-Amz=1">` +
  `<a href="/tasks/media/tasks/org-1/5741/report.pdf">report</a>` +
  `<img src="/tasks/media/tasks/org-1/drafts/emp-3/media/d.png">`;

check('paths: media only, deduped, query cut, drop-in and draft shapes ignored', inlineMediaPaths(html), [A, B]);
check('no html, no paths', [inlineMediaPaths(''), inlineMediaPaths(undefined)], [[], []]);
check('rows name their source in order of first appearance', inlineMediaRows(
  { id: 5741, description: `<img src="/tasks/media/${A}">` },
  [{ id: 9, body: `<img src="/tasks/media/${A}"><img src="/tasks/media/${B}">` }]
), [
  { path: A, file_name: 'YQKeCpiAbc123.jpg', source: 'description' },
  { path: B, file_name: 'Zz9.png', source: 'comment', comment_id: 9 },
]);

// F2: the refusal names the object form; nothing is converted.
const msg = (v) => assigneeReference.safeParse(v).error?.issues?.[0]?.message ?? '';
has('"313:00002" names the object', msg('313:00002'), '{"employee_code": "00002", "organization_id": 313}');
has('"313/00002" too', msg('313/00002'), '{"employee_code": "00002", "organization_id": 313}');
has('a stringified object is told to send an object', msg('{"employee_code":"00002","organization_id":313}'), 'Send the person as a JSON object, not a string');
has('a bad plain code keeps the code rule and names the object form', msg('00 02'), 'organization_id');
has('an object missing organization_id names both forms', msg({ employee_code: '00002' }), 'Each assignee is an employee_code string');
check('the two valid forms still pass', [assigneeReference.safeParse('00080').success, assigneeReference.safeParse({ employee_code: '00002', organization_id: 313 }).success], [true, true]);

const dir = mkdtempSync(join(tmpdir(), 'mcp-media-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
const run = await runTools({
  toolsets: 'tasks',
  calls: [
    ['clokio_list_task_attachments', { id: 5741 }],
    ['clokio_download_task_media', { id: 5741, path: A }],
    ['clokio_download_task_media', { id: 5741, path: B, save_path: join(dir, 'b.png') }],
    ['clokio_download_task_media', { id: 5741, path: '../../etc/passwd' }],
  ],
  respond: (hit) => {
    if (hit.path === '/tasks/5741/attachments') return { json: { status: 'success', data: [{ id: 88, file_name: 'spec.pdf', file_size: 10 }] } };
    if (hit.path === '/tasks/5741') return { json: { status: 'success', data: { id: 5741, description: `<img src="/tasks/media/${A}">` } } };
    if (hit.path === '/tasks/5741/comments') return { json: { status: 'success', data: [{ id: 9, body: `<img src="/tasks/media/${B}">` }] } };
    if (hit.path === '/tasks/5741/media') return { bytes: PNG, headers: { 'content-type': 'image/png' } };
    return undefined;
  },
});

const listed = JSON.parse(run.text(0));
check('attachments keep their rows', listed.attachments.map((r) => r.id), [88]);
check('inline media is listed beside them', listed.inline_media.map((r) => [r.path, r.source]), [[A, 'description'], [B, 'comment']]);
const mediaHits = run.hits.filter((h) => h.path === '/tasks/5741/media');
check('the download sends the path as a query value', mediaHits.map((h) => h.query), [{ path: A }, { path: B }]);
check('an image comes back as an image', run.content(1).some((c) => c.type === 'image'), true);
check('save_path writes the bytes', readFileSync(join(dir, 'b.png')).equals(PNG), true);
has('save_path answers a sha256', run.text(2), 'sha256');
check('a path of another shape is refused before any request', [run.errored(3), mediaHits.length], [true, 2]);
check('download_task_media is read-only', run.tools.clokio_download_task_media?.annotations?.readOnlyHint, true);
has('get_task points at inline media', run.tools.clokio_get_task?.description ?? '', 'clokio_download_task_media');
has('set_task_assignees forbids the org:code string', run.tools.clokio_set_task_assignees?.description ?? '', 'Never write a client\'s person as one string like "313:00002"');

done();
