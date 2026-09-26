// Security regression test: a tool argument must never change WHICH endpoint
// is called.
//
// `employee_code` is a string interpolated into the request path. new URL()
// normalises the assembled string, so before the fix a value like
// `00080/pin?x=.` turned a call the user approved as "set employee status"
// (PATCH /employees/{code}/status) into PATCH /employees/00080/pin - which
// resets that person's clock-in PIN and returns the new PIN in the response.
// `../..` climbed out of /api/v1 entirely.
//
// Run by hand:  node test/path-safety.mjs

import { seg } from '../dist/client.js';

const BASE = 'https://app.clokio.io';
const build = (path) =>
  new URL(`${BASE}/api/v1${path.startsWith('/') ? path : `/${path}`}`);

// The guard client.js applies after building the URL.
const PREFIX = new URL(BASE).pathname.replace(/\/+$/, '') + '/api/v1/';
const insideApi = (url) => url.pathname.startsWith(PREFIX);

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${got}${ok ? '' : `   (want ${want})`}`);
};

// The exact payloads from the security review.
const ATTACKS = [
  '00080/pin?x=.',   // endpoint pivot to /pin - the high-severity one
  '../..',           // climb out of /api/v1
  '../../employees', // climb sideways
  '00080/pin',       // bare extra segment
  '00080?x=',        // bare query truncation
  '00080#frag',      // fragment truncation
];

console.log('=== unencoded (the vulnerable shape) reaches a DIFFERENT endpoint ===');
for (const a of ATTACKS) {
  const u = build(`/employees/${a}/status`);
  const pivoted = !u.pathname.endsWith('/status') || !insideApi(u);
  console.log(`   ${JSON.stringify(a).padEnd(22)} -> ${u.pathname}${u.search}  ${pivoted ? '(PIVOTED)' : ''}`);
}

console.log('\n=== with seg(), every attack stays on the intended endpoint ===');
for (const a of ATTACKS) {
  const u = build(`/employees/${seg(a)}/status`);
  check(
    `seg(${JSON.stringify(a)}) stays on /status`,
    u.pathname.endsWith('/status') && insideApi(u) && u.search === '',
    true
  );
}

// A legitimate code must still work untouched.
check('a normal code is unchanged', seg('00080'), '00080');
check(
  'a normal code builds the intended path',
  build(`/employees/${seg('00080')}/status`).pathname,
  '/api/v1/employees/00080/status'
);

// The sink guard catches traversal even if a caller forgets seg().
console.log('\n=== sink guard: /api/v1 prefix invariant ===');
check('unencoded ../.. escapes /api/v1 (guard must reject)', insideApi(build('/employees/../../x')), false);
check('seg-encoded ../.. stays inside /api/v1', insideApi(build(`/employees/${seg('../..')}/x`)), true);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
