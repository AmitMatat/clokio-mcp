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

/** HH:MM of an API instant (UTC), or --:-- (0.22.0, N11: the list API gives UTC and no timezone). */
export function utcClock(iso: unknown): string {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? iso.slice(11, 16) : '--:--';
}

/** One time entry as one line: `#{id} {date} {in}-{out|RUNNING} UTC {hours}h | {code} | task #{id} {title} | {description}`. */
export function timeEntryLine(e: any): string {
  const id = e?.id === undefined || e?.id === null ? '(no id: server older than 2026-10-16)' : `#${e.id}`;
  const running = e?.running === true || e?.check_out === null;
  const task = e?.task ? `task #${e.task.id} ${e.task.title}` : 'no task';
  return `${id} ${e?.date ?? '-'} ${utcClock(e?.check_in)}-${running ? 'RUNNING' : utcClock(e?.check_out)} UTC ${e?.work_hour ?? 0}h | ${e?.employee_code ?? '-'} | ${task} | ${e?.description ?? ''}`;
}

export function renderTimeEntries(res: any): string {
  const rows: any[] = Array.isArray(res) ? res : (res?.data ?? []);
  const meta = res?.meta ?? {};
  return [
    "Times are UTC (HH:MM of the API's instants); clokio_update_time_entry takes the person's LOCAL date and times.",
    ...(rows.length ? rows.map(timeEntryLine) : ['No time entries.']),
    `Page ${meta.current_page ?? '-'} of ${meta.last_page ?? '-'} (total ${meta.total ?? '-'}); raise per_page or narrow from/to to see more.`,
  ].join('\n');
}

