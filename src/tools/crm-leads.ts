/**
 * The `crm` toolset's lead tools over /api/v1/crm/leads (backend guide
 * docs/api/public-api-crm.md, OpenAPI tag `crm-leads`).
 *
 * Every route acts as the key's person (its acts-as employee, else its
 * issuer) with that person's own permissions: they must work leads
 * (`leads.view`), and the CRM module must be on, or every lead route is a
 * 404. This server re-implements none of it; it only shapes the calls and
 * wraps the customer text of the answers (crm-shared.ts).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ClokioConfig, request, seg } from '../client.js';
import { idempotentPost } from '../idempotency.js';
import { calendarDate, registerTool } from './helpers.js';
import { CRM_NEEDS, createKey, employeeCode, renderCrm, replayNote } from './crm-shared.js';

/** The channels a lead may carry (CrmLead::CHANNELS). */
const CHANNELS = ['phone', 'website', 'whatsapp', 'email', 'chat', 'referral', 'other'] as const;

const leadId = z.number().int().positive().describe('The lead id (clokio_list_leads)');

/** Who acts and who may: on every lead tool. */
const LEADS =
  ' Acts as the key\'s person (its acts-as employee, else its issuer), who must work leads (leads.view): otherwise every lead tool answers 404 Not found.' +
  CRM_NEEDS;

/** Ruling R9: every lead write names the busy answer. */
const BUSY =
  ' While another change to your organisation\'s leads is being saved the answer is 409 "Another change is being saved right now. Please try again in a moment." and nothing was written: call again.';

/** An ended (converted or closed) lead refuses every change but reopen. */
const ENDED = ' An ended lead is a 422 on lead.';

const ROW =
  'A lead row is {id, url, name, emails, phones, company_name, private_customer, channel, status {id, name, kind}, owner {employee_code, name} | null ' +
  '(null only when unassigned; employee_code is null for an owner with no code), clock, attempts, next_step, created_at}; times are UTC.';

const WRAPPED = ' Customer-written text (names, emails, phones, the company, the description) comes back inside <untrusted_customer_content>.';

/** The lead page adds the close note and the refusal sentences, which can name a company or a person. */
const WRAPPED_PAGE =
  ' Customer-written text (names, emails, phones, the company, the description, the close note) and the *_refused sentences ' +
  '(they can name a company or a person) come back inside <untrusted_customer_content>.';

