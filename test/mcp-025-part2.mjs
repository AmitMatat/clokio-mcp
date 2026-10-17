// 0.25.0 part 2: the tools that need the 0.25 backend (task #5808 #5, #9, E7).
//   E7  a replay (header Idempotency-Replayed: true, or data.replayed) answers
//       "already created ... (replayed ...)" on the task-from-ticket create,
//       the reply and the new ticket.
//   #5  clokio_create_ticket: email and WhatsApp bodies, the per-channel
//       refusals before any request, the Idempotency-Key, draft, reuse.
//   #9  clokio_list_tickets filters and sort; clokio_create_ticket_label;
//       clokio_create_contact (409 names the existing contact).
//
// Run by hand:  npm run build && node test/mcp-025-part2.mjs
import { checker, runTools } from './support/harness.mjs';
import { OLDER_SERVER_HINT, NEW_ROUTE_HINT, isReplay } from '../dist/tools/tickets.js';

const { check, has, done } = checker();
const OK = (data, extra = {}) => ({ status: 201, json: { status: 'success', message: 'ok', data }, ...extra });
const REPLAYED = { headers: { 'Idempotency-Replayed': 'true' } };
let rk_count = 0; // the retry test answers fresh first, then replayed

// ── isReplay ────────────────────────────────────────────────────────────
check('isReplay: header', isReplay(new Headers({ 'Idempotency-Replayed': 'true' }), {}), true);
check('isReplay: body flag', isReplay(null, { replayed: true }), true);
check('isReplay: fresh answer', isReplay(new Headers(), { replayed: false }), false);
check('isReplay: header false', isReplay(new Headers({ 'Idempotency-Replayed': 'false' }), {}), false);

// ── E7: replay wording on create task from ticket ──────────────────────
const TASK = { ticket_id: 12, task: { id: 5900, title: 'Fix', task_url: 'https://app.example/tasks/5900/view' }, skipped_files: [] };
const tf = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_create_task_from_ticket', { id: 12, project_id: 4, title: 'Fix', idempotency_key: 'retry-key-1' }],
    ['clokio_create_task_from_ticket', { id: 13, project_id: 4, title: 'Fix', idempotency_key: 'retry-key-2' }],
    ['clokio_create_task_from_ticket', { id: 14, project_id: 4, title: 'Fix' }],
  ],
  respond: (hit) => {
    if (hit.path === '/tickets/12/tasks') return OK({ ...TASK, replayed: false }, REPLAYED);
    if (hit.path === '/tickets/13/tasks') return OK({ ...TASK, replayed: true });
    return OK({ ...TASK, replayed: false });
  },
});
const tf0 = JSON.parse(tf.text(0));
has('header replay: the task says already created', tf0.created, 'Task #5900 was already created from this ticket (replayed, no new task)');
has('body replay: the same wording', JSON.parse(tf.text(1)).created, '(replayed, no new task)');
has('fresh: the old wording', JSON.parse(tf.text(2)).created, 'Task #5900 created from ticket #12');
check('...with no replay word', JSON.parse(tf.text(2)).created.includes('replayed'), false);
check('the supplied key was sent', tf.hits[0].idempotencyKey, 'retry-key-1');

