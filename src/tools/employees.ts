import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ClokioConfig, request } from '../client.js';
import { registerTool } from './helpers.js';

/** Employee directory + provisioning. */
export function registerEmployeeTools(server: McpServer, config: ClokioConfig): void {
  registerTool(server, config, {
    name: 'clokio_list_employees',
    description:
      'List employees. Returns employee_code (the stable id used everywhere else, e.g. for assignees), name, ' +
      'and non-PII fields. email is only returned if the key holds the employees:pii scope.',
    schema: {
      search: z.string().optional().describe('Name filter'),
      page: z.number().int().optional(),
    },
    handler: (args, cfg) => request(cfg, '/employees', { query: { search: args.search, page: args.page } }),
  });

  registerTool(server, config, {
    name: 'clokio_lookup_employee',
    description:
      'Look up an employee by name or email to resolve their employee_code. Use this before assigning a task ' +
      'when you only know the person\'s name.',
    schema: {
      name: z.string().optional(),
      email: z.string().optional(),
    },
    handler: (args, cfg) =>
      request(cfg, '/employees/lookup', {
        method: 'POST',
        body: { name: args.name, email: args.email },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_get_employee_task_stats',
    description:
      "One employee's open / delayed_from_open / past_due task counts. stale_days sets the 'delayed' threshold " +
      '(default 7, range 1-365). A task with N assignees counts for each of them.',
    schema: {
      employee_code: z.string(),
      stale_days: z.number().int().min(1).max(365).optional(),
    },
    handler: (args, cfg) =>
      request(cfg, `/employees/${args.employee_code}/task-stats`, {
        query: { stale_days: args.stale_days },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_create_employee',
    mutates: true,
    description:
      'Create (or reactivate) an employee. Reactivating an existing inactive employee never resets their ' +
      'password. A pin (4-6 digits, org-unique) can be supplied or is auto-generated; it is returned only here.',
    schema: {
      name: z.string(),
      email: z.string().optional(),
      phone: z.string().optional(),
      location_id: z.number().int().optional(),
      pin: z.string().optional(),
    },
    handler: (args, cfg) =>
      request(cfg, '/employees', {
        method: 'POST',
        body: { name: args.name, email: args.email, phone: args.phone, location_id: args.location_id, pin: args.pin },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_set_employee_status',
    mutates: true,
    description: 'Set an employee\'s status (active / inactive / resign).',
    schema: {
      employee_code: z.string(),
      status: z.enum(['active', 'inactive', 'resign']),
    },
    handler: (args, cfg) =>
      request(cfg, `/employees/${args.employee_code}/status`, {
        method: 'PATCH',
        body: { status: args.status },
      }),
  });
}