export function registerCrmLeadTools(server: McpServer, config: ClokioConfig): void {
  registerTool(server, config, {
    name: 'clokio_list_leads',
    description:
      'List leads, as the Leads list shows them. tab: unassigned (open, no owner), mine (open, owned by the acting employee), open (every open lead, the default) ' +
      'or closed (converted and closed); filters status_id, channel and owner_employee_code (a departed owner\'s code still filters). ' +
      'Paginated: {data, meta}: 50 a page, meta {page, per_page, total, last_page}; pass page to continue. ' +
      ROW + WRAPPED + LEADS,
    schema: {
      tab: z.enum(['unassigned', 'mine', 'open', 'closed']).optional().describe('Default open'),
      status_id: z.number().int().positive().optional().describe('A status id (clokio_get_lead_options)'),
      channel: z.enum(CHANNELS).optional(),
      owner_employee_code: employeeCode.optional().describe('Only the leads this person owns'),
      page: z.number().int().positive().optional().describe('From 1'),
    },
    handler: async (args, cfg) =>
      renderCrm(
        await request(cfg, '/crm/leads', {
          query: {
            tab: args.tab,
            status_id: args.status_id,
            channel: args.channel,
            owner_employee_code: args.owner_employee_code,
            page: args.page,
          },
        }),
      ),
  });

  registerTool(server, config, {
    name: 'clokio_get_lead_options',
    description:
      'The values the lead tools take: statuses [{id, name, kind: open|converted|closed, is_active}] (clokio_set_lead_status takes an active open one), ' +
      'channels [{value, label}], reasons [{id, name, asks_recontact}] (the active close reasons; one that asks for a recontact date needs recontact_on on close) ' +
      'and people [{employee_code, name}] (who may own a lead). Read it before a status change, a close or an assign.' +
      LEADS,
    schema: {},
    handler: (_args, cfg) => request(cfg, '/crm/leads/options'),
  });

  registerTool(server, config, {
    name: 'clokio_get_lead',
    description:
      'One lead, as its page shows it: the row (see clokio_list_leads) plus company_text, description, source_origin (manual, ticket or api), ' +
      'contact {id, name, emails, phones, private_origin, company, edit_refused, move_refused, convert_refused} (the person, read through the lead; ' +
      'each *_refused says in words why the acting employee may not edit, move or convert that person, or is null), customer (what a converted lead became), ' +
      'reopen_refused, close {reason, note, recontact_on}, moments (UTC) and the full next_step with open_count. ' +
      'Another organisation\'s lead, a deleted one and an id that never existed are the same 404.' +
      WRAPPED_PAGE + LEADS,
    schema: { id: leadId },
    handler: async (args, cfg) => renderCrm(await request(cfg, `/crm/leads/${seg(args.id)}`)),
  });

  registerTool(server, config, {
    name: 'clokio_list_lead_history',
    description:
      'A lead\'s history lines (created, assigned, taken, status changes, first contact, closed, converted, reopened, submitted again, a ticket linked), newest first. ' +
      'Paged by cursor: {items, next_cursor}; each item is {type: history, at (UTC), title, subtitle, actor {employee_code, name} | null} ' +
      '(actor null for a line nobody did, such as a website lead). Pass next_cursor back as cursor until it is null. ' +
      'Titles and subtitles may quote customer text and come back inside <untrusted_customer_content>.' +
      LEADS,
    schema: {
      id: leadId,
      cursor: z.string().min(1).max(1000).optional().describe('next_cursor from the previous page'),
      limit: z.number().int().min(1).max(100).optional().describe('1 to 100, default 30'),
    },
    handler: async (args, cfg) =>
      renderCrm(await request(cfg, `/crm/leads/${seg(args.id)}/history`, { query: { cursor: args.cursor, limit: args.limit } })),
  });

  registerTool(server, config, {
    name: 'clokio_create_lead',
    description:
      'Create a lead, as the New lead panel does, with the acting employee as its creator. name and phone or email are required (the server answers 422 without one). ' +
      'The person is matched by phone (read in your organisation\'s country when it has no country code), then email, to an existing contact, ' +
      'else a new contact is made; an existing person\'s details are never changed. ONE OPEN LEAD PER PERSON: when the person already has one, ' +
      'nothing is created and the answer is that lead with created: false (a description is added to its history as "Submitted again"). ' +
      'owner_employee_code (optional): someone who works leads (clokio_get_lead_options people); omitted means unassigned. ' +
      'Everyone who works leads is told of a new lead. Every call sends an Idempotency-Key: a fresh one (returned as idempotency_key), or the one you pass. ' +
      'To retry after a timeout, pass the SAME idempotency_key and the same fields: the first answer comes back with "replayed: nothing new was created". ' +
      'Answers {lead: <row>, created, replayed}.' +
      WRAPPED + LEADS + BUSY,
    schema: {
      name: z.string().trim().min(1).max(160).describe('The person\'s name'),
      phone: z.string().trim().min(1).max(64).optional().describe('With its country code; phone or email is required'),
      email: z.string().email().optional().describe('phone or email is required'),
      company_name: z.string().max(190).optional().describe('The company the person mentioned, as text; no company is created'),
      description: z.string().max(5000).optional().describe('What they asked for; plain text, line breaks kept'),
      channel: z.enum(CHANNELS).optional().describe('Default phone'),
      owner_employee_code: employeeCode.nullable().optional().describe('Someone who works leads; omitted or null: unassigned'),
      idempotency_key: createKey.describe('Reuse the key of an earlier call only to retry THAT call; omit for a new lead'),
    },
    mutates: true,
    handler: async (args, cfg) => {
      const key = args.idempotency_key ?? `mcp-${randomUUID()}`;
      const { res, replayed } = await idempotentPost(cfg, '/crm/leads', key, {
        name: args.name,
        phone: args.phone,
        email: args.email,
        company_name: args.company_name,
        description: args.description,
        channel: args.channel,
        owner_employee_code: args.owner_employee_code,
      });
      const id = res?.lead?.id ?? '-';
      const outcome = replayed
        ? replayNote('Lead', id, true)
        : res?.created === false
          ? { existing_note: `This person already has an open lead (#${id}): nothing was created. The answer is that lead.` }
          : {};
      return renderCrm({ ...outcome, ...res, idempotency_key: key });
    },
  });

  registerTool(server, config, {
    name: 'clokio_take_lead',
    description:
      'Take a lead: the acting employee becomes its owner. seen_owner_employee_code is the owner you last saw (owner.employee_code of the lead), ' +
      'or null when you saw it unassigned or with an owner shown as employee_code: null. When the owner changed meanwhile a colleague got there first: ' +
      'the answer is a 409 naming them ("This lead was just taken by {name}." or "This lead was just unassigned.") and nothing was written. ' +
      'Taking a lead you already own changes nothing. The previous owner is told. Answers {lead: <row>}.' +
      ENDED + LEADS + BUSY,
    schema: {
      id: leadId,
      seen_owner_employee_code: employeeCode
        .nullable()
        .describe('Required: the owner you saw, null when it was unassigned (or its owner had no code)'),
    },
    mutates: true,
    handler: async (args, cfg) =>
      renderCrm(
        await request(cfg, `/crm/leads/${seg(args.id)}/take`, {
          method: 'POST',
          body: { seen_owner_employee_code: args.seen_owner_employee_code },
        }),
      ),
  });

  registerTool(server, config, {
    name: 'clokio_assign_lead',
    description:
      'Give a lead to an owner, or unassign it with null. The owner must work leads (clokio_get_lead_options people); a code that names nobody here, ' +
      'or someone who does not work leads, is a 422 on owner_employee_code. A new owner other than the acting employee is told. Answers {lead: <row>}.' +
      ENDED + LEADS + BUSY,
    schema: {
      id: leadId,
      owner_employee_code: employeeCode.nullable().describe('Required: the new owner, or null to unassign'),
    },
    mutates: true,
    handler: async (args, cfg) =>
      renderCrm(
        await request(cfg, `/crm/leads/${seg(args.id)}/assign`, {
          method: 'POST',
          body: { owner_employee_code: args.owner_employee_code },
        }),
      ),
  });

  registerTool(server, config, {
    name: 'clokio_set_lead_status',
    description:
      'Move a lead to another open status: status_id an ACTIVE status of kind open (clokio_get_lead_options). Ending a lead is clokio_convert_lead or ' +
      'clokio_close_lead, never a status: a converted or closed status is a 422 on status_id. Moving to the attempt or connect status by hand records ' +
      'the first contact when there was none. Answers {lead: <row>}.' +
      ENDED + LEADS + BUSY,
    schema: {
      id: leadId,
      status_id: z.number().int().positive().describe('An active open status (clokio_get_lead_options statuses)'),
    },
    mutates: true,
    handler: async (args, cfg) =>
      renderCrm(await request(cfg, `/crm/leads/${seg(args.id)}/status`, { method: 'POST', body: { status_id: args.status_id } })),
  });

  registerTool(server, config, {
    name: 'clokio_close_lead',
    description:
      'Close an open lead with a reason: reason_id an active close reason (clokio_get_lead_options reasons), note optional plain text, ' +
      'recontact_on (YYYY-MM-DD, today or later in your organisation\'s time zone) required when the reason asks for it and ignored otherwise; ' +
      'it puts a "contact again" to-do on the owner\'s list for that day. Answers {lead: <row>}.' +
      ENDED + LEADS + BUSY,
    schema: {
      id: leadId,
      reason_id: z.number().int().positive().describe('An active close reason (clokio_get_lead_options reasons)'),
      note: z.string().max(5000).optional().describe('Plain text'),
      recontact_on: calendarDate('recontact_on').optional().describe('YYYY-MM-DD; needed when the reason asks for a recontact date'),
    },
    mutates: true,
    handler: async (args, cfg) =>
      renderCrm(
        await request(cfg, `/crm/leads/${seg(args.id)}/close`, {
          method: 'POST',
          body: { reason_id: args.reason_id, note: args.note, recontact_on: args.recontact_on },
        }),
      ),
  });

  registerTool(server, config, {
    name: 'clokio_reopen_lead',
    description:
      'Reopen a converted or closed lead: it goes back to your organisation\'s first status and its ending is cleared. Refused with a 422 on lead ' +
      'while it is still open, when its person was removed, or when the person already has another open lead (one open lead per person). ' +
      'Answers {lead: <row>}.' +
      LEADS + BUSY,
    schema: { id: leadId },
    mutates: true,
    handler: async (args, cfg) => renderCrm(await request(cfg, `/crm/leads/${seg(args.id)}/reopen`, { method: 'POST' })),
  });

  registerTool(server, config, {
    name: 'clokio_convert_lead',
    description:
      'Convert a lead to a customer. mode: existing (client_id, an active company of your organisation or the person\'s own private customer), ' +
      'new (a new company named company_name) or private (a private customer named after the person); the server answers 422 when the mode\'s field is missing. ' +
      'The person is linked to the customer and the ' +
      'lead\'s notes, files and activities follow it. Taking the person away from the company they belong to needs the acting employee\'s clients.manage ' +
      '(otherwise a 422 on client_id naming that company; clokio_get_lead says so beforehand in contact.move_refused / convert_refused). ' +
      'No undo. Answers {customer {id, name, kind, url}, lead: <row>}.' +
      ENDED + LEADS + BUSY,
    schema: {
      id: leadId,
      mode: z.enum(['existing', 'new', 'private']),
      client_id: z.number().int().positive().optional().describe('mode existing: the customer to convert to (required there)'),
      company_name: z.string().trim().min(1).max(255).optional().describe('mode new: the name of the company to create (required there)'),
    },
    mutates: 'destructive',
    handler: async (args, cfg) => {
      return renderCrm(
        await request(cfg, `/crm/leads/${seg(args.id)}/convert`, {
          method: 'POST',
          body: { mode: args.mode, client_id: args.client_id, company_name: args.company_name },
        }),
      );
    },
  });

  registerTool(server, config, {
    name: 'clokio_update_lead',
    description:
      'Edit a lead and its person; a field left out is unchanged. The lead\'s company_name and description (null or empty clears them) and channel; ' +
      'its PERSON\'s name, phone and email (changed, never removed: an empty phone or email is a 422). A request carrying a person field is refused whole ' +
      '(422 on lead) when the acting employee may not change that person here (clokio_get_lead gives the sentence beforehand as contact.edit_refused). ' +
      'A phone or address another contact holds is a 422. Answers {lead: <the lead page, as clokio_get_lead>}.' +
      ENDED + WRAPPED_PAGE + LEADS + BUSY,
    schema: {
      id: leadId,
      company_name: z.string().max(190).nullable().optional().describe('The company the lead mentioned, as text; null clears it'),
      description: z.string().max(5000).nullable().optional().describe('Plain text, line breaks kept; null clears it'),
      channel: z.enum(CHANNELS).optional(),
      name: z.string().trim().min(1).max(160).optional().describe('The person\'s name'),
      phone: z.string().trim().min(1).max(64).optional().describe('The person\'s phone, with its country code'),
      email: z.string().email().optional().describe('The person\'s email'),
    },
    mutates: true,
    handler: async (args, cfg) => {
      // A field left out is not sent (JSON drops undefined); null is sent and clears.
      const { id, ...body } = args;
      return renderCrm(await request(cfg, `/crm/leads/${seg(id)}`, { method: 'PATCH', body }));
    },
  });

  registerTool(server, config, {
    name: 'clokio_delete_lead',
    description:
      'Delete a lead: it is removed from every list; its notes, files and activities stay on the person\'s and the company\'s pages. ' +
      'Also needs the acting employee\'s leads.manage: without it the answer is 403 "Deleting a lead needs the leads.manage permission.". ' +
      'No undo. Answers {id}.' +
      LEADS + BUSY,
    schema: { id: leadId },
    mutates: 'destructive',
    handler: async (args, cfg) => renderCrm(await request(cfg, `/crm/leads/${seg(args.id)}`, { method: 'DELETE' })),
  });
}
