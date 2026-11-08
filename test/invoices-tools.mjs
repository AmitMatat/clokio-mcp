// 0.34.0: the read-only `invoices` toolset over GET /invoices, /invoices/month,
// /invoices/{id}, /tasks/{id}/billing, /clients/{id}/billing-summary and
// /clients/{id}/unbilled.
// 0.35.0 (round 2): billing month filters + compact by default, include_activities,
// min_total, client_id 0, descriptions for amount / draft / No Client 0 /
// missing_rate / task_state / employees_scope.
//
// Run by hand:  npm run build && node test/invoices-tools.mjs
import { checker, runTools } from './support/harness.mjs';

const { check, has, done } = checker();

const NAMES = [
  'clokio_list_invoices',
  'clokio_get_invoice',
  'clokio_get_task_billing',
  'clokio_get_client_billing_summary',
  'clokio_get_billing_month',
  'clokio_get_client_unbilled',
];

const run = await runTools({
  toolsets: 'invoices',
  calls: [
    ['clokio_list_invoices', {}], // 0
    ['clokio_list_invoices', { client_id: 7, number: 'INV-0012', from_month: '2026-01', to_month: '2026-06', status: ['sent', 'paid'], per_page: 50, page: 2 }], // 1
    ['clokio_get_invoice', { id: 12 }], // 2
    ['clokio_get_invoice', { id: 12, include_employees: true }], // 3
    ['clokio_get_task_billing', { task_id: 41 }], // 4
    ['clokio_get_client_billing_summary', { client_id: 7 }], // 5
    ['clokio_get_client_billing_summary', { client_id: 7, from_month: '2026-01', to_month: '2026-06' }], // 6
    ['clokio_get_billing_month', { month: '2026-10' }], // 7
    ['clokio_get_client_unbilled', { client_id: 7, month: '2026-10' }], // 8
    ['clokio_get_client_unbilled', { client_id: 0, month: '2026-10', include_employees: true }], // 9 "No Client" bucket
    // refused locally, no request sent
    ['clokio_list_invoices', { from_month: '2026-1' }], // 10
    ['clokio_list_invoices', { per_page: 101 }], // 11
    ['clokio_list_invoices', { per_page: 0 }], // 12
    ['clokio_list_invoices', { status: ['open'] }], // 13
    ['clokio_get_billing_month', { month: 'October' }], // 14
    ['clokio_get_client_unbilled', { client_id: 7, month: '2026-10-01' }], // 15
    ['clokio_get_client_billing_summary', { client_id: 7, to_month: '26-10' }], // 16
    ['clokio_get_invoice', { id: 0 }], // 17
    ['clokio_get_task_billing', { task_id: -3 }], // 18
    ['clokio_get_billing_month', { month: '2026-13' }], // 19
    ['clokio_list_invoices', { to_month: '2026-00' }], // 20
    ['clokio_get_billing_month', { month: '2026-12' }], // 21 (the last valid month)
    // 0.35.0
    ['clokio_list_invoices', { min_total: 100.5 }], // 22
    ['clokio_list_invoices', { client_id: 0 }], // 23 No Client invoices
    ['clokio_get_invoice', { id: 12, include_activities: true }], // 24
    ['clokio_get_invoice', { id: 12, include_employees: true, include_activities: true }], // 25
    ['clokio_get_billing_month', { month: '2026-10', client_ids: [0, 12], only_not_invoiced: true, exclude_dismissed: false, min_billable_hours: 1.5, compact: false }], // 26
    ['clokio_list_invoices', { min_total: -1 }], // 27 refused
    ['clokio_get_billing_month', { month: '2026-10', client_ids: [-1] }], // 28 refused
    ['clokio_get_billing_month', { month: '2026-10', min_billable_hours: -0.5 }], // 29 refused
    ['clokio_get_billing_month', { month: '2026-10', compact: true, exclude_dismissed: true }], // 30
  ],
});

