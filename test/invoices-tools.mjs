// 0.34.0: the read-only `invoices` toolset over GET /invoices, /invoices/month,
// /invoices/{id}, /tasks/{id}/billing, /clients/{id}/billing-summary and
// /clients/{id}/unbilled.
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
check('billing month', [h[7]?.method, h[7]?.path, h[7]?.search], ['GET', '/invoices/month', '?month=2026-10']);
check('unbilled', [h[8]?.method, h[8]?.path, h[8]?.search], ['GET', '/clients/7/unbilled', '?month=2026-10']);
check('unbilled, No Client bucket, with employees', [h[9]?.method, h[9]?.path, h[9]?.search], ['GET', '/clients/0/unbilled', '?month=2026-10&include=employees']);

for (const [i, label] of [
  [10, 'a one-digit month'], [11, 'per_page 101'], [12, 'per_page 0'], [13, 'an unknown status'],
  [14, 'a month in words'], [15, 'a full date as month'], [16, 'a two-digit year'], [17, 'invoice id 0'], [18, 'a negative task id'],
]) check(`${label} is refused locally`, run.errored(i), true);
check('only the ten good calls went out', h.length, 10);
check('every request was a GET', h.every((x) => x.method === 'GET'), true);

const t = (n) => run.tools[n];
for (const n of NAMES) {
  const d = t(n)?.description ?? '';
  has(`${n} names the scope`, d, 'invoices:read');
  has(`${n} names the billing-access rule`, d, 'NO_BILLING_ACCESS');
  check(`${n} has no em-dash`, d.includes('—'), false);
  check(`${n} is not marked as mutating`, /destructive|mutat/i.test(JSON.stringify(t(n)?.annotations ?? {})) && t(n)?.annotations?.readOnlyHint === false, false);
}
has('list says paid is a mark set in Clokio', t('clokio_list_invoices')?.description, 'not a payment record');
has('summary says totals are per currency', t('clokio_get_client_billing_summary')?.description, 'per currency');
has('list says no iCount', t('clokio_list_invoices')?.description, 'iCount');

done();
