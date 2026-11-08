import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ClokioConfig, request } from '../client.js';
import { registerTool } from './helpers.js';

/**
 * The read-only invoices toolset (0.34.0; round 2 in 0.35.0, round 3 in 0.36.0). Every tool is a GET over the
 * backend's /invoices family; nothing here creates, sends, marks paid or
 * cancels an invoice.
 */
const ACCESS =
  'Needs the invoices:read scope AND billing access for the key\'s person (otherwise 403 NO_BILLING_ACCESS). ' +
  'Read only. These are Clokio\'s own invoices; no iCount data beyond the number stored as invoice_number. "paid" is a status someone set in Clokio, ' +
  'not a payment record.';

const NO_CLIENT = 'The "No Client" bucket is client id 0 everywhere (client {id: 0, name: "No Client"}). ';
const AMOUNT =
  'Each row has amount {source, subtotal, vat_amount, total, currency}: source "invoice" is the invoice\'s own numbers, ' +
  'source "estimate" is exactly what clokio_get_client_unbilled answers for that client and month (VAT at the organisation rate). ' +
  'Use amount, not estimated_amount: estimated_amount is the screen\'s figure, deprecated (the invoice total WITH VAT, or hours times rates ' +
  'WITHOUT VAT, rounded differently). Compact rows (clokio_get_billing_month by default) carry only amount {source, total, currency}. ' +
  'missing_rate is true when billable hours have no rate (amount 0). ';

const month = (what: string) =>
  z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM (month 01-12)').describe(what);
const id = z.number().int().positive();
const includeEmployees = z
  .boolean()
  .optional()
  .describe(
    'true: each line also lists who worked it and for how many hours (include=employees); ' +
      'a task line lists everyone who worked that task in the period, even when the task is split over several lines ' +
      '(employees_scope "task"); a task-less line lists that line\'s people (employees_scope "line").',
  );

