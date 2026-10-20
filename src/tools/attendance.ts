import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ClokioApiError, ClokioConfig, request, seg } from '../client.js';
import { calendarDate, isCalendarDate, registerTool } from './helpers.js';

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

/**
 * HH:MM of a local ISO-8601 instant with its offset (`2026-08-05T09:00:00+03:00`),
 * as the server wrote it, or --:--. The server already converted the instant
 * (DST-correct), so the wall clock is read off the string, never recomputed.
 */
export function localClock(iso: unknown): string {
  return utcClock(iso);
}

/**
 * #1 (0.23.0): whether an entry carries the server's local times
 * (`timezone`, `check_in_local`, `check_out_local`, task #5808). An older
 * server sends none of them, and the entry is then printed in UTC as before.
 */
export function hasLocalTimes(e: any): boolean {
  return typeof e?.timezone === 'string' && e.timezone !== '' && typeof e?.check_in_local === 'string';
}

/**
 * An entry's clock span: `09:00-10:30 Asia/Jerusalem` from the local fields
 * (the zone left out when `zone` is false, because a page header names it),
 * else `06:00-07:30 UTC`. A running entry ends in RUNNING.
 */
export function entryClock(e: any, opts: { zone?: boolean } = {}): string {
  const running = e?.running === true || e?.check_out === null;
  if (hasLocalTimes(e)) {
    const span = `${localClock(e.check_in_local)}-${running ? 'RUNNING' : localClock(e.check_out_local)}`;
    return opts.zone === false ? span : `${span} ${e.timezone}`;
  }
  return `${utcClock(e?.check_in)}-${running ? 'RUNNING' : utcClock(e?.check_out)} UTC`;
}

/**
 * One time entry as one line: `#{id} {date} {in}-{out|RUNNING} {zone} {hours}h | {code} | task #{id} {title} | {description}`.
 * The zone is the entry's `timezone` (local times) or UTC (an older server).
 * `zone: false` drops a local entry's zone, for a page whose header names it once.
 */
export function timeEntryLine(e: any, opts: { zone?: boolean } = {}): string {
  const id = e?.id === undefined || e?.id === null ? '(no id: server older than 2026-10-16)' : `#${e.id}`;
  // An entry may be on a project with no task (task #5775): name the project then.
  const task = e?.task
    ? `task #${e.task.id} ${e.task.title}`
    : e?.project?.name ? `no task, project ${e.project.name}` : 'no task';
  return `${id} ${e?.date ?? '-'} ${entryClock(e, opts)} ${e?.work_hour ?? 0}h | ${e?.employee_code ?? '-'} | ${task} | ${e?.description ?? ''}`;
}

const ZONE_NOTE =
  "the person's CURRENT location zone, which clokio_update_time_entry reads date/start/end in (after a location change it may differ from where the entry was logged)";

/**
 * The page header and rows. One zone on the page: named once in the header,
 * rows without it. Several zones (or a mix with UTC rows): each row names its
 * own. No local times at all (an older server): the 0.22 UTC output. No rows:
 * "No time entries." and no zone claimed either way.
 */
export function renderTimeEntries(res: any): string {
  const rows: any[] = Array.isArray(res) ? res : (res?.data ?? []);
  const meta = res?.meta ?? {};
  const local = rows.filter(hasLocalTimes);
  const zones = new Set(local.map((e) => e.timezone));
  let header: string;
  let zoneInRow = true;
  if (rows.length === 0) {
    // N2 (0.25.0): no row to read a zone from, so the header claims none.
    header =
      "No time entries. (No row to read a time zone from; clokio_update_time_entry takes the person's LOCAL date and times, in their location's zone.)";
  } else if (local.length === 0) {
    header = "Times are UTC (HH:MM of the API's instants); clokio_update_time_entry takes the person's LOCAL date and times.";
  } else if (zones.size === 1 && local.length === rows.length) {
    header = `Times are local, in ${[...zones][0]}: ${ZONE_NOTE}.`;
    zoneInRow = false;
  } else {
    header = `Times are local; each row names its zone: ${ZONE_NOTE}. A row marked UTC came without local times.`;
  }
  return [
    header,
    ...rows.map((e) => timeEntryLine(e, { zone: zoneInRow })),
    `Page ${meta.current_page ?? '-'} of ${meta.last_page ?? '-'} (total ${meta.total ?? '-'}); raise per_page or narrow from/to to see more.`,
  ].join('\n');
}

