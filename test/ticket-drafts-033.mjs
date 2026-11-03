// 0.33.0 (MCP field report on ticket #6567): edit a draft in place, send an
// existing draft, the draft ticket's first-send line, move a ticket to another
// mailbox, and the relayed customer as the reply address.
//
// Run by hand:  npm run build && node test/ticket-drafts-033.mjs
// Break-verified 2026-11-03: dropping `draft_message_id` from the reply body
// fails "the draft id rides on the reply"; sending `html` for a body-less call
// fails "no body: the draft's own text goes out"; removing the before-request
// check fails "neither body nor draft is refused before any request";
// dropping `first_send` from replyLines fails "a draft ticket says NOT SENT YET".
import { checker, runTools } from './support/harness.mjs';
import { composeLine, renderMessage, renderTicket, replyLines } from '../dist/tools/tickets.js';

const { check, has, done } = checker();
const O = '<untrusted_customer_content>';

const TICKET = {
  id: 6567, state: 'open', subject: 'TextMe question', channel: { type: 'email', name: 'Support', inbox_id: 21 },
  assignee: null, labels: [], contact: { id: 1202, name: 'Shopify', emails: ['no-reply@shopify.com'], phones: [] },
  waiting_since: '2026-11-03T17:20:55Z', ticket_url: 'https://app.example/tickets/6567',
  reply_to: 'raqual@gmail.test', first_send: null,
};
const DRAFT_TICKET = {
  ...TICKET, id: 70, contact: { id: 9, name: 'Dana', emails: ['dana@customer.test'], phones: [] }, reply_to: 'dana@customer.test',
  first_send: { draft_message_id: 501, subject: 'Your order', recipients: { to: ['dana@customer.test'], cc: ['boss@customer.test'], bcc: [] } },
};
const MOVED = { ...TICKET, channel: { type: 'email', name: 'Product', inbox_id: 33 } };

const run = await runTools({
  toolsets: 'tickets',
  calls: [
    ['clokio_reply_ticket', { id: 6567, draft_message_id: 500, idempotency_key: 'idem-draft-send-0001' }], // 0
    ['clokio_reply_ticket', { id: 6567, draft_message_id: 500, body: 'Final **text**', idempotency_key: 'idem-draft-send-0002' }], // 1
    ['clokio_reply_ticket', { id: 6567, idempotency_key: 'idem-draft-send-0003' }], // 2 refused before any request
    ['clokio_update_reply_draft', { id: 70, message_id: 501, subject: 'Your order (updated)', recipients: { to: ['dana@customer.test'], cc: ['boss@customer.test'] } }], // 3
    ['clokio_update_reply_draft', { id: 70, message_id: 501, body: 'Hello **Dana**' }], // 4
    ['clokio_update_reply_draft', { id: 70, message_id: 501 }], // 5 refused
    ['clokio_move_ticket', { id: 6567, inbox_id: 33 }], // 6
    ['clokio_get_ticket', { id: 70 }], // 7
    ['clokio_move_ticket', { id: 404, inbox_id: 33 }], // 8 older server
  ],
  respond: (hit) => {
    if (hit.method === 'POST' && hit.path === '/tickets/6567/replies') {
      return { status: 201, json: { status: 'success', message: 'Reply queued.', data: { message_id: 900, ticket_id: 6567, attachments: [], delivery: 'queued', assignee_employee_code: '00055', used_draft_message_id: 500, replayed: false } } };
    }
    if (hit.method === 'PATCH' && hit.path === '/tickets/70/drafts/501') {
      return { json: { status: 'success', message: 'Draft updated.', data: { message_id: 501, ticket_id: 70, ticket_url: 'https://app.example/tickets/70', draft: { state: 'pending', used_at: null, compose: { channel: 'email', subject: hit.body.subject ?? 'Your order', recipients: hit.body.recipients ?? DRAFT_TICKET.first_send.recipients } } } } };
    }
    if (hit.method === 'POST' && hit.path === '/tickets/6567/move') return { json: { status: 'success', message: 'Ticket moved', data: { ticket: MOVED } } };
    if (hit.method === 'POST' && hit.path === '/tickets/404/move') return { status: 404, json: { status: 'error', message: 'Not found.', data: null } };
    if (hit.path === '/tickets/70') return { json: { status: 'success', message: 'Ticket', data: { ticket: DRAFT_TICKET } } };
    if (hit.path === '/tickets/70/messages') {
      return { json: { status: 'success', message: 'ok', data: { messages: [
        { id: 501, kind: 'note', direction: 'outbound', internal: true, forward: false, author: { type: 'employee', name: 'Amit', employee_code: '00055' }, text: 'Hello Dana, your order is ready.', html: null, created_at: '2026-11-03T10:00:00Z', attachments: [], delivery: null, draft: { state: 'pending', used_at: null, compose: DRAFT_TICKET.first_send && { channel: 'email', subject: 'Your order', recipients: DRAFT_TICKET.first_send.recipients } } },
      ] }, meta: { next_cursor: null } } };
    }
    return undefined;
  },
});