// ── E7: replay on a reply ───────────────────────────────────────────────
const rp = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_reply_ticket', { id: 7, body: 'Hello' }],
    ['clokio_reply_ticket', { id: 8, body: 'Hello' }],
  ],
  respond: (hit) =>
    hit.path === '/tickets/7/replies'
      ? OK({ message_id: 70, ticket_id: 7, delivery: 'queued', replayed: true }, REPLAYED)
      : OK({ message_id: 80, ticket_id: 8, delivery: 'queued', replayed: false }),
});
has('a replayed reply says nothing new was sent', rp.text(0), 'Reply message #70 was already sent on ticket #7 (replayed, nothing new sent).');
check('a fresh reply has no replay note', rp.text(1).includes('replayed_note'), false);
check('each reply carries its own key', rp.hits[0].idempotencyKey !== rp.hits[1].idempotencyKey && /^mcp-/.test(rp.hits[0].idempotencyKey), true);
const rk = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_reply_ticket', { id: 9, body: 'Hello', idempotency_key: 'reply-retry-1' }],
    ['clokio_reply_ticket', { id: 9, body: 'Hello', idempotency_key: 'reply-retry-1' }],
    ['clokio_reply_ticket', { id: 9, body: 'Hello', idempotency_key: 'bad key!' }],
  ],
  respond: (hit) => {
    const n = rk_count++;
    return n === 0
      ? OK({ message_id: 90, ticket_id: 9, delivery: 'queued', replayed: false })
      : OK({ message_id: 90, ticket_id: 9, delivery: 'queued', replayed: true }, REPLAYED);
  },
});
check('reply: the supplied key is sent on both calls', rk.hits.map((h) => h.idempotencyKey), ['reply-retry-1', 'reply-retry-1']);
check('reply: the first answer is fresh and returns the key', [rk.text(0).includes('replayed_note'), JSON.parse(rk.text(0)).idempotency_key], [false, 'reply-retry-1']);
has('reply: the retry is a replay, nothing new sent', rk.text(1), 'Reply message #90 was already sent on ticket #9 (replayed, nothing new sent).');
check('reply: a malformed key is refused before any request', [rk.errored(2), rk.hits.length], [true, 2]);
check('reply: a fresh key is returned when none is given', /^mcp-/.test(JSON.parse(rp.text(1)).idempotency_key), true);
const rdesc = rk.tools.clokio_reply_ticket?.description ?? '';
has('reply: WhatsApp part points at the template list', rdesc, 'clokio_list_whatsapp_templates');
has('reply: an email draft ticket uses the drafted recipients', rdesc, 'the first reply goes to the drafted To/Cc/Bcc with the drafted subject');
has('reply: the draft then reads used', rdesc, 'the draft then reads "used"');
has('task from ticket: an invisible project is the project sentence', rk.tools.clokio_create_task_from_ticket?.description ?? '', 'one the acting employee cannot see is 404 "That project is not available."');
has('reply description explains the safe retry', rdesc, 'To retry SAFELY');
has('...with the same key and fields', rdesc, 'pass the SAME idempotency_key and the same fields');
check('reply stays destructive', rk.tools.clokio_reply_ticket?.annotations?.destructiveHint, true);