/** #3: the line clokio_stop_timer adds when the stopped entry lasted under a minute, else null. */
export function shortEntryWarning(entry: any): string | null {
  const a = Date.parse(entry?.check_in ?? '');
  const b = Date.parse(entry?.check_out ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const seconds = Math.round((b - a) / 1000);
  return seconds < 60
    ? `This entry lasted ${seconds} seconds. If it was a mistake, delete it with clokio_delete_time_entry id=${entry.id}.`
    : null;
}

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
      'Optionally narrow to one person or one project. ' +
      'Printed one line per entry with its id (for clokio_update_time_entry / clokio_delete_time_entry) and RUNNING for a timer still running; times in UTC.',
    schema: {
      from: z.string().describe('YYYY-MM-DD, required'),
      to: z.string().describe('YYYY-MM-DD, required, on or after from'),
      employee: employeeCode.optional().describe("An employee_code, e.g. '00080'"),
      project_id: z.number().int().optional(),
      per_page: z.number().int().min(1).max(100).optional(),
    },
    handler: async (args, cfg) =>
      renderTimeEntries(
        await request<any>(cfg, '/time-entries', {
          query: {
            from: args.from,
            to: args.to,
            employee: args.employee,
            project_id: args.project_id,
            per_page: args.per_page,
          },
        })
      ),
  });

  // Logging time (backend task #5775). The time is ALWAYS the key's acting
  // person's: none of these tools takes an employee, and the server refuses
  // one in the body. Scope time_entries:write: Full access, or ticked on a
  // key with chosen permissions.
  const actingPerson =
    "The time is ALWAYS recorded for the API key's ACTING person (its \"acts as\" employee, else the person who issued it), " +
    'never for anyone else; there is no way to log time for another employee. ' +
    'Needs the time_entries:write scope: Full access includes it; a key with chosen permissions must list it.';
  const taskRule =
    'The task must be one that person can view in your organisation, on an active project; a board another organisation ' +
    'shared with you is refused (404).';

  registerTool(server, config, {
    name: 'clokio_log_time',
    description:
      'Log a finished time entry on a task. ' + actingPerson + ' ' +
      'Times are local to that person (their location timezone, else UTC). Give EITHER date + start + end ' +
      '(an end at or before start runs past midnight), OR date + start + duration_minutes, OR duration_minutes alone ' +
      '(the entry then ENDS NOW and started that many minutes ago; date must be today or omitted). ' +
      'At most 12 hours (720 minutes) per entry; nothing may start or end more than 10 minutes in the future; ' +
      'an entry overlapping another time entry of the same person (including their running timer, and an overnight entry from the day before) is refused. ' +
      'A duration counts real minutes across a DST change. ' + taskRule + ' ' +
      "The project's billable flag is inherited and the description defaults to the task title.",
    schema: {
      task_id: z.number().int().positive(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional()
        .describe('YYYY-MM-DD, the day the entry STARTS. Required with start'),
      start: z.string().regex(/^\d{2}:\d{2}$/, 'start must be HH:MM').optional().describe('HH:MM, local time'),
      end: z.string().regex(/^\d{2}:\d{2}$/, 'end must be HH:MM').optional()
        .describe('HH:MM, local time. Give end OR duration_minutes, not both'),
      duration_minutes: z.number().int().min(1).max(720).optional(),
      description: z.string().max(255).optional(),
    },
    mutates: true,
    handler: (args, cfg) => {
      if ((args.end === undefined) === (args.duration_minutes === undefined)) {
        throw new Error('Give exactly one of end or duration_minutes.');
      }
      if (args.start !== undefined && args.date === undefined) {
        throw new Error('date is required with start.');
      }
      if (args.end !== undefined && args.start === undefined) {
        throw new Error('start is required with end.');
      }
      return request(cfg, '/time-entries', {
        method: 'POST',
        body: {
          task_id: args.task_id,
          date: args.date,
          start: args.start,
          end: args.end,
          duration_minutes: args.duration_minutes,
          description: args.description,
        },
      });
    },
  });

  registerTool(server, config, {
    name: 'clokio_start_timer',
    description:
      "Start a running timer on a task. " + actingPerson + ' ' + taskRule + ' ' +
      'If a timer is already running the call is refused (409) and the running entry is returned; ' +
      'pass force: true to stop that timer and start this one. The description defaults to the task title.',
    schema: {
      task_id: z.number().int().positive(),
      description: z.string().max(255).optional(),
      force: z.boolean().optional().describe('Stop a running timer first instead of being refused'),
    },
    mutates: true,
    handler: (args, cfg) =>
      request(cfg, '/timer/start', {
        method: 'POST',
        body: { task_id: args.task_id, description: args.description, force: args.force },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_stop_timer',
    description:
      "Stop the running timer of the API key's ACTING person (never anyone else's) and return the entry with its hours. " +
      'Refused (409) when nothing is running. Needs time_entries:write (Full access, or listed on the key). ' +
      'Short entries are kept (as on the web and mobile); one under a minute gets a line naming clokio_delete_time_entry.',
    schema: {},
    mutates: true,
    handler: async (_args, cfg) => {
      const res = await request<any>(cfg, '/timer/stop', { method: 'POST' });
      const warning = shortEntryWarning(res?.entry);
      return warning ? `${JSON.stringify(res, null, 2)}\n\n${warning}` : res;
    },
  });

  registerTool(server, config, {
    name: 'clokio_get_active_timer',
    description:
      "The running timer of the API key's ACTING person, or entry: null when none runs. Needs time_entries:read.",
    schema: {},
    handler: (_args, cfg) => request(cfg, '/timer/active'),
  });

  registerTool(server, config, {
    name: 'clokio_update_time_entry',
    description:
      "Correct one of the time entries of the API key's ACTING person (another person's entry is \"Not found\"). " +
      "Send only what changes: task_id (the entry moves to that task's project), description (null or empty resets it to the task title), " +
      'and/or the time: date (YYYY-MM-DD), start, end (HH:MM, LOCAL to that person) or duration_minutes (alone it keeps the start and sets the length). ' +
      'Parts you leave out keep their current values. The same checks as clokio_log_time: at most 12 hours, nothing in the future, ' +
      'no overlap with another entry of that person (their running timer included); an entry on an inactive project cannot change its time. ' +
      'A RUNNING entry takes only task_id and description: stop it before changing its times. Entry ids come from clokio_list_time_entries. ' +
      'Needs time_entries:write.',
    schema: {
      id: z.number().int().positive().describe('The entry id (clokio_list_time_entries)'),
      task_id: z.number().int().positive().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
      start: z.string().regex(/^\d{2}:\d{2}$/, 'start must be HH:MM').optional().describe('HH:MM, local time'),
      end: z.string().regex(/^\d{2}:\d{2}$/, 'end must be HH:MM').optional().describe('HH:MM, local time. Not with duration_minutes'),
      duration_minutes: z.number().int().min(1).max(720).optional(),
      description: z.string().max(255).nullable().optional(),
    },
    mutates: true,
    handler: async (args, cfg) => {
      const { id, ...rest } = args;
      const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      if (Object.keys(body).length === 0) throw new Error('Give at least one field to change.');
      if (body.end !== undefined && body.duration_minutes !== undefined) {
        throw new Error('Give end or duration_minutes, not both.');
      }
      const res = await request<any>(cfg, `/time-entries/${seg(id)}`, { method: 'PATCH', body });
      return `Updated: ${timeEntryLine(res?.entry ?? res)}`;
    },
  });

  registerTool(server, config, {
    name: 'clokio_delete_time_entry',
    description:
      "PERMANENTLY delete one of the time entries of the API key's ACTING person (another person's entry is \"Not found\"). " +
      'A running entry must be stopped first (clokio_stop_timer). Needs time_entries:write.',
    schema: { id: z.number().int().positive().describe('The entry id (clokio_list_time_entries)') },
    mutates: 'destructive',
    handler: async (args, cfg) => {
      const res = await request<any>(cfg, `/time-entries/${seg(args.id)}`, { method: 'DELETE' });
      const e = res?.entry ?? {};
      const task = e.task ? `task #${e.task.id} ${e.task.title}` : 'no task';
      return `Deleted entry ${e.id ?? args.id}: ${e.date ?? '-'} ${utcClock(e.check_in)}-${utcClock(e.check_out)} UTC, ${task}`;
    },
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