/**
 * #1 (0.23.0): the object answers of log_time, start_timer, stop_timer and
 * get_active_timer keep the API's object and gain `entry_line`, the entry in
 * the list's one-line form (local HH:MM and the zone, or UTC on an older
 * server), placed first. No entry (nothing running): the answer is unchanged.
 */
export function withEntryLine(res: any): any {
  const entry = res?.entry;
  if (res === null || typeof res !== 'object' || Array.isArray(res) || !entry || typeof entry !== 'object') return res;
  return { entry_line: timeEntryLine(entry), ...res };
}

/** Leave rows (L1, 0.23.0) as lines; `days` when the server sends it, else the dates count with a note. */
export function leaveLine(l: any): string {
  const t = l?.leave_type ?? {};
  const dv = typeof t.day_value === 'number' ? ` day_value ${t.day_value}${t.day_value === 0.5 ? ' (half day)' : t.day_value === 1 ? ' (full day)' : ''}` : '';
  const type = `${t.name ?? '-'} (${t.code ?? '-'}${dv ? `,${dv}` : ''})`;
  const n = l?.number_of_days;
  const count =
    typeof l?.days === 'number'
      ? `${l.days} day${l.days === 1 ? '' : 's'} (${n ?? '-'} date${n === 1 ? '' : 's'})`
      : `${n ?? '-'} date${n === 1 ? '' : 's'} (no \`days\` from this server: a half-day type still counts 1 per date)`;
  const dates = Array.isArray(l?.dates) && l.dates.length ? ` | dates ${l.dates.join(', ')}` : '';
  return `${l?.employee_code ?? '-'} ${l?.employee_name ?? ''} | ${type} | ${l?.status ?? '-'} | ${l?.start_date ?? '-'} to ${l?.end_date ?? '-'} | ${count}${dates} | requested ${l?.requested_at ?? '-'}`;
}

export function renderLeaves(res: any): string {
  const rows: any[] = Array.isArray(res) ? res : (res?.data ?? []);
  const meta = res?.meta ?? {};
  return [
    'Leave requests. To count days taken, sum `days` (dates x the type\'s day_value, half days 0.5), never number_of_days (dates).',
    ...(rows.length ? rows.map(leaveLine) : ['No leave requests.']),
    `Page ${meta.current_page ?? '-'} of ${meta.last_page ?? '-'} (total ${meta.total ?? '-'}); raise per_page or narrow from/to to see more.`,
  ].join('\n');
}

/** L4 (0.23.0): GET /leaves/balances as text: days taken per type for the year, never a balance. */
export function renderLeaveTaken(res: any): string {
  const d = res ?? {};
  const who = `${d.employee_name ?? ''} (${d.employee_code ?? '-'})`.trim();
  const lines: string[] = [];
  if (!Array.isArray(d.taken)) {
    lines.push(
      `${who}: this server reports no days taken (it predates the leave-day counts of task #5808).`,
      'Clokio tracks no quota or remaining balance. Count days with clokio_list_leaves (status APPROVED): number_of_days there counts dates, so a half-day leave counts 1.',
    );
  } else {
    lines.push(
      `Days taken by ${who} in ${d.year ?? '-'}, per leave type. Clokio counts the days taken (half days count 0.5); it tracks no quota or remaining balance, so nothing here is days left.`,
    );
    if (!d.taken.length) lines.push('No leave types.');
    for (const r of d.taken) {
      const t = r?.leave_type ?? {};
      lines.push(
        `- ${t.name ?? '-'} (${t.code ?? '-'}${t.counts_as ? `, counts as ${t.counts_as}` : ''}, day_value ${t.day_value ?? '-'}): taken ${r?.taken_days ?? 0}, pending ${r?.pending_days ?? 0}`,
      );
    }
  }
  if (Array.isArray(d.balances) && d.balances.length) {
    lines.push(`balances (rows inserted by hand, not maintained by Clokio): ${JSON.stringify(d.balances)}`);
  }
  return lines.join('\n');
}

