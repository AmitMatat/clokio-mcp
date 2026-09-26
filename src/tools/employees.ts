import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ClokioConfig, request, seg } from '../client.js';
import { registerTool } from './helpers.js';

/**
 * An employee_code goes into the request PATH, so it must not be able to carry
 * a path separator or a query marker - see seg() / the /api/v1 guard in
 * client.js. This mirrors the constraint the API route itself declares
 * (`->where('employeeCode', '[A-Za-z0-9_-]{1,50}')`).
 */
const employeeCode = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,50}$/, 'employee_code must be 1-50 chars of letters, digits, _ or -');

/** Employee directory + provisioning. */
export function registerEmployeeTools(server: McpServer, config: ClokioConfig): void {
  registerTool(server, config, {
    name: 'clokio_list_employees',
    description:
      'Find people. This is how you resolve a PERSON TO THEIR employee_code - the stable id every other tool ' +
      'wants for assignees, comment authors and task creators. Pass `search` with a name (or part of one) ' +
      'rather than listing everyone and matching yourself. Combine with status=active to skip people who have ' +
      'left. email is returned only if the key holds the employees:pii scope.',
    schema: {
      search: z.string().max(120).optional().describe('Free text over name and employee_code'),
      email: z.string().optional().describe('EXACT email match (not a substring search)'),
      status: z.enum(['active', 'inactive']).optional(),
      department: z.string().optional().describe('Exact department name'),
      per_page: z.number().int().min(1).max(100).optional().describe('1-100, default 25'),
    },
    handler: (args, cfg) =>
      request(cfg, '/employees', {
        query: {
          search: args.search,
          email: args.email,
          status: args.status,
          department: args.department,
          per_page: args.per_page,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_lookup_employee_by_pin',
    description:
      'Resolve an employee from their 4-6 digit clock-in PIN. This is for kiosk and terminal flows where a ' +
      'person identifies themselves by PIN - it is NOT a name or email search. To find someone by name or ' +
      'email use clokio_list_employees. Answers 404 when no ACTIVE employee holds that PIN.',
    schema: {
      pin: z
        .string()
        .regex(/^\d{4,6}$/, 'pin must be 4 to 6 digits')
        .describe("The employee's clock-in PIN"),
    },
    handler: (args, cfg) =>
      request(cfg, '/employees/lookup', {
        method: 'POST',
        body: { pin: args.pin },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_get_employee_task_stats',
    description:
      "One employee's open / delayed_from_open / past_due task counts. stale_days sets the 'delayed' threshold " +
      '(default 7, range 1-365). A task with N assignees counts for each of them.',
    schema: {
      employee_code: employeeCode,
      stale_days: z.number().int().min(1).max(365).optional(),
    },
    handler: (args, cfg) =>
      request(cfg, `/employees/${seg(args.employee_code)}/task-stats`, {
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
      employee_code: employeeCode,
      status: z.enum(['active', 'inactive', 'resign']),
    },
    handler: (args, cfg) =>
      request(cfg, `/employees/${seg(args.employee_code)}/status`, {
        method: 'PATCH',
        body: { status: args.status },
      }),
  });
}