// ── #5: clokio_create_ticket ────────────────────────────────────────────
const TICKET = (id, extra = {}) => ({
  id, state: 'open', subject: 'Your order', channel: { type: 'email', inbox_id: 3, name: 'Support' },
  assignee: { employee_code: '00055', name: 'Amit' }, labels: [], contact: { id: 40, name: 'Dana', emails: ['dana@x.co'], phones: [] },
  waiting_since: null, updated_at: '2026-10-17T08:00:00Z', ticket_url: `https://app.example/tickets/${id}`, ...extra,
});
const ct = await runTools({
  toolsets: 'tickets',
  calls: [
    /*0*/ ['clokio_create_ticket', { channel: 'email', inbox_id: 3, to: ['dana@x.co'], cc: ['b@x.co'], subject: 'Your order', body: '**Hi** Dana' }],
    /*1*/ ['clokio_create_ticket', { channel: 'email', inbox_id: 3, to: 'dana@x.co', subject: 'S', body: 'b', draft: true }],
    /*2*/ ['clokio_create_ticket', { channel: 'whatsapp', inbox_id: 5, to: '+972501234567', template: { name: 'order_update', language: 'he', params: ['1234'] } }],
    /*3*/ ['clokio_create_ticket', { channel: 'whatsapp', inbox_id: 5, to: '+972501234567', template: { name: 'order_update', language: 'he', params: { order: '1' } }, idempotency_key: 'my-retry-key' }],
    /*4*/ ['clokio_create_ticket', { channel: 'whatsapp', inbox_id: 5, to: '+972501234567', body: 'hello' }],
    /*5*/ ['clokio_create_ticket', { channel: 'email', inbox_id: 3, to: ['a@x.co'], subject: 'S', body: 'b', template: { name: 'n', language: 'en' } }],
    /*6*/ ['clokio_create_ticket', { channel: 'email', inbox_id: 3, to: ['a@x.co'], body: 'b' }],
    /*7*/ ['clokio_create_ticket', { channel: 'email', inbox_id: 3, subject: 'S', body: 'b' }],
    /*8*/ ['clokio_create_ticket', { channel: 'email', inbox_id: 3, contact_id: 40, subject: 'S', body: 'b', assignee_employee_code: '00042' }],
    /*9*/ ['clokio_create_ticket', { channel: 'whatsapp', inbox_id: 5, to: '+972501234567' }],
    /*10*/ ['clokio_create_ticket', { channel: 'email', inbox_id: 404, to: ['a@x.co'], subject: 'S', body: 'b' }],
    /*11*/ ['clokio_create_ticket', { channel: 'email', inbox_id: 429, to: ['a@x.co'], subject: 'S', body: 'b' }],
    /*12*/ ['clokio_create_ticket', { channel: 'whatsapp', inbox_id: 5, to: ['+1', '+2'], template: { name: 'n', language: 'en' } }],
  ],
  respond: (hit) => {
    const b = hit.body ?? {};
    if (b.inbox_id === 404) return { status: 404, json: { status: 'error', message: 'Not found.', data: {} } };
    if (b.inbox_id === 429) return { status: 429, json: { status: 'error', message: 'At most 10 new tickets every 10 minutes from one API key. Wait before opening more.', retry_after: 300, data: {} } };
    if (b.draft) return OK({ ticket: TICKET(901), message_id: 9011, draft: true, delivery: null, reused: false, replayed: false });
    if (b.channel === 'whatsapp' && hit.idempotencyKey === 'my-retry-key') {
      return OK({ ticket: TICKET(903, { channel: { type: 'whatsapp', inbox_id: 5, name: 'WA' } }), message_id: 9031, draft: false, delivery: 'queued', reused: false, replayed: true }, REPLAYED);
    }
    if (b.channel === 'whatsapp') return OK({ ticket: TICKET(902, { channel: { type: 'whatsapp', inbox_id: 5, name: 'WA' } }), message_id: 9021, draft: false, delivery: 'queued', reused: true, replayed: false });
    return OK({ ticket: TICKET(900), message_id: 9001, draft: false, delivery: 'queued', reused: false, replayed: false });
  },
});
const posts = ct.hits.filter((h) => h.method === 'POST' && h.path === '/tickets');
const emailHit = posts[0];
check('email: the body sent', emailHit.body, {
  channel: 'email', inbox_id: 3, draft: false, to: ['dana@x.co'], cc: ['b@x.co'], subject: 'Your order', body: '<p><strong>Hi</strong> Dana</p>', body_format: 'html',
});
check('email: an Idempotency-Key is always sent', /^mcp-[0-9a-f-]{36}$/.test(emailHit.idempotencyKey ?? ''), true);
has('email: the answer says it was sent', ct.text(0), 'Ticket #900 opened; the email was sent to the customer (message #9001, delivery: queued).');
has('...with the ticket row, subject wrapped', ct.text(0), '#900 [open] <untrusted_customer_content>');
has('...and the key used', ct.text(0), `idempotency_key: ${emailHit.idempotencyKey}`);
check('email: one address becomes a list', posts[1].body.to, ['dana@x.co']);
check('draft: draft true is sent', posts[1].body.draft, true);
check('draft: a key is sent for a draft too', Boolean(posts[1].idempotencyKey), true);
has('draft: says nothing was sent', ct.text(1), 'Draft ticket #901 saved (message #9011). Nothing was sent to the customer');
has('...names Use this draft', ct.text(1), 'clicks "Use this draft"');
has('...and how to discard it', ct.text(1), 'clokio_delete_reply_draft id=901 message_id=9011');
check('whatsapp: the body sent', posts[2].body, { channel: 'whatsapp', inbox_id: 5, draft: false, to: '+972501234567', template: { name: 'order_update', language: 'he', params: ['1234'] } });
has('whatsapp reused: says so', ct.text(2), "Sent on the customer's open ticket #902 for this number (no new ticket; message #9021, delivery: queued).");
check('whatsapp: params as a map pass through', posts[3].body.template.params, { order: '1' });
check('the supplied key is sent', posts[3].idempotencyKey, 'my-retry-key');
has('replay: says already created, nothing sent', ct.text(3), 'Ticket #903 was already created from this request (replayed, no new ticket; nothing was sent or saved again).');
check('...and does not claim a send', ct.text(3).includes('was sent to the customer'), false);
has('whatsapp with body: refused before any request', ct.text(4), 'starts with an approved template: body is not accepted');
has('email with template: refused', ct.text(5), 'template is for WhatsApp only');
has('email with no subject: refused', ct.text(6), 'An email needs a subject.');
has('no to and no contact_id: refused', ct.text(7), 'Name the recipient: to, or contact_id');
check('contact_id without to: sent with no to', [posts[4].body.contact_id, 'to' in posts[4].body ? posts[4].body.to : 'absent', posts[4].body.assignee_employee_code], [40, 'absent', '00042']);
has('whatsapp without template: refused', ct.text(9), 'needs template');
has('a plain 404 gains the visibility cause', ct.text(10), 'Not found. The mailbox or number (inbox_id), the contact or the assignee is not one the acting employee can see');
has('...and the old server as one possible cause', ct.text(10), NEW_ROUTE_HINT);
has('a 429 is shown in the server words', ct.text(11), 'At most 10 new tickets every 10 minutes from one API key.');
check('whatsapp with a list of numbers: refused by the schema', [ct.errored(12), ct.text(12).includes('to[0]')], [true, true]);
for (const i of [4, 5, 6, 7, 9, 12]) check(`refusal ${i} is an error`, ct.errored(i), true);
check('only the valid calls reached the server', posts.length, 7);

