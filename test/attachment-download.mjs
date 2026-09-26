// requestRaw(): the attachment download path.
//
// It differs from every other call in three ways that each caused a defect,
// all found in review before release:
//
//  1. THE API REDIRECTS. Files over 8 MB answer 302 with a short-lived signed
//     storage URL. The first version sent redirect: 'error', which reported
//     every large attachment as a bogus "Network error reaching Clokio".
//     Letting fetch follow it would be worse: Node re-sends request headers
//     across the redirect, handing X-API-Key to the storage origin. So the
//     redirect is followed BY HAND, with no credential attached.
//  2. CONTENT-TYPE LIES, on purpose. The API re-labels html/json/js/svg/xml
//     attachments as application/octet-stream so a browser cannot render them
//     from our origin. Trusting the header alone reported a JSON report as
//     unreadable binary, so the file extension gets a say.
//  3. TEXT IS NOT AUTOMATICALLY SAFE TO PASTE. Attachments go to 200 MB and
//     .csv/.log are allowed, so a 40 MB CSV would land whole in the
//     conversation.
//
// Run by hand:  node test/attachment-download.mjs

import { createServer } from 'node:http';
import { once } from 'node:events';
import { requestRaw, ClokioApiError } from '../dist/client.js';

const KEY = 'clk_key_that_must_not_reach_storage';

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(got)}${ok ? '' : `   (want ${JSON.stringify(want)})`}`);
};

// Stands in for DO Spaces: records whether a key ever arrives.
const storageHits = [];
const storage = createServer((req, res) => {
  storageHits.push({ url: req.url, key: req.headers['x-api-key'] ?? null });
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(Buffer.alloc(2048, 7));
});
storage.listen(0, '127.0.0.1');
await once(storage, 'listening');
const storageUrl = `http://127.0.0.1:${storage.address().port}`;

// Stands in for the API. Each path exercises one branch.
const api = createServer((req, res) => {
  if (req.url.includes('/big')) {
    res.writeHead(302, { location: `${storageUrl}/signed?sig=abc` });
    return res.end();
  }
  if (req.url.includes('/report')) {
    // A JSON attachment, re-labelled octet-stream exactly as the API does.
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end('{"findings": 3}');
  }
  if (req.url.includes('/huge')) {
    res.writeHead(200, { 'content-type': 'text/csv' });
    return res.end('x'.repeat(250_000));
  }
  if (req.url.includes('/missing')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{"status":"error","message":"Attachment not found."}');
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('a short note');
});
api.listen(0, '127.0.0.1');
await once(api, 'listening');
const config = { baseUrl: `http://127.0.0.1:${api.address().port}`, apiKey: KEY };

console.log('=== a redirected (large) download is followed, without the key ===');
const big = await requestRaw(config, '/tasks/1/attachments/big');
check('the redirect was followed to storage', storageHits.length, 1);
check('and the API key did NOT travel with it', storageHits[0]?.key, null);
check('the binary body is described, not dumped', big.startsWith('[binary file:'), true);
check('the description names the size', big.includes('2.0 KB'), true);

console.log('\n=== content-type is not trusted alone ===');
const asBinary = await requestRaw(config, '/tasks/1/attachments/report');
check('octet-stream with no filename reads as binary', asBinary.startsWith('[binary file:'), true);

const asText = await requestRaw(config, '/tasks/1/attachments/report', 'findings.json');
check('the .json extension reveals it as text', asText, '{"findings": 3}');

console.log('\n=== text is capped ===');
const huge = await requestRaw(config, '/tasks/1/attachments/huge', 'export.csv');
check('a very large text file is truncated', huge.length < 250_000, true);
check('and says so, so a prefix is not mistaken for the whole file', huge.includes('[truncated:'), true);
check('and says how much is missing', huge.includes('more characters not shown'), true);

console.log('\n=== small text passes through untouched ===');
check('a short note is returned verbatim', await requestRaw(config, '/tasks/1/attachments/5'), 'a short note');

console.log('\n=== a redirect to a non-http scheme is refused ===');
// Node refuses file:/javascript: on its own, but resolves data: happily - and
// an http(s) target is a blind SSRF. The key does not travel either way, so
// this is defence in depth, not a live hole.
const evil = createServer((req, res) => {
  res.writeHead(302, { location: 'data:text/plain,pwned' });
  res.end();
});
evil.listen(0, '127.0.0.1');
await once(evil, 'listening');
const evilConfig = { baseUrl: `http://127.0.0.1:${evil.address().port}`, apiKey: KEY };

let schemeErr = null;
try {
  await requestRaw(evilConfig, '/tasks/1/attachments/9');
} catch (e) {
  schemeErr = e;
}
check('a data: redirect is refused', schemeErr instanceof ClokioApiError, true);
check('and says why', (schemeErr?.message ?? '').includes('Refusing to follow'), true);
evil.close();

console.log('\n=== errors still surface the API message ===');
let err = null;
try {
  await requestRaw(config, '/tasks/1/attachments/missing');
} catch (e) {
  err = e;
}
check('a 404 throws ClokioApiError', err instanceof ClokioApiError, true);
check('carrying the status', err?.status, 404);
check('and the server message', err?.message, 'Attachment not found.');

api.close();
storage.close();

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
