import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ClokioConfig, request, seg } from '../client.js';
import { registerTool } from './helpers.js';

/** See employees.ts - an employee_code reaches the request path. */
const employeeCode = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,50}$/, 'employee_code must be 1-50 chars of letters, digits, _ or -');

/** The four clock/break writes share these three optional arguments. */
const pinArg = z
  .string()
  .regex(/^\d{4,6}$/, 'pin must be 4 to 6 digits')
  .optional()
  .describe("The employee's PIN, when the organization requires one");

const timestampArg = z
  .string()
  .optional()
  .describe("'YYYY-MM-DD HH:MM:SS'. Clamped to +/-10 minutes of server time; omit for now");

const noteArg = z.string().max(500).optional();

/** Attendance reads + clock/break writes, plus time entries and leave. */
export function registerAttendanceTools(server: McpServer, config: ClokioConfig): void {
  registerTool(server, config, {
    name: 'clokio_attendance_daily',
    description:
      'Attendance for ONE date. The date is REQUIRED - there is no "today" default, so pass today\'s date ' +
      'explicitly when that is what you want. Optionally scope to one employee.',
    schema: {
      date: z.string().describe('YYYY-MM-DD, required'),
      employee_code: employeeCode.optional(),
    },
    handler: (args, cfg) =>
      request(cfg, '/attendance/daily', { query: { date: args.date, employee_code: args.employee_code } }),
  });

  registerTool(server, config, {
    name: 'clokio_attendance_range',
    description: 'Attendance across a date range (max 31 days). Both dates are required.',
    schema: {
      date_from: z.string().describe('YYYY-MM-DD, required'),
      date_to: z.string().describe('YYYY-MM-DD, required, on or after date_from'),
      employee_code: employeeCode.optional(),
    },
    handler: (args, cfg) =>
      request(cfg, '/attendance/range', {
        query: { date_from: args.date_from, date_to: args.date_to, employee_code: args.employee_code },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_attendance_for_employee',
    description:
      "One employee's attendance, optionally narrowed to a calendar month. month and year are NUMBERS " +
      '(month 1-12), not a YYYY-MM string.',
    schema: {
      employee_code: employeeCode,
      month: z.number().int().min(1).max(12).optional(),
      year: z.number().int().min(1900).max(2100).optional(),
    },
    handler: (args, cfg) =>
      request(cfg, `/attendance/employee/${seg(args.employee_code)}`, {
        query: { month: args.month, year: args.year },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_attendance_employee_day',
    description:
      "One employee's detailed attendance for a single day, including breaks. Defaults to today when date " +
      'is omitted.',
    schema: {
      employee_code: employeeCode,
      date: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
    },
    handler: (args, cfg) =>
      request(cfg, `/attendance/employee/${seg(args.employee_code)}/today`, { query: { date: args.date } }),
  });

  registerTool(server, config, {
    name: 'clokio_attendance_today_detailed',
    description: 'Detailed attendance for EVERY employee on one day, including breaks. Defaults to today.',
    schema: { date: z.string().optional().describe('YYYY-MM-DD, defaults to today') },
    handler: (args, cfg) => request(cfg, '/attendance/today/detailed', { query: { date: args.date } }),
  });

  registerTool(server, config, {
    name: 'clokio_attendance_summary',
    description:
      'Monthly attendance summary for the organization. month and year are both REQUIRED and are NUMBERS ' +
      '(month 1-12), not a YYYY-MM string.',
    schema: {
      month: z.number().int().min(1).max(12).describe('1-12, required'),
      year: z.number().int().min(1900).max(2100).describe('e.g. 2026, required'),
    },
    handler: (args, cfg) =>
      request(cfg, '/attendance/summary', { query: { month: args.month, year: args.year } }),
  });

  registerTool(server, config, {
    name: 'clokio_clock_in',
    mutates: true,
    description:
      'Clock an employee in. A PIN may be required depending on org configuration. Timestamps are clamped to ' +
      '+/-10 minutes of server time.',
    schema: {
      employee_code: employeeCode,
      pin: pinArg,
      project_id: z.number().int().optional().describe('Attribute the session to a project'),
      timestamp: timestampArg,
      note: noteArg,
    },
    handler: (args, cfg) =>
      request(cfg, '/attendance/clock-in', {
        method: 'POST',
        body: {
          employee_code: args.employee_code,
          pin: args.pin,
          project_id: args.project_id,
          timestamp: args.timestamp,
          note: args.note,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_clock_out',
    mutates: true,
    description: 'Clock an employee out. A PIN may be required depending on org configuration.',
    schema: {
      employee_code: employeeCode,
      pin: pinArg,
      timestamp: timestampArg,
      note: noteArg,
    },
    handler: (args, cfg) =>
      request(cfg, '/attendance/clock-out', {
        method: 'POST',
        body: {
          employee_code: args.employee_code,
          pin: args.pin,
          timestamp: args.timestamp,
          note: args.note,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_break_start',
    mutates: true,
    description: 'Start a break for an employee.',
    schema: {
      employee_code: employeeCode,
      pin: pinArg,
      timestamp: timestampArg,
      note: noteArg,
    },
    handler: (args, cfg) =>
      request(cfg, '/attendance/break-start', {
        method: 'POST',
        body: {
          employee_code: args.employee_code,
          pin: args.pin,
          timestamp: args.timestamp,
          note: args.note,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_break_end',
    mutates: true,
    description: 'End a break for an employee.',
    schema: {
      employee_code: employeeCode,
      pin: pinArg,
      timestamp: timestampArg,
      note: noteArg,
    },
    handler: (args, cfg) =>
      request(cfg, '/attendance/break-end', {
        method: 'POST',
        body: {
          employee_code: args.employee_code,
          pin: args.pin,
          timestamp: args.timestamp,
          note: args.note,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_list_time_entries',
    description:
      'Time-tracking entries in a date range. from and to are both REQUIRED (YYYY-MM-DD, to >= from). ' +
      'Optionally narrow to one person or one project.',
    schema: {
      from: z.string().describe('YYYY-MM-DD, required'),
      to: z.string().describe('YYYY-MM-DD, required, on or after from'),
      employee: employeeCode.optional().describe("An employee_code, e.g. '00080'"),
      project_id: z.number().int().optional(),
      per_page: z.number().int().min(1).max(100).optional(),
    },
    handler: (args, cfg) =>
      request(cfg, '/time-entries', {
        query: {
          from: args.from,
          to: args.to,
          employee: args.employee,
          project_id: args.project_id,
          per_page: args.per_page,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_list_leaves',
    description:
      'Leave requests in a date range. from and to are both REQUIRED (YYYY-MM-DD, to >= from). ' +
      'Optionally narrow to one person by employee_code, or to one approval state.',
    schema: {
      from: z.string().describe('YYYY-MM-DD, required'),
      to: z.string().describe('YYYY-MM-DD, required, on or after from'),
      employee: employeeCode.optional().describe("An employee_code, e.g. '00080'"),
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
      per_page: z.number().int().min(1).max(100).optional(),
    },
    handler: (args, cfg) =>
      request(cfg, '/leaves', {
        query: {
          from: args.from,
          to: args.to,
          employee: args.employee,
          status: args.status,
          per_page: args.per_page,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_get_leave_balances',
    description:
      "One employee's leave balances (quota, used, remaining per leave type). The employee_code is REQUIRED - " +
      'there is no org-wide form of this call.',
    schema: {
      employee: employeeCode.describe("The employee_code, e.g. '00080'"),
    },
    handler: (args, cfg) => request(cfg, '/leaves/balances', { query: { employee: args.employee } }),
  });
}