const desc = ct.tools.clokio_create_ticket?.description ?? '';
has('create_ticket points at the template list', desc, 'clokio_list_whatsapp_templates');
has('create_ticket: only successful creates count', desc, 'Only SUCCESSFUL creates count');
has('create_ticket: a replay is answered past the limit', desc, 'answered even past the limit');
has('create_ticket: the first reply goes to the drafted recipients', desc, 'goes to the drafted recipients with the drafted subject');
has('create_ticket draft answer: the draft becomes used', ct.text(1), 'the draft reads "used" and cannot be deleted');
check('create_ticket is mutating (not read-only)', ct.tools.clokio_create_ticket?.annotations?.readOnlyHint, false);
check('...and marked destructive (a send reaches a customer)', ct.tools.clokio_create_ticket?.annotations?.destructiveHint, true);
for (const needle of ['tickets:write', 'tickets:send', "tickets.manage", '10 new tickets per 10 minutes', 'draft: true', 'PENDING DRAFT', 'Use this draft', 'Idempotency-Key']) {
  has(`description names ${needle}`, desc, needle);
}

// ── #9: list filters ────────────────────────────────────────────────────
const lt = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_list_tickets', { label_ids: [3, 5], created_after: '2026-10-01', created_before: '2026-10-17T12:00:00+03:00', needs_reply: true, sort: 'created_asc' }],
    ['clokio_list_tickets', { needs_reply: false, sort: 'created_asc', cursor: 'abc' }],
    ['clokio_list_tickets', {}],
  ],
  respond: (hit) => ({ json: { status: 'success', data: { tickets: [TICKET(1)] }, meta: { next_cursor: hit.query.cursor ? null : 'NEXT' } } }),
});
const u0 = lt.hits[0];
check('label_ids go out as label_ids[] (repeated)', new URLSearchParams(u0.search).getAll('label_ids[]'), ['3', '5']);
check('the query keys', Object.keys(u0.query).sort(), ['created_after', 'created_before', 'label_ids[]', 'needs_reply', 'sort']);
check('needs_reply true', u0.query.needs_reply, 'true');
check('created_before passes as given', u0.query.created_before, '2026-10-17T12:00:00+03:00');
check('needs_reply false is sent, not dropped', lt.hits[1].query.needs_reply, 'false');
check('cursor and sort go together', [lt.hits[1].query.cursor, lt.hits[1].query.sort], ['abc', 'created_asc']);
has('the next-page line names the sort with the cursor', lt.text(0), 'with the same filters, sort "created_asc" and cursor "NEXT"');
has('no sort: the line as before', lt.text(2), 'with the same filters and cursor "NEXT"');
check('no filters sent when none given', Object.keys(lt.hits[2].query), []);
has('the description says to pass the sort with the cursor', lt.tools.clokio_list_tickets?.description ?? '', 'the same sort');