/**
 * L2 (0.23.0): the leave and time-entry tools take `employee_code`, like every
 * other tool, and keep `employee` (their old name) as an alias. Both with
 * different values is refused. The API's query parameter stays `employee`.
 */
export function employeeFilter(args: { employee_code?: string; employee?: string }): string | undefined {
  const { employee_code: code, employee: alias } = args;
  if (code !== undefined && alias !== undefined && code !== alias) {
    throw new Error(
      `employee_code "${code}" and employee "${alias}" disagree. employee is an old name for employee_code: send employee_code only.`,
    );
  }
  return code ?? alias;
}

/** The server's limit on GET /leaves and GET /time-entries: `to - from` at most this many days. */
export const MAX_RANGE_DAYS = 92;

/**
 * L3 (0.23.0): the 92-day rule checked before the request, with the server's
 * own arithmetic (whole UTC days from `from` to `to`) and its sentence. A
 * YYYY-MM-DD that is not a real date (2026-02-30) is refused as a date; other
 * shapes are left for the server to refuse. Never splits.
 */
export function assertRangeWithinLimit(from: string, to: string): void {
  // A real calendar date only (0.23.0 review): Date.parse rolls 2026-02-30 over
  // to 2 March, which would then be refused with the range sentence instead of
  // the date error the caller needs. A well-formed but impossible date is
  // refused here, before any request; other shapes are left to the server.
  const day = (v: string, name: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return NaN;
    if (!isCalendarDate(v)) throw new Error(`${name} ${v} is not a real calendar date (YYYY-MM-DD).`);
    return Date.parse(`${v}T00:00:00Z`);
  };
  const a = day(from, 'from');
  const b = day(to, 'to');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return;
  if ((b - a) / 86_400_000 > MAX_RANGE_DAYS) {
    throw new Error(
      `Date range cannot exceed ${MAX_RANGE_DAYS} days. from ${from} to ${to} is ${Math.round((b - a) / 86_400_000)} days: ` +
        'split it into windows of at most 92 days (to - from <= 92) and call once per window.',
    );
  }
}

const employeeCodeArg = employeeCode
  .optional()
  .describe("An employee_code, e.g. '00080'");
const employeeAliasArg = employeeCode
  .optional()
  .describe('Old name of employee_code, still accepted. Send employee_code instead');

/**
 * clokio_stop_timer's answer: always the API's object (like start_timer,
 * log_time and get_active_timer), plus a `warning` field when the stopped
 * entry lasted under a minute. Never a string, so a caller reads one shape.
 */