for (const n of NAMES) check(`${n} is registered`, Boolean(run.tools[n]), true);

const h = run.hits;
check('list: bare GET', [h[0]?.method, h[0]?.path, h[0]?.search], ['GET', '/invoices', '']);
check('list: every filter, status as repeated status[]', [h[1]?.method, h[1]?.path, decodeURIComponent(h[1]?.search ?? '')], [
  'GET',
  '/invoices',
  '?client_id=7&number=INV-0012&from_month=2026-01&to_month=2026-06&status[]=sent&status[]=paid&per_page=50&page=2',
]);
check('get invoice', [h[2]?.method, h[2]?.path, h[2]?.search], ['GET', '/invoices/12', '']);
check('get invoice with employees', [h[3]?.method, h[3]?.path, h[3]?.search], ['GET', '/invoices/12', '?include=employees']);
check('task billing', [h[4]?.method, h[4]?.path, h[4]?.search], ['GET', '/tasks/41/billing', '']);
check('billing summary default window', [h[5]?.method, h[5]?.path, h[5]?.search], ['GET', '/clients/7/billing-summary', '']);
check('billing summary window', [h[6]?.method, h[6]?.path, h[6]?.search], ['GET', '/clients/7/billing-summary', '?from_month=2026-01&to_month=2026-06']);
check('billing month is compact by default', [h[7]?.method, h[7]?.path, h[7]?.search], ['GET', '/invoices/month', '?month=2026-10&compact=1']);
check('unbilled', [h[8]?.method, h[8]?.path, h[8]?.search], ['GET', '/clients/7/unbilled', '?month=2026-10']);
check('unbilled, No Client bucket, with employees', [h[9]?.method, h[9]?.path, h[9]?.search], ['GET', '/clients/0/unbilled', '?month=2026-10&include=employees']);

for (const [i, label] of [
  [10, 'a one-digit month'], [11, 'per_page 101'], [12, 'per_page 0'], [13, 'an unknown status'],
  [14, 'a month in words'], [15, 'a full date as month'], [16, 'a two-digit year'], [17, 'invoice id 0'], [18, 'a negative task id'],
  [19, 'month 13'], [20, 'month 00'],
]) check(`${label} is refused locally`, run.errored(i), true);
check('month 12 goes out', [h[10]?.path, h[10]?.search], ['/invoices/month', '?month=2026-12&compact=1']);
check('list: min_total', [h[11]?.path, h[11]?.search], ['/invoices', '?min_total=100.5']);
check('list: client_id 0 is sent (No Client)', [h[12]?.path, h[12]?.search], ['/invoices', '?client_id=0']);
check('get invoice with activities', [h[13]?.path, h[13]?.search], ['/invoices/12', '?include=activities']);
check('get invoice with employees and activities, one comma list', [h[14]?.path, decodeURIComponent(h[14]?.search ?? '')], ['/invoices/12', '?include=employees,activities']);
check('billing month: every filter, full rows', [h[15]?.path, decodeURIComponent(h[15]?.search ?? '')], [
  '/invoices/month',
  '?month=2026-10&client_ids[]=0&client_ids[]=12&only_not_invoiced=1&exclude_dismissed=0&min_billable_hours=1.5&compact=0',
]);
check('billing month: compact true and a flag', [h[16]?.path, h[16]?.search], ['/invoices/month', '?month=2026-10&exclude_dismissed=1&compact=1']);
for (const [i, label] of [[27, 'a negative min_total'], [28, 'a negative client id'], [29, 'negative min_billable_hours']]) {
  check(`${label} is refused locally`, run.errored(i), true);
}
check('only the seventeen good calls went out', h.length, 17);
check('every request was a GET', h.every((x) => x.method === 'GET'), true);