// ── #9: create ticket label ─────────────────────────────────────────────
const lb = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_create_ticket_label', { name: 'VIP', color: '#AABBCC' }],
    ['clokio_create_ticket_label', { name: 'Dup', color: '#000000' }],
    ['clokio_create_ticket_label', { name: 'Bad', color: 'red' }],
    ['clokio_create_ticket_label', { name: 'Old', color: '#111111' }],
  ],
  respond: (hit) => {
    if (hit.body?.name === 'Dup') return { status: 422, json: { status: 'error', message: 'A label with this name already exists.', errors: { name: ['A label with this name already exists.'] }, data: {} } };
    if (hit.body?.name === 'Old') return { status: 405, json: { message: 'The POST method is not supported for route api/v1/ticket-labels.' } };
    return OK({ label: { id: 77, name: hit.body.name, color: hit.body.color.toLowerCase() } });
  },
});
check('label: the body', lb.hits[0].body, { name: 'VIP', color: '#AABBCC' });
has('label: the answer names the id', lb.text(0), 'Label created: <untrusted_customer_content>VIP</untrusted_customer_content> (label_id 77, #aabbcc)');
has('label: a duplicate in the server words', lb.text(1), 'A label with this name already exists.');
check('label: a bad colour is refused before any request', [lb.errored(2), lb.hits.length], [true, 3]);
has('label: a 405 names an older server', lb.text(3), 'predates the 0.25 API');
check('label tool is mutating', lb.tools.clokio_create_ticket_label?.annotations?.readOnlyHint, false);
has('label description names tickets.manage', lb.tools.clokio_create_ticket_label?.description ?? '', 'tickets.manage');

// ── #9: create contact ──────────────────────────────────────────────────
const cc = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_create_contact', { name: 'Dana', email: 'dana@x.co', phone: '0501234567' }],
    ['clokio_create_contact', { name: 'Dana', email: 'taken@x.co' }],
    ['clokio_create_contact', { name: 'Dana' }],
    ['clokio_create_contact', { name: 'Hidden', phone: '+972500000000' }],
  ],
  respond: (hit) => {
    if (hit.body?.email === 'taken@x.co') {
      return { status: 409, json: { status: 'error', message: 'A contact you can see already has this email address or phone number. Use that contact instead.', data: { contact_id: 41 } } };
    }
    if (hit.body?.name === 'Hidden') return { status: 422, json: { status: 'error', message: 'That email is already in use on another contact in this organisation.', errors: { phone: ['x'] }, data: {} } };
    return OK({ contact: { id: 42, name: 'Dana', emails: ['dana@x.co'], phones: ['+972501234567'], notes: null, blocked: false, fields: {} } });
  },
});
check('contact: the body', cc.hits[0].body, { name: 'Dana', email: 'dana@x.co', phone: '0501234567' });
has('contact: created, rendered', cc.text(0), 'Contact created.');
has('...with its id', cc.text(0), 'Contact 42:');
check('contact 409: an error', cc.errored(1), true);
has('contact 409: the server words', cc.text(1), 'A contact you can see already has this email address or phone number.');
has('...the existing id and the next tool', cc.text(1), 'Existing contact_id 41: read it with clokio_get_contact id=41.');
has('contact with no email or phone: refused before any request', cc.text(2), 'A contact needs an email or a phone');
check('...no request for it', cc.hits.length, 3);
has('contact 422 passes through', cc.text(3), 'already in use on another contact');
check('contact tool is mutating', cc.tools.clokio_create_contact?.annotations?.readOnlyHint, false);
has('contact description names the 409', cc.tools.clokio_create_contact?.description ?? '', '409');

