// requestUpload(): multipart file upload, key stays in the header, body
// carries the bytes. Run by hand: node test/upload.mjs
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { requestUpload } from '../dist/client.js';
let received = null;
const srv = createServer((req, res) => {
  let body = []; req.on('data', c => body.push(c));
  req.on('end', () => {
    received = { ct: req.headers['content-type'], key: req.headers['x-api-key'], len: Buffer.concat(body).length };
    res.writeHead(201, {'content-type':'application/json'});
    res.end(JSON.stringify({status:'success', data:{id:7, file_name:'note.txt'}}));
  });
});
srv.listen(0,'127.0.0.1'); await once(srv,'listening');
const cfg = { baseUrl:`http://127.0.0.1:${srv.address().port}`, apiKey:'clk_x' };
writeFileSync('/tmp/clokio-upload-note.txt', 'hello attachment');
const r = await requestUpload(cfg, '/tasks/1/attachments', '/tmp/clokio-upload-note.txt', { uploaded_by_employee_code: '00055' });
let f=0; const ck=(l,g,w)=>{const ok=g===w;if(!ok)f++;console.log(`${ok?'PASS':'FAIL'} ${l}: ${JSON.stringify(g)}`);};
ck('multipart content-type', received.ct?.startsWith('multipart/form-data'), true);
ck('key sent as header', received.key, 'clk_x');
ck('body carries the file bytes', received.len > 16, true);
ck('returns unwrapped data', r.id, 7);
srv.close();
console.log(f===0?'\nALL PASS':`\n${f} FAILED`); process.exit(f?1:0);
