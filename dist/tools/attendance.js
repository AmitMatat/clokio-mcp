import { z } from 'zod';
import { request } from '../client.js';
import { registerTool } from './helpers.js';
/** Attendance reads + clock/break writes, plus time entries and balances. */
export function registerAttendanceTools(server, config) {
    registerTool(server, config, {
        name: 'clokio_attendance_daily',
        description: 'Attendance for a single date (YYYY-MM-DD, defaults to today).',
        schema: { date: z.string().optional().describe('YYYY-MM-DD') },
        handler: (args, cfg) => request(cfg, '/attendance/daily', { query: { date: args.date } }),
    });
    registerTool(server, config, {
        name: 'clokio_attendance_range',
        description: 'Attendance for a date range (max 31 days).',
        schema: {
            start_date: z.string().describe('YYYY-MM-DD'),
            end_date: z.string().describe('YYYY-MM-DD'),
        },
        handler: (args, cfg) => request(cfg, '/attendance/range', { query: { start_date: args.start_date, end_date: args.end_date } }),
    });
    registerTool(server, config, {
        name: 'clokio_attendance_for_employee',
        description: "One employee's attendance. Optionally scope to a date range.",
        schema: {
            employee_code: z.string(),
            start_date: z.string().optional().describe('YYYY-MM-DD'),
            end_date: z.string().optional().describe('YYYY-MM-DD'),
        },
        handler: (args, cfg) => request(cfg, `/attendance/employee/${args.employee_code}`, {
            query: { start_date: args.start_date, end_date: args.end_date },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_attendance_summary',
        description: 'Monthly attendance summary.',
        schema: {
            month: z.string().optional().describe('YYYY-MM'),
        },
        handler: (args, cfg) => request(cfg, '/attendance/summary', { query: { month: args.month } }),
    });
    registerTool(server, config, {
        name: 'clokio_clock_in',
        mutates: true,
        description: 'Clock an employee in. A PIN may be required depending on org configuration. Timestamps are clamped to ' +
            '+/-10 minutes of server time.',
        schema: {
            employee_code: z.string(),
            pin: z.string().optional(),
            location_id: z.number().int().optional(),
        },
        handler: (args, cfg) => request(cfg, '/attendance/clock-in', {
            method: 'POST',
            body: { employee_code: args.employee_code, pin: args.pin, location_id: args.location_id },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_clock_out',
        mutates: true,
        description: 'Clock an employee out.',
        schema: {
            employee_code: z.string(),
            pin: z.string().optional(),
        },
        handler: (args, cfg) => request(cfg, '/attendance/clock-out', {
            method: 'POST',
            body: { employee_code: args.employee_code, pin: args.pin },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_break_start',
        mutates: true,
        description: 'Start a break for an employee.',
        schema: { employee_code: z.string(), pin: z.string().optional() },
        handler: (args, cfg) => request(cfg, '/attendance/break-start', {
            method: 'POST',
            body: { employee_code: args.employee_code, pin: args.pin },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_break_end',
        mutates: true,
        description: 'End a break for an employee.',
        schema: { employee_code: z.string(), pin: z.string().optional() },
        handler: (args, cfg) => request(cfg, '/attendance/break-end', {
            method: 'POST',
            body: { employee_code: args.employee_code, pin: args.pin },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_list_time_entries',
        description: 'List time-tracking entries. Filterable by employee_code and date range.',
        schema: {
            employee_code: z.string().optional(),
            start_date: z.string().optional().describe('YYYY-MM-DD'),
            end_date: z.string().optional().describe('YYYY-MM-DD'),
        },
        handler: (args, cfg) => request(cfg, '/time-entries', {
            query: { employee_code: args.employee_code, start_date: args.start_date, end_date: args.end_date },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_get_balances',
        description: 'Leave / hour balances.',
        schema: { employee_code: z.string().optional() },
        handler: (args, cfg) => request(cfg, '/balances', { query: { employee_code: args.employee_code } }),
    });
}