// ── clokio_list_whatsapp_templates ──────────────────────────────────────
const WA = {
  inbox_id: 12,
  templates: [
    { name: 'follow_up', language: 'en', category: 'UTILITY', format: 'numbered', body: 'Hi {{1}}, order {{2}}.', variables: ['1', '2'],
      header: { kind: 'text', text: 'Order {{1}}', variable: '1' }, footer: 'Thanks', buttons: [{ index: 0, type: 'URL', label: 'Track', needs: 'url_suffix' }, { index: 1, type: 'QUICK_REPLY', label: 'Stop', needs: null }],
      sendable: true, unsendable_reason: null },
    { name: 'greet', language: 'he', category: 'MARKETING', format: 'named', body: 'Hello {{first_name}}', variables: ['first_name'],
      header: { kind: 'none', text: null, variable: null }, footer: null, buttons: [], sendable: true, unsendable_reason: null },
    { name: 'promo', language: 'en', category: 'MARKETING', format: 'numbered', body: 'Sale', variables: [],
      header: { kind: 'image', text: null, variable: null }, footer: null, buttons: [], sendable: false, unsendable_reason: 'This template needs a header file, which the API cannot send.' },
  ],
};
const wa = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_list_whatsapp_templates', { inbox_id: 12 }],
    ['clokio_list_whatsapp_templates', { inbox_id: 13 }],
    ['clokio_list_whatsapp_templates', { inbox_id: 14 }],
  ],
  respond: (hit) => {
    if (hit.path === '/inboxes/12/whatsapp-templates') return { json: { status: 'success', message: 'WhatsApp templates', data: WA } };
    if (hit.path === '/inboxes/13/whatsapp-templates') return { json: { status: 'success', message: 'WhatsApp templates', data: { inbox_id: 13, templates: [] } } };
    return { status: 404, json: { status: 'error', message: 'Not found.', data: {} } };
  },
});
const w0 = wa.text(0);
check('templates: the route, no query', [wa.hits[0].method, wa.hits[0].path, wa.hits[0].search], ['GET', '/inboxes/12/whatsapp-templates', '']);
has('numbered: params as a list in order', w0, 'params: a list of 2 in this order [{{1}}, {{2}}]');
has('...name and language to send', w0, 'template: {name: "follow_up", language: "en"}');
has('text header with a variable needs header_text', w0, 'header_text: the value of {{1}} in the header');
has('a URL button needs its suffix by index', w0, 'buttons[0] = the URL suffix');
check('a button with needs null asks for nothing', w0.includes('buttons[1] ='), false);
has('named: params as a map', w0, 'params: a map {"first_name": "..."}');
has('a media header is NOT SENDABLE with the reason', w0, 'promo (en) [MARKETING, numbered] - NOT SENDABLE: This template needs a header file, which the API cannot send.');
has('a sendable template says so', w0, 'follow_up (en) [UTILITY, numbered] - sendable');
has('the body is wrapped', w0, 'body: <untrusted_customer_content>Hi {{1}}, order {{2}}.</untrusted_customer_content>');
has('no templates: says so', wa.text(1), 'has no approved templates');
has('404: the number cause', wa.text(2), 'Not found. The number does not exist, is not a WhatsApp number');
check('templates tool is read-only', wa.tools.clokio_list_whatsapp_templates?.annotations?.readOnlyHint, true);
has('templates description names tickets:read', wa.tools.clokio_list_whatsapp_templates?.description ?? '', 'tickets:read');

// The constants stay distinct: the ticket hint mentions opening the ticket, the new-route hint does not.
check('two hints', [OLDER_SERVER_HINT.includes('clokio_get_ticket'), NEW_ROUTE_HINT.includes('clokio_get_ticket')], [true, false]);

done();