export function registerInvoiceTools(server: McpServer, config: ClokioConfig): void {
  registerTool(server, config, {
    name: 'clokio_list_invoices',
    description:
      'List Clokio invoices, newest first, optionally by client, exact number, period months, status and minimum total. ' +
      'Rows carry billable_hours (sum of the billable lines). invoice_number is the number Clokio stored at finalize: ' +
      'INV-<year>-<seq> style without an invoicing integration, the provider\'s document number (plain digits) with one. ' +
      'client_id 0 lists the invoices with no client. ' + NO_CLIENT +
      'Paginated: {data, meta}. ' + ACCESS,
    schema: {
      client_id: z.number().int().min(0).optional().describe('Only this client; 0 = invoices with no client'),
      number: z.string().min(1).max(50).optional().describe('Exact invoice number, e.g. INV-2026-0012 (Clokio\'s own) or 3529 (a provider document number)'),
      from_month: month('First period month, YYYY-MM').optional(),
      to_month: month('Last period month, YYYY-MM; at most 24 months after from_month').optional(),
      status: z.array(z.enum(['draft', 'finalized', 'sent', 'paid', 'cancelled'])).min(1).optional()
        .describe('One or more statuses'),
      min_total: z.number().min(0).optional().describe('Only invoices whose total is at least this (in each invoice\'s own currency)'),
      per_page: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional(),
    },
    handler: (args, cfg) =>
      request(cfg, '/invoices', {
        query: {
          client_id: args.client_id,
          number: args.number,
          from_month: args.from_month,
          to_month: args.to_month,
          status: args.status,
          min_total: args.min_total,
          per_page: args.per_page,
          page: args.page,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_get_invoice',
    description:
      'One invoice with its lines and activity_count (include_employees adds who worked each line; include_activities adds the activity trail). ' +
      'Each line has task_state: "linked" (the task exists), "deleted" (the task was deleted or is gone; the stored title still shows), ' +
      '"none" (no task id: a hand-added line or, normally, timer hours logged without a task, never a deleted task), ' +
      'origin (derived from the line type: "custom" = added by hand, "timer" = normally a timer line) and missing_rate (billable hours with no price). ' +
      'With include_activities each activity also has field, old_value, new_value (only for edits of the invoice or of a line; client_id is an integer with No Client as 0, due_date is YYYY-MM-DD, is_billable a boolean) and item_id; ' +
      'external document events show action and time only. ' + NO_CLIENT + ACCESS,
    schema: {
      id,
      include_employees: includeEmployees,
      include_activities: z.boolean().optional().describe('true: also return the activity trail (include=activities). Default false: only activity_count.'),
    },
    handler: (args, cfg) => {
      const include = [args.include_employees ? 'employees' : null, args.include_activities ? 'activities' : null].filter(Boolean).join(',');
      return request(cfg, `/invoices/${args.id}`, { query: { include: include || undefined } });
    },
  });

  registerTool(server, config, {
    name: 'clokio_get_task_billing',
    description:
      "A task's billing history: its invoice lines (newest period first), totals by status, and its unbilled hours and months. Amounts are keyed by currency. " +
      'note says why the hours may bill nothing: "no_client" (the project has no client), "project_not_billable", or null. ' + NO_CLIENT + ACCESS,
    schema: { task_id: id },
    handler: (args, cfg) => request(cfg, `/tasks/${args.task_id}/billing`),
  });

  registerTool(server, config, {
    name: 'clokio_get_client_billing_summary',
    description:
      "A client's month-by-month billing (every month in the span, default the last 12 full months, at most 24): " +
      'per month the invoice, billable hours, amount and missing_rate; totals keyed by currency: invoiced counts ISSUED invoices only ' +
      '(finalized + sent + paid), draft is the drafts\' total, plus marked_paid, outstanding and overdue_count. Money totals are per currency, never summed ' +
      'across currencies. ' + AMOUNT + ACCESS,
    schema: {
      client_id: id,
      from_month: month('First month, YYYY-MM').optional(),
      to_month: month('Last month, YYYY-MM').optional(),
    },
    handler: (args, cfg) =>
      request(cfg, `/clients/${args.client_id}/billing-summary`, {
        query: { from_month: args.from_month, to_month: args.to_month },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_get_billing_month',
    description:
      'One month across all clients, as the web /invoices screen: per client hours, amount and invoice, the client ids not yet invoiced (not_invoiced, 0 = No Client), and totals. ' +
      'COMPACT BY DEFAULT: the full answer is large enough to overflow an agent, so this tool sends compact=1 unless compact is false ' +
      '(compact rows: client, billable_hours, amount {source, total, currency}, invoice {id, status}, dismissed, missing_rate). ' +
      'PAGED: per_page defaults to 50 here (max 200); the answer has meta {total, per_page, current_page, last_page}: use page to continue. Rows are ordered by client name then id, No Client last. ' +
      'not_invoiced and totals cover every matching client, not just the page. ' +
      'Filters client_ids, only_not_invoiced, exclude_dismissed, min_billable_hours; rows, not_invoiced and totals are computed over the FILTERED rows. ' +
      'totals per currency: total = ISSUED invoices only (finalized + sent + paid), draft = the drafts, pending = finalized + sent, overdue_count. Money totals are per currency, never summed. ' +
      AMOUNT + NO_CLIENT + ACCESS,
    schema: {
      month: month('The month, YYYY-MM; not in the future'),
      client_ids: z.array(z.number().int().min(0)).min(1).max(500).optional().describe('Only these clients; 0 = the No Client bucket'),
      only_not_invoiced: z.boolean().optional().describe('true: only clients with billable hours, no invoice and not dismissed'),
      exclude_dismissed: z.boolean().optional().describe('true: leave dismissed clients out'),
      min_billable_hours: z.number().min(0).optional().describe('Only clients with at least this many billable hours'),
      per_page: z.number().int().min(1).max(200).optional().describe('Clients per page, 1-200; default 50'),
      page: z.number().int().min(1).max(1000000).optional().describe('Page, from 1; use it to continue when meta.last_page is above 1'),
      compact: z.boolean().optional().describe('Default true (smaller rows). false: the full rows (total_hours, projects, estimated_amount, the full amount, the invoice number and total).'),
    },
    handler: (args, cfg) =>
      request(cfg, '/invoices/month', {
        query: {
          month: args.month,
          client_ids: args.client_ids,
          only_not_invoiced: args.only_not_invoiced === undefined ? undefined : args.only_not_invoiced ? 1 : 0,
          exclude_dismissed: args.exclude_dismissed === undefined ? undefined : args.exclude_dismissed ? 1 : 0,
          min_billable_hours: args.min_billable_hours,
          compact: args.compact === false ? 0 : 1,
          per_page: args.per_page ?? 50,
          page: args.page,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_get_client_unbilled',
    description:
      "What is still unbilled for a client in a month: the web invoice review's lines, from finished web-timer entries; " +
      'non-billable ones appear with is_billable false and price 0; subtotal counts billable lines only. client_id 0 is the "No Client" bucket. If an invoice already exists for that month the ' +
      'answer is existing_invoice and no lines. Amounts are in one currency per answer; each line carries its own. ' +
      'Each line has missing_rate (billable hours with no rate). ' + NO_CLIENT +
      ACCESS,
    schema: {
      client_id: z.number().int().min(0),
      month: month('The month, YYYY-MM; not in the future'),
      include_employees: includeEmployees,
    },
    handler: (args, cfg) =>
      request(cfg, `/clients/${args.client_id}/unbilled`, {
        query: { month: args.month, include: args.include_employees ? 'employees' : undefined },
      }),
  });
}