export function withShortEntryWarning(res: any): any {
  const warning = shortEntryWarning(res?.entry);
  if (!warning || res === null || typeof res !== 'object' || Array.isArray(res)) return res;
  return { ...res, warning };
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
      'Time-tracking entries in a date range. from and to are both REQUIRED (YYYY-MM-DD, to >= from), ' +
      'and to - from may be at most 92 days (93 calendar dates); a longer range is refused before any request, so split it yourself. ' +
      'Optionally narrow to one person (employee_code) or one project (project_id). ' +
      'Printed one line per entry with its id (for clokio_update_time_entry / clokio_delete_time_entry) and RUNNING for a timer still running. ' +
      "Times are LOCAL HH:MM in the person's current location zone (the zone clokio_update_time_entry reads), named once in the header, or on each row when the page mixes zones; " +
      'a server without local times (older than task #5808) prints UTC, and the header says so. Needs time_entries:read.',
    schema: {
      from: z.string().describe('YYYY-MM-DD, required'),
      to: z.string().describe('YYYY-MM-DD, required, on or after from, at most 92 days after it'),
      employee_code: employeeCodeArg,
      employee: employeeAliasArg,
      project_id: z.number().int().optional(),
      per_page: z.number().int().min(1).max(100).optional(),
    },
    handler: async (args, cfg) => {
      const employee = employeeFilter(args);
      assertRangeWithinLimit(args.from, args.to);
      return renderTimeEntries(
        await request<any>(cfg, '/time-entries', {
          query: {
            from: args.from,
            to: args.to,
            employee,
            project_id: args.project_id,
            per_page: args.per_page,
          },
        })
      );
    },
  });

  // Logging time (backend task #5775). The time is ALWAYS the key's acting
  // person's: none of these tools takes an employee, and the server refuses
  // one in the body. Scope time_entries:write: Full access, or ticked on a
  // key with chosen permissions.
  const ENTRY_LINE_NOTE =
    "The answer is the API's object with entry_line first: the entry in one line, LOCAL HH:MM and the person's zone " +
    '(UTC on a server older than task #5808).';
  const actingPerson =
    "The time is ALWAYS recorded for the API key's ACTING person (its \"acts as\" employee, else the person who issued it), " +
    'never for anyone else; there is no way to log time for another employee. ' +
    'Needs the time_entries:write scope: Full access includes it; a key with chosen permissions must list it.';
  const taskRule =
    'The task must be one that person can view in your organisation, on an active project; a board another organisation ' +
    'shared with you is refused (404).';
  const targetRule =
    'WHAT THE TIME IS ON, like the web Timer page (both optional): task_id, project_id, both, or neither. ' +
    'Neither = a personal entry with no project (not billable). project_id alone = on that project with no task. ' +
    "Both = the task decides and project_id must be the task's own project (refused otherwise). " +
    "A project must be an active project of your organisation (clokio_list_projects). Entries hold no client: to log time for a client, use one of the client's projects. " +
    taskRule;

  registerTool(server, config, {
    name: 'clokio_log_time',
    description:
      'Log a finished time entry, on a task, a project, or neither. ' + actingPerson + ' ' +
      'Times are local to that person (their location timezone, else UTC). Give EITHER date + start + end ' +
      '(an end at or before start runs past midnight), OR date + start + duration_minutes, OR duration_minutes alone ' +
      '(the entry then ENDS NOW and started that many minutes ago; date must be today or omitted). ' +
      'At most 12 hours (720 minutes) per entry; nothing may start or end more than 10 minutes in the future; ' +
      'an entry overlapping another time entry of the same person (including their running timer, and an overnight entry from the day before) is refused. ' +
      'A duration counts real minutes across a DST change. ' + targetRule + ' ' +
      "The project's billable flag is inherited (no project: not billable) and the description defaults to the task title (empty without a task). " +
      ENTRY_LINE_NOTE,
    schema: {
      task_id: z.number().int().positive().optional().describe('Optional. The task the time is on'),
      project_id: z.number().int().positive().optional()
        .describe("Optional. A project of your organisation; with task_id it must be the task's project"),
      date: calendarDate('date').optional()
        .describe('YYYY-MM-DD, the day the entry STARTS. Required with start'),
      start: z.string().regex(/^\d{2}:\d{2}$/, 'start must be HH:MM').optional().describe('HH:MM, local time'),
      end: z.string().regex(/^\d{2}:\d{2}$/, 'end must be HH:MM').optional()
        .describe('HH:MM, local time. Give end OR duration_minutes, not both'),
      duration_minutes: z.number().int().min(1).max(720).optional(),
      description: z.string().max(255).optional(),
    },
    mutates: true,
    handler: async (args, cfg) => {
      if ((args.end === undefined) === (args.duration_minutes === undefined)) {
        throw new Error('Give exactly one of end or duration_minutes.');
      }
      if (args.start !== undefined && args.date === undefined) {
        throw new Error('date is required with start.');
      }
      if (args.end !== undefined && args.start === undefined) {
        throw new Error('start is required with end.');
      }
      return withEntryLine(await request<any>(cfg, '/time-entries', {
        method: 'POST',
        body: {
          task_id: args.task_id,
          project_id: args.project_id,
          date: args.date,
          start: args.start,
          end: args.end,
          duration_minutes: args.duration_minutes,
          description: args.description,
        },
      }));
    },
  });

  registerTool(server, config, {
    name: 'clokio_start_timer',
    description:
      'Start a running timer on a task, a project, or neither (a personal timer). ' + actingPerson + ' ' + targetRule + ' ' +
      'If a timer is already running the call is refused (409) and the running entry is returned; ' +
      'pass force: true to stop that timer and start this one. The description defaults to the task title (empty without a task). ' +
      'clokio_stop_timer stops any timer; the web Timer page asks for a project and a description before its own Stop, ' +
      'so give a personal timer a description (and stop it here) if the person may stop it on the web. ' +
      ENTRY_LINE_NOTE,
    schema: {
      task_id: z.number().int().positive().optional().describe('Optional. The task the timer is on'),
      project_id: z.number().int().positive().optional()
        .describe("Optional. A project of your organisation; with task_id it must be the task's project"),
      description: z.string().max(255).optional(),
      force: z.boolean().optional().describe('Stop a running timer first instead of being refused'),
    },
    mutates: true,
    handler: async (args, cfg) => {
      try {
        return withEntryLine(
          await request<any>(cfg, '/timer/start', {
            method: 'POST',
            body: { task_id: args.task_id, project_id: args.project_id, description: args.description, force: args.force },
          }),
        );
      } catch (e) {
        // The 409 carries the running entry: name it in the same one-line form.
        const active = e instanceof ClokioApiError ? (e.body as any)?.data?.active_entry : undefined;
        if (e instanceof ClokioApiError && active && typeof active === 'object') {
          throw new ClokioApiError(e.status, `${e.message} Running: ${timeEntryLine(active)}`, e.body);
        }
        throw e;
      }
    },
  });

  registerTool(server, config, {
    name: 'clokio_stop_timer',
    description:
      "Stop the running timer of the API key's ACTING person (never anyone else's) and return the entry with its hours. " +
      'Refused (409) when nothing is running. Needs time_entries:write (Full access, or listed on the key). ' +
      'Short entries are kept (as on the web and mobile); one under a minute gets a warning field naming clokio_delete_time_entry. ' +
      ENTRY_LINE_NOTE,
    schema: {},
    mutates: true,
    handler: async (_args, cfg) => {
      const res = await request<any>(cfg, '/timer/stop', { method: 'POST' });
      return withShortEntryWarning(withEntryLine(res));
    },
  });

  registerTool(server, config, {
    name: 'clokio_get_active_timer',
    description:
      "The running timer of the API key's ACTING person, or entry: null when none runs. Needs time_entries:read. " +
      ENTRY_LINE_NOTE,
    schema: {},
    handler: async (_args, cfg) => withEntryLine(await request<any>(cfg, '/timer/active')),
  });

  registerTool(server, config, {
    name: 'clokio_update_time_entry',
    description:
      "Correct one of the time entries of the API key's ACTING person (another person's entry is \"Not found\"). " +
      "Send only what changes: task_id (the entry moves to that task's project; null unlinks the task and keeps the project), " +
      'project_id (an active project of your organisation, or null to clear it; billable follows the project). ' +
      "On an entry that is on a task, project_id must be the task's own project: to move it elsewhere send task_id: null with it. " +
      'description (null or empty resets it to the task title, empty without a task), ' +
      'and/or the time: date (YYYY-MM-DD), start, end (HH:MM, LOCAL to that person) or duration_minutes (alone it keeps the start and sets the length; start alone moves the entry and keeps its length). ' +
      'Parts you leave out keep their current values. The same checks as clokio_log_time: at most 12 hours, nothing in the future, ' +
      'no overlap with another entry of that person (their running timer included); an entry on an inactive project cannot change its time. ' +
      'A RUNNING entry takes only task_id and description: stop it before changing its times. Entry ids come from clokio_list_time_entries. ' +
      'Needs time_entries:write.',
    schema: {
      id: z.number().int().positive().describe('The entry id (clokio_list_time_entries)'),
      task_id: z.number().int().positive().nullable().optional().describe('A task to link, or null to unlink the task'),
      project_id: z.number().int().positive().nullable().optional().describe('A project of your organisation, or null to clear it'),
      date: calendarDate('date').optional(),
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
      return `Deleted entry ${e.id ?? args.id}: ${e.date ?? '-'} ${entryClock(e)}, ${task}`;
    },
  });

  registerTool(server, config, {
    name: 'clokio_list_leaves',
    description:
      'Leave requests in a date range. from and to are both REQUIRED (YYYY-MM-DD, to >= from), ' +
      'and to - from may be at most 92 days (93 calendar dates); a longer range is refused before any request, so split it yourself ' +
      '(a leave that crosses two windows is returned in both, and rows carry no id to tell them apart). ' +
      'Optionally narrow to one person by employee_code, or to one approval state. Needs leaves:read. ' +
      'Printed one line per request: the type with its day_value (1 a full day, 0.5 a half day), the status, the range, ' +
      '`days` (dates x day_value, e.g. 1.5 for three half days) and number_of_days (the count of DATES). Sum `days` for days taken, never number_of_days. ' +
      'A server older than task #5808 sends no `days`; the row then says so, and a half-day type counts 1 per date there.',
    schema: {
      from: z.string().describe('YYYY-MM-DD, required'),
      to: z.string().describe('YYYY-MM-DD, required, on or after from, at most 92 days after it'),
      employee_code: employeeCodeArg,
      employee: employeeAliasArg,
      status: z
        .enum(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED', 'CANCELLED'])
        .optional()
        .describe(
          'REVOKED = approved, then withdrawn by an approver; CANCELLED = withdrawn by the employee before a decision',
        ),
      per_page: z.number().int().min(1).max(100).optional(),
    },
    handler: async (args, cfg) => {
      const employee = employeeFilter(args);
      assertRangeWithinLimit(args.from, args.to);
      return renderLeaves(
        await request<any>(cfg, '/leaves', {
          query: {
            from: args.from,
            to: args.to,
            employee,
            status: args.status,
            per_page: args.per_page,
          },
        }),
      );
    },
  });

  // N3 (0.25.0): the tool returns days TAKEN, not balances, so it has that name.
  // The old name stays as a deprecated alias with the same handler.
  const leaveDaysTakenDescription =
    'Days of leave one employee TOOK in a calendar year, per leave type: taken (approved) and pending, in days. ' +
    'Clokio counts days taken, half days included (a half-day type counts 0.5 per date, so three half days are 1.5); ' +
    'it tracks NO quota and NO remaining balance, so nothing here is "days left" and no answer means "zero days left". ' +
    'Rejected, revoked and cancelled requests count nothing; a request across New Year counts only its dates inside the year. ' +
    'Every active leave type is listed, zeros included. year defaults to the current year in the employee\'s time zone (2000-2100). ' +
    'employee_code is REQUIRED; there is no org-wide form of this call. Needs leaves:read. ' +
    'A server older than task #5808 reports no days taken; the answer then says so.';
  // Called with { name: '...' } literals so the conformance test's source scan sees both names.
  const registerLeaveDaysTaken = ({ name, description }: { name: string; description: string }) =>
    registerTool(server, config, {
      name,
      description,
      schema: {
        employee_code: employeeCodeArg.describe("The employee_code, e.g. '00080'. Required"),
        employee: employeeAliasArg,
        year: z.number().int().min(2000).max(2100).optional().describe('The calendar year to count, e.g. 2026. Default: the current year'),
      },
      handler: async (args, cfg) => {
        const employee = employeeFilter(args);
        if (employee === undefined) throw new Error('employee_code is required: whose leave? (no org-wide form of this call)');
        return renderLeaveTaken(await request<any>(cfg, '/leaves/balances', { query: { employee, year: args.year } }));
      },
    });
  registerLeaveDaysTaken({ name: 'clokio_get_leave_days_taken', description: leaveDaysTakenDescription });
  registerLeaveDaysTaken({
    name: 'clokio_get_leave_balances',
    description:
      'DEPRECATED: use clokio_get_leave_days_taken (same answer; this old name is kept as an alias and will be removed in a later version). ' +
      leaveDaysTakenDescription,
  });
}
