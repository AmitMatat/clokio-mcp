// Task #7616: files placed INSIDE a comment through clokio_add_task_comment.
//
// Run by hand:  npm run build && node test/comment-files-7616.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
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

let attId = 500;
const run = await runTools({
  toolsets: 'tasks',
  calls: [
    ['clokio_add_task_comment', { id: 7616, body: 'Here are the **files**', file_paths: [png, pdf, mov] }],
    ['clokio_add_task_comment', { id: 7616, body: 'Older server', file_paths: [zip] }],
    ['clokio_add_task_comment', { id: 7616, body: 'No files' }],
    ['clokio_add_task_comment', { id: 7616, body: 'Missing', file_paths: [join(dir, 'nope.pdf')] }],
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
      const data = name === 'old-server.zip' ? { id, file_name: name } : { id, file_name: name, url: `/tasks/attachments/${id}/download` };
      return { status: 201, json: { status: 'success', data } };
    }
    return undefined;
  },
});

const comments = run.hits.filter((h) => h.path === '/tasks/7616/comments');
const first = comments[0]?.body?.body ?? '';
has('the text is kept as HTML', first, '<strong>files</strong>');
has('an image is shown inline', first, '<img src="/tasks/media/tasks/org-1/7616/media/shot.png" alt="shot.png">');
has('a pdf is a 📎 link to its web url, name escaped', first, '<a href="/tasks/attachments/501/download">📎 Quote &lt;v2&gt;.pdf</a>');
has('a video is a video', first, '<video src="/tasks/media/tasks/org-1/7616/media/demo.mov" controls></video>');
check('files keep their order after the text', [first.indexOf('shot.png') < first.indexOf('Quote'), first.indexOf('Quote') < first.indexOf('demo.mov'), first.indexOf('files') < first.indexOf('shot.png')], [true, true, true]);
check('the uploads ran before the comment', run.hits.slice(0, 4).map((h) => h.path), ['/tasks/7616/media', '/tasks/7616/attachments', '/tasks/7616/media', '/tasks/7616/comments']);
has('a server without url still gets the web link', comments[1]?.body?.body ?? '', '<a href="/tasks/attachments/502/download">📎 old-server.zip</a>');
check('no files: the body is unchanged', comments[2]?.body?.body, '<p>No files</p>');
check('an unreadable file posts no comment', [run.errored(3), comments.length], [true, 3]);
has('the tool tells the model how', run.tools.clokio_add_task_comment?.description ?? '', 'file_paths');

done();
