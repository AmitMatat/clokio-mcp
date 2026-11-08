import { z } from 'zod';
import { request } from '../client.js';
import { registerTool } from './helpers.js';
/**
 * The read-only invoices toolset (0.34.0). Every tool is a GET over the
 * backend's /invoices family; nothing here creates, sends, marks paid or
 * cancels an invoice.
 */
const ACCESS = 'Needs the invoices:read scope AND billing access for the key\'s person (otherwise 403 NO_BILLING_ACCESS). ' +
    'Read only. These are Clokio\'s own invoices; no iCount data. "paid" is a status someone set in Clokio, ' +
    'not a payment record.';
const month = (what) => z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM').describe(what);
const id = z.number().int().positive();
const includeEmployees = z
    .boolean()
    .optional()
    .describe('true: each line also lists who worked it and for how many hours (include=employees)');
export function registerInvoiceTools(server, config) {
    registerTool(server, config, {
        name: 'clokio_list_invoices',
        description: 'List Clokio invoices, newest first, optionally by client, exact number, period months and status. ' +
            'Paginated: {data, meta}. ' + ACCESS,
        schema: {
            client_id: id.optional(),
            number: z.string().min(1).max(50).optional().describe('Exact invoice number, e.g. INV-0012'),
            from_month: month('First period month, YYYY-MM').optional(),
            to_month: month('Last period month, YYYY-MM; at most 24 months after from_month').optional(),
            status: z.array(z.enum(['draft', 'finalized', 'sent', 'paid', 'cancelled'])).min(1).optional()
                .describe('One or more statuses'),
            per_page: z.number().int().min(1).max(100).optional(),
            page: z.number().int().min(1).optional(),
        },
        handler: (args, cfg) => request(cfg, '/invoices', {
            query: {
                client_id: args.client_id,
                number: args.number,
                from_month: args.from_month,
                to_month: args.to_month,
                status: args.status,
                per_page: args.per_page,
                page: args.page,
            },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_get_invoice',
        description: 'One invoice with its lines. ' + ACCESS,
        schema: { id, include_employees: includeEmployees },
        handler: (args, cfg) => request(cfg, `/invoices/${args.id}`, { query: { include: args.include_employees ? 'employees' : undefined } }),
    });
    registerTool(server, config, {
        name: 'clokio_get_task_billing',
        description: "A task's billing history: its invoice lines (newest period first), totals by status, and its unbilled hours and months. Amounts are keyed by currency. " + ACCESS,
        schema: { task_id: id },
        handler: (args, cfg) => request(cfg, `/tasks/${args.task_id}/billing`),
    });
    registerTool(server, config, {
        name: 'clokio_get_client_billing_summary',
        description: "A client's month-by-month billing (every month in the span, default the last 12 full months, at most 24): " +
            'per month the invoice, billable hours and estimated amount; totals keyed by currency. Money totals are per currency, never summed ' +
            'across currencies. ' + ACCESS,
        schema: {
            client_id: id,
            from_month: month('First month, YYYY-MM').optional(),
            to_month: month('Last month, YYYY-MM').optional(),
        },
        handler: (args, cfg) => request(cfg, `/clients/${args.client_id}/billing-summary`, {
            query: { from_month: args.from_month, to_month: args.to_month },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_get_billing_month',
        description: 'One month across all clients, as the web /invoices screen: per client hours, estimated amount and invoice, the client ids not yet invoiced, and totals. Money totals are per currency, never summed. ' +
            ACCESS,
        schema: { month: month('The month, YYYY-MM; not in the future') },
        handler: (args, cfg) => request(cfg, '/invoices/month', { query: { month: args.month } }),
    });
    registerTool(server, config, {
        name: 'clokio_get_client_unbilled',
        description: "What is still unbilled for a client in a month: the web invoice review's lines, from finished billable " +
            'timer entries. client_id 0 is the "No Client" bucket. If an invoice already exists for that month the ' +
            'answer is existing_invoice and no lines. Amounts are in one currency per answer; each line carries its own. ' +
            ACCESS,
        schema: {
            client_id: z.number().int().min(0),
            month: month('The month, YYYY-MM; not in the future'),
            include_employees: includeEmployees,
        },
        handler: (args, cfg) => request(cfg, `/clients/${args.client_id}/unbilled`, {
            query: { month: args.month, include: args.include_employees ? 'employees' : undefined },
        }),
    });
}
