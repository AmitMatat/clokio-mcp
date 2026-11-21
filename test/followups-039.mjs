// 0.39.0 follow-ups outside the forms toolset: clokio_list_leaves may leave out
// from and to (the server answers the last 30 days); a reply or new ticket
// holding an unfinished placeholder is refused by the server (422
// PLACEHOLDER_IN_REPLY) and its words pass through as-is; clokio_move_doc says
// how inheriting sub-pages and projects follow the new parent.
//
// Run by hand:  npm run build && node test/followups-039.mjs
import { checker, runTools } from './support/harness.mjs';

const { check, has, done } = checker();

const PLACEHOLDER = 'The reply still holds an unfinished placeholder: [TODO price]. Finish it or save a draft.';
const refuse = { status: 422, json: { status: 'error', code: 'PLACEHOLDER_IN_REPLY', message: PLACEHOLDER, errors: { html: [PLACEHOLDER] } } };

const run = await runTools({
  toolsets: 'attendance,tickets,docs',
  calls: [
    ['clokio_list_leaves', {}], // 0 neither: nothing sent
    ['clokio_list_leaves', { from: '2026-10-01', to: '2026-10-31' }], // 1 both
    ['clokio_list_leaves', { from: '2026-10-01' }], // 2 one: the server answers
    ['clokio_list_leaves', { from: '2026-01-01', to: '2026-12-31' }], // 3 both, too long: refused locally
    ['clokio_list_leaves', { status: 'APPROVED' }], // 4 neither, with a filter
    ['clokio_reply_ticket', { id: 5, body: 'Price is [TODO price]' }], // 5 refused by the server
    ['clokio_create_ticket', { channel: 'email', inbox_id: 2, to: ['a@example.com'], subject: 'Hi', body: 'See [להשלים]' }], // 6 refused by the server
  ],
  respond: (hit) => {
    if (hit.path === '/leaves') return { status: 200, json: { status: 'success', message: 'ok', data: [], meta: {} } };
    if (hit.method === 'POST' && (hit.path === '/tickets/5/replies' || hit.path === '/tickets')) return refuse;
    return undefined;
  },
});

const leaves = run.hits.filter((x) => x.path === '/leaves').map((x) => x.search);
check('leaves: neither sends no from/to; both send both; one sends one; a filter alone', leaves, ['', '?from=2026-10-01&to=2026-10-31', '?from=2026-10-01', '?status=APPROVED']);
check('leaves: a range over 92 days is still refused before a request', run.errored(3), true);
check('leaves: from and to are optional in the schema', (run.tools.clokio_list_leaves.inputSchema.required ?? []).filter((r) => r === 'from' || r === 'to'), []);
has('leaves: the description says the last 30 days', run.tools.clokio_list_leaves.description, 'last 30 days');

check('reply: placeholder refusal is an error', run.errored(5), true);
has('reply: the server message passes through as-is', run.text(5), PLACEHOLDER);
has('reply: the code passes through', run.text(5), 'PLACEHOLDER_IN_REPLY');
check('create ticket: placeholder refusal is an error', run.errored(6), true);
has('create ticket: the server message passes through as-is', run.text(6), PLACEHOLDER);
for (const n of ['clokio_reply_ticket', 'clokio_create_ticket']) {
  has(`${n}: says unfinished placeholders are refused`, run.tools[n].description, '[TODO ...], [להשלים ...]');
  has(`${n}: points at a draft`, run.tools[n].description, 'clokio_create_reply_draft');
}

const move = run.tools.clokio_move_doc.description;
has('move_doc: inheriting children take the new parent\'s access', move, 'inherit_permissions true take the visibility and access of their new parent');
has('move_doc: the parent\'s project wins across projects', move, 'the parent\'s project wins, also when moving across projects');

const em = String.fromCharCode(0x2014);
check('no em dash in the touched descriptions', ['clokio_list_leaves', 'clokio_reply_ticket', 'clokio_create_ticket', 'clokio_move_doc'].some((n) => run.tools[n].description.includes(em)), false);

done();
