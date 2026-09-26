// Security regression test: the API key must never follow a redirect.
//
// Node's fetch follows 3xx responses by default and re-sends the original
// request headers - X-API-Key included - to the Location target, whatever its
// origin. The Clokio API never redirects an /api/v1 call, so a redirect can
// only come from something that is NOT the API (a captive portal, a hijacked
// CLOKIO_BASE_URL, a misconfigured proxy). client.js sends redirect: 'error'.
//
// This test stands up two local servers: "api" answers 302 -> "sink", and
// "sink" records every request it receives. The property under test is that
// the sink NEVER sees the key. Break-verify: remove `redirect: 'error'` from
// client.js and this fails with the key captured.
//
// Run by hand:  node test/redirect-safety.mjs

import { createServer } from 'node:http';
import { once } from 'node:events';
import { request, ClokioApiError } from '../dist/client.js';

const KEY = 'clk_test_key_that_must_not_leak';

const sinkHits = [];
const sink = createServer((req, res) => {
  sinkHits.push({ url: req.url, key: req.headers['x-api-key'] ?? null });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"status":"success","data":{"leaked":true}}');
});
sink.listen(0, '127.0.0.1');
await once(sink, 'listening');
const sinkUrl = `http://127.0.0.1:${sink.address().port}`;

const api = createServer((req, res) => {
  res.writeHead(302, { location: `${sinkUrl}/captured${req.url}` });
  res.end();
});
api.listen(0, '127.0.0.1');
await once(api, 'listening');
const apiUrl = `http://127.0.0.1:${api.address().port}`;

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(got)}${ok ? '' : `   (want ${JSON.stringify(want)})`}`);
};

let error = null;
try {
  await request({ baseUrl: apiUrl, apiKey: KEY }, '/employees');
} catch (e) {
  error = e;
}

check('the request fails instead of following the redirect', error instanceof ClokioApiError, true);
check('it is reported as a network-level failure (status 0)', error?.status, 0);
check('the redirect target received NO request', sinkHits.length, 0);
check('and therefore never saw the key', sinkHits.some((h) => h.key === KEY), false);

api.close();
sink.close();

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
