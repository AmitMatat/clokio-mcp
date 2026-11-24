// Task #7616: files placed INSIDE a comment through clokio_add_task_comment.
//
// Run by hand:  npm run build && node test/comment-files-7616.mjs
import { mkdtempSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checker, runTools } from './support/harness.mjs';

const { check, has, done } = checker();

const dir = mkdtempSync(join(tmpdir(), 'mcp-7616-'));
const pdf = join(dir, 'Quote <v2>.pdf');
const png = join(dir, 'shot.png');
const mov = join(dir, 'demo.mov');
const zip = join(dir, 'old-server.zip');
writeFileSync(pdf, '%PDF-1.4 x');
writeFileSync(png, 'png');
writeFileSync(mov, 'mov');
writeFileSync(zip, 'zip');
const bigVideo = join(dir, 'long-demo.mp4');
writeFileSync(bigVideo, '');
truncateSync(bigVideo, 51 * 1024 * 1024);

let attId = 500;
const run = await runTools({
  toolsets: 'tasks',
  calls: [
    ['clokio_add_task_comment', { id: 7616, body: 'Here are the **files**', file_paths: [png, pdf, mov] }],
    ['clokio_add_task_comment', { id: 7616, body: 'Older server', file_paths: [zip] }],
    ['clokio_add_task_comment', { id: 7616, body: 'No files' }],
    ['clokio_add_task_comment', { id: 7616, body: 'Missing', file_paths: [join(dir, 'nope.pdf')] }],
    ['clokio_add_task_comment', { id: 7616, body: 'One missing among good ones', file_paths: [pdf, png, join(dir, 'gone.zip')] }],
    ['clokio_add_task_comment', { id: 7616, body: 'Big video', file_paths: [bigVideo] }],
    ['clokio_add_task_comment', { id: 7616, body: 'Credited', author_employee_code: '00099', file_paths: [pdf] }],
    ['clokio_add_task_comment', { id: 7616, body: 'x'.repeat(65400), file_paths: [pdf] }],
  ],
  respond: (hit) => {
    if (hit.path === '/tasks/7616/media') {
      const name = /filename="([^"]+)"/.exec(hit.body.multipart)?.[1];
      return { json: { status: 'success', data: { url: `/tasks/media/tasks/org-1/7616/media/${name}` } } };
    }
    if (hit.path === '/tasks/7616/attachments') {
      const name = /filename="([^"]+)"/.exec(hit.body.multipart)?.[1];
      const id = ++attId;
      // The zip answers like a server without `url` (before #7616).
      const data = name === 'old-server.zip' ? { id, file_name: name } : { id, file_name: name, url: `https://app.example.test/tasks/attachments/${id}/download` };
      return { status: 201, json: { status: 'success', data } };
    }
    return undefined;
  },
});

const comments = run.hits.filter((h) => h.path === '/tasks/7616/comments');
const first = comments[0]?.body?.body ?? '';
has('the text is kept as HTML', first, '<strong>files</strong>');
has('an image is shown inline', first, '<img src="/tasks/media/tasks/org-1/7616/media/shot.png" alt="shot.png">');
has('a pdf is a 📎 link to its web url, name escaped', first, '<a href="https://app.example.test/tasks/attachments/501/download">📎 Quote &lt;v2&gt;.pdf</a>');
has('a video is a video', first, '<video src="/tasks/media/tasks/org-1/7616/media/demo.mov" controls></video>');
check('a video is a block, never inside a paragraph', first.includes('<p><video'), false);
check('files keep their order after the text', [first.indexOf('shot.png') < first.indexOf('Quote'), first.indexOf('Quote') < first.indexOf('demo.mov'), first.indexOf('files') < first.indexOf('shot.png')], [true, true, true]);
check('the uploads ran before the comment', run.hits.slice(0, 4).map((h) => h.path), ['/tasks/7616/media', '/tasks/7616/attachments', '/tasks/7616/media', '/tasks/7616/comments']);
const oldServer = comments[1]?.body?.body ?? '';
check('a server without url still gets a FULL web link (the app opens links with launchUrl)', /<a href="http:\/\/127\.0\.0\.1:\d+\/tasks\/attachments\/502\/download">📎 old-server\.zip<\/a>/.test(oldServer), true);
check('no files: the body is unchanged', comments[2]?.body?.body, '<p>No files</p>');
check('an unreadable file posts no comment', [run.errored(3), comments.length >= 3], [true, true]);
const uploadsBefore = (i) => run.hits.filter((h) => h.callIndex === i && h.path !== '/tasks/7616/comments').length;
check('one missing file among good ones: refused before ANY upload', [run.errored(4), uploadsBefore(4)], [true, 0]);
has('the refusal names the missing file', run.text(4), 'gone.zip');
const bigHits = run.hits.filter((h) => h.callIndex === 5).map((h) => h.path);
check('a video over 50 MB goes as an attachment link, not inline media', bigHits, ['/tasks/7616/attachments', '/tasks/7616/comments']);
const credited = run.hits.find((h) => h.callIndex === 6 && h.path === '/tasks/7616/attachments');
check('the upload is not credited to the comment author (a code outside the organisation would fail it)', credited?.body?.multipart?.includes('00099'), false);
check('a body that would pass the comment limit with its files is refused before any upload', [run.errored(7), uploadsBefore(7)], [true, 0]);
has('the tool tells the model how', run.tools.clokio_add_task_comment?.description ?? '', 'file_paths');

done();