const t = (n) => run.tools[n];
for (const n of NAMES) {
  const d = t(n)?.description ?? '';
  has(`${n} names the scope`, d, 'invoices:read');
  has(`${n} names the billing-access rule`, d, 'NO_BILLING_ACCESS');
  check(`${n} has no em-dash`, d.includes(String.fromCharCode(0x2014)), false);
  check(`${n} is not marked as mutating`, /destructive|mutat/i.test(JSON.stringify(t(n)?.annotations ?? {})) && t(n)?.annotations?.readOnlyHint === false, false);
}
has('get_invoice mentions include_employees', t('clokio_get_invoice')?.description, 'include_employees');
has('list says paid is a mark set in Clokio', t('clokio_list_invoices')?.description, 'not a payment record');
has('summary says totals are per currency', t('clokio_get_client_billing_summary')?.description, 'per currency');
has('list says no iCount', t('clokio_list_invoices')?.description, 'iCount');

// Final fix wave M1/M2: the unbilled answer is not billable-only, and a task
// line lists everyone on the task in the period.
const unbilled = t('clokio_get_client_unbilled')?.description ?? '';
has('unbilled says finished web-timer entries', unbilled, 'finished web-timer entries');
has('unbilled says non-billable lines come at price 0', unbilled, 'non-billable ones appear with is_billable false and price 0');
has('unbilled says the subtotal counts billable lines only', unbilled, 'subtotal counts billable lines only');
check('unbilled no longer says "billable timer entries"', /billable\s+timer entries/.test(unbilled), false);
for (const n of ['clokio_get_invoice', 'clokio_get_client_unbilled']) {
  const inc = t(n)?.inputSchema?.properties?.include_employees?.description ?? '';
  has(`${n} include_employees says a task line lists everyone on the task`, inc, 'a task line lists everyone who worked that task in the period');
  check(`${n} include_employees has no em-dash`, inc.includes(String.fromCharCode(0x2014)), false);
}

// 0.35.0 descriptions (M4).
const month = t('clokio_get_billing_month')?.description ?? '';
has('billing month says compact by default', month, 'COMPACT BY DEFAULT');
has('billing month says totals follow the filter', month, 'computed over the FILTERED rows');
has('billing month says total is issued only', month, 'ISSUED invoices only');
has('billing month names draft', month, 'draft');
for (const n of ['clokio_get_billing_month', 'clokio_get_client_billing_summary']) {
  const d = t(n)?.description ?? '';
  has(`${n} explains amount vs estimated_amount`, d, 'Use amount, not estimated_amount');
  has(`${n} names missing_rate`, d, 'missing_rate');
}
has('summary says invoiced is issued only', t('clokio_get_client_billing_summary')?.description, 'invoiced counts ISSUED invoices only');
for (const n of ['clokio_list_invoices', 'clokio_get_invoice', 'clokio_get_task_billing', 'clokio_get_billing_month', 'clokio_get_client_unbilled']) {
  has(`${n} says No Client is 0`, t(n)?.description, 'client id 0 everywhere');
}
has('get_invoice names task_state', t('clokio_get_invoice')?.description, 'task_state');
has('get_invoice names include_activities', t('clokio_get_invoice')?.description, 'include_activities');
has('get_invoice names missing_rate', t('clokio_get_invoice')?.description, 'missing_rate');
has('task billing names note', t('clokio_get_task_billing')?.description, 'project_not_billable');
has('list says what invoice_number is', t('clokio_list_invoices')?.description, 'document number');
for (const n of ['clokio_get_invoice', 'clokio_get_client_unbilled']) {
  has(`${n} include_employees names employees_scope`, t(n)?.inputSchema?.properties?.include_employees?.description, 'employees_scope');
}
check('billing month compact is described as default true', /Default true/.test(t('clokio_get_billing_month')?.inputSchema?.properties?.compact?.description ?? ''), true);
for (const n of NAMES) check(`${n} still has no em-dash`, (t(n)?.description ?? '').includes(String.fromCharCode(0x2014)), false);

done();