const replies = run.hits.filter((h) => h.method === 'POST' && h.path === '/tickets/6567/replies');
check('two reply requests (the third was refused before any request)', replies.length, 2);
check('the draft id rides on the reply', replies[0].body.draft_message_id, 500);
check('no body: the draft\'s own text goes out', 'html' in replies[0].body && replies[0].body.html !== undefined, false);
has('a body overrides the draft\'s text', replies[1].body.html, '<strong>text</strong>');
check('the override still names the draft', replies[1].body.draft_message_id, 500);
has('the answer says the draft was used', run.text(0), 'Draft message #500 was sent and is now marked used');
has('neither body nor draft is refused before any request', run.text(2), 'Give body');

const edits = run.hits.filter((h) => h.method === 'PATCH' && h.path === '/tickets/70/drafts/501');
check('two edit requests (the empty one was refused before any request)', edits.length, 2);
check('subject and recipients are sent as given, no html', [edits[0].body.subject, edits[0].body.recipients.cc, edits[0].body.html], ['Your order (updated)', ['boss@customer.test'], undefined]);
has('a body is converted from Markdown', edits[1].body.html, '<strong>Dana</strong>');
check('a body-only edit sends no subject', edits[1].body.subject, undefined);
has('the edit answer names the first email', run.text(3), 'subject');
has('the edit answer says how to send', run.text(3), 'clokio_reply_ticket id=70 draft_message_id=501');
has('an empty edit is refused', run.text(5), 'at least one');

check('the move request', run.hits.find((h) => h.path === '/tickets/6567/move').body, { inbox_id: 33 });
has('the move answer names the new mailbox', run.text(6), 'moved to Product (inbox_id 33)');
has('the move answer says where replies go', run.text(6), 'Reply goes to');
has('a 404 on move names the older server', run.text(8), '0.33 API');

const shown = run.text(7);
has('a draft ticket says NOT SENT YET', shown, 'NOT SENT YET');
has('and names the drafted recipients, wrapped', shown, `cc ${O}boss@customer.test`);
has('and the draft message that holds them', shown, 'draft message #501');
has('the pending draft row says how to send and edit it', shown, 'clokio_reply_ticket draft_message_id=501');
has('the draft row names its first email', shown, '[first email: subject');

// The pure renderers.
const lines = replyLines(TICKET);
has('a relayed reply address is explained', lines[0], 'not the sender');
has('the relayed address is wrapped', lines[0], `${O}raqual@gmail.test`);
check('an ordinary reply address is not explained', replyLines({ ...TICKET, reply_to: 'no-reply@shopify.com' })[0].includes('not the sender'), false);
check('nobody known says so', replyLines({ ...TICKET, reply_to: null })[0].includes('nobody known'), true);
check('no reply_to field (older server): no line', replyLines({ ...TICKET, reply_to: undefined, first_send: undefined }), []);
check('a chat ticket: no line', replyLines({ ...TICKET, channel: { type: 'widget' }, reply_to: null, first_send: null }), []);
check('no compose: nothing', composeLine(null), '');
has('a WhatsApp compose names the number', composeLine({ channel: 'whatsapp', to: '+972500000000', template: { name: 'hello' } }), 'first WhatsApp message');
has('a used draft offers no send', renderMessage({ id: 1, kind: 'note', direction: 'outbound', internal: true, forward: false, author: { type: 'employee', name: 'A', employee_code: '1' }, text: 'x', html: null, created_at: 'now', attachments: [], delivery: null, draft: { state: 'used', used_at: 'now' } }), 'REPLY DRAFT (used) - not sent; a person reviews and sends it - by');
check('renderTicket carries the reply lines', renderTicket(TICKET, [], { earlier: 0, nextCursor: null }).includes('Reply goes to'), true);

done();
