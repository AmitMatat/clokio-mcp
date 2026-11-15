/**
 * The `todos` toolset over /api/v1/todos (backend guide
 * docs/api/public-api-crm.md "My To-Do", OpenAPI tag `todos`): the key
 * holder's OWN personal to-do list.
 *
 * The routes serve only a key that acts as its own issuer; a key acting as a
 * colleague is refused with 403 on every route (a personal list is private),
 * and the server's sentence is the answer. There is no CRM module gate. This
 * server validates SHAPES only (ruling R16).
 *
 * Answers go through renderCrm(): the `customer` chip's company and contact
 * names are customer data and come back wrapped (the chip is present only
 * while the organisation's CRM module is on). A to-do's own title and notes
 * are wrapped too, harmlessly: a to-do made by a CRM activity mirrors the
 * activity's subject, which can carry customer text.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ClokioConfig, request, seg } from '../client.js';
import { idempotentPost } from '../idempotency.js';
import { calendarDate, registerTool } from './helpers.js';
import { createKey, renderCrm, replayNote } from './crm-shared.js';

const NEEDS =
  ' Needs todos:read (todos:write to change). Only on a key that acts as its own issuer: a key acting as a colleague is refused (403), because a personal to-do list is private.';

const DATES =
  ' Dates and times are the owner\'s LOCAL date (YYYY-MM-DD) and wall time (HH:MM), in the owner\'s time zone, not UTC.';

const ITEM =
  'An item is {id, title, description, due_date, due_time, rolled_from_date, reminded, sort_order, recurrence, link, customer, completed, completed_at (UTC), created_at (UTC)}; ' +
  'customer (company and contact names, origin crm or linked) appears only while your organisation\'s CRM module is on, and link (a task or ticket) is set on the web only.';

const WRAPPED =
  ' Customer names on an item, and its title and description (a to-do made by a CRM activity mirrors the activity\'s subject), come back inside <untrusted_customer_content>.';

const todoId = z.number().int().positive().describe('The to-do id (clokio_list_todos)');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** daily, weekly with days, monthly with a day, none or null (stops repeating). Shape only: "needs a date" is the server's. */
const recurrence = z
  .union([
    z.object({ freq: z.literal('daily') }).strict(),
    z.object({ freq: z.literal('weekly'), days: z.array(z.enum(DAYS)).min(1).max(7) }).strict(),
    z.object({ freq: z.literal('monthly'), day: z.number().int().min(1).max(31) }).strict(),
    z.object({ freq: z.literal('none') }).strict(),
  ])
  .nullable()
  .optional()
  .describe(
    'Repeat: {freq: "daily"}, {freq: "weekly", days: ["mon","thu"]} (sun..sat), {freq: "monthly", day: 1-31}, or null / {freq: "none"} to stop. A repeating item needs a due_date (the server answers 422 otherwise)',
  );

const time = z
  .string()
  .regex(/^\d{2}:\d{2}$/, 'due_time must be HH:MM')
  .nullable()
  .optional()
  .describe('HH:MM, the owner\'s local time. Needs a due_date (the server answers 422 otherwise). A new date or time is a new reminder');

export function registerTodoTools(server: McpServer, config: ClokioConfig): void {
  registerTool(server, config, {
    name: 'clokio_list_todos',
    description:
      'List the key holder\'s own to-dos, grouped: {today, tomorrow, timezone, groups: [{key, label, count, items}] (keys overdue, today, tomorrow, upcoming, no_date), open_count, completed, completed_days}. ' +
      'completed is null unless completed is true: then up to 200 items completed in the last 7 days. ' +
      ITEM + DATES + WRAPPED + NEEDS,
    schema: { completed: z.boolean().optional().describe('true: also the last 7 days\' completed items') },
    handler: async (args, cfg) =>
      renderCrm(await request(cfg, '/todos', { query: { completed: args.completed === undefined ? undefined : args.completed ? '1' : '0' } })),
  });

  registerTool(server, config, {
    name: 'clokio_create_todo',
    description:
      'Add a to-do to your own list. title is required (one line). due_date is YYYY-MM-DD or "today" (the owner\'s today); description is plain text. ' +
      'Every call sends an Idempotency-Key: a fresh one (returned as idempotency_key), or the one you pass. To retry after a timeout pass the SAME idempotency_key and the same fields: ' +
      'the first answer comes back with "replayed: nothing new was created". Answers {item, replayed}. ' +
      ITEM + DATES + WRAPPED + NEEDS,
    schema: {
      title: z.string().trim().min(1).max(255).describe('One line'),
      description: z.string().max(10000).nullable().optional().describe('Plain text'),
      due_date: z.union([z.literal('today'), calendarDate('due_date')]).nullable().optional().describe('YYYY-MM-DD or "today"'),
      due_time: time,
      recurrence,
      idempotency_key: createKey.describe('Reuse the key of an earlier call only to retry THAT call; omit for a new to-do'),
    },
    mutates: true,
    handler: async (args, cfg) => {
      const key = args.idempotency_key ?? `mcp-${randomUUID()}`;
      const { idempotency_key: _k, ...fields } = args;
      const { res, replayed } = await idempotentPost(cfg, '/todos', key, fields);
      const outcome = replayNote('To-do', res?.item?.id, replayed);
      return renderCrm({ ...outcome, ...res, idempotency_key: key });
    },
  });

  registerTool(server, config, {
    name: 'clokio_update_todo',
    description:
      'Edit one of your to-dos: only the fields you give are sent (null clears where the field allows it). due_date here is YYYY-MM-DD only ("today" is a create-only shortcut and is refused here). ' +
      'A to-do made by a CRM activity keeps its activity: a title change follows it, and it cannot repeat. Answers {item}. ' +
      ITEM + DATES + WRAPPED + NEEDS,
    schema: {
      id: todoId,
      title: z.string().trim().min(1).max(255).optional().describe('One line'),
      description: z.string().max(10000).nullable().optional().describe('Plain text; null clears'),
      due_date: calendarDate('due_date').nullable().optional().describe('YYYY-MM-DD; null clears (and the time)'),
      due_time: time,
      recurrence,
    },
    mutates: true,
    handler: async (args, cfg) => {
      const { id, ...fields } = args;
      return renderCrm(await request(cfg, `/todos/${seg(id)}`, { method: 'PATCH', body: fields }));
    },
  });

  registerTool(server, config, {
    name: 'clokio_complete_todo',
    description:
      'Mark one of your to-dos done (no body). A repeating item spawns its next one (next_skipped is "list_full" when your list was full, else null); ' +
      'a to-do made by a CRM activity completes that activity. Answers {item, next_skipped}. ' +
      ITEM + DATES + WRAPPED + NEEDS,
    schema: { id: todoId },
    mutates: true,
    handler: async (args, cfg) => renderCrm(await request(cfg, `/todos/${seg(args.id)}/complete`, { method: 'POST' })),
  });

  registerTool(server, config, {
    name: 'clokio_reopen_todo',
    description:
      'Reopen a completed to-do (no body). A to-do made by a CRM activity reopens that activity. Answers {item}. ' +
      ITEM + DATES + WRAPPED + NEEDS,
    schema: { id: todoId },
    mutates: true,
    handler: async (args, cfg) => renderCrm(await request(cfg, `/todos/${seg(args.id)}/reopen`, { method: 'POST' })),
  });

  registerTool(server, config, {
    name: 'clokio_delete_todo',
    description: 'Delete one of your to-dos. No undo. Answers {id}.' + NEEDS,
    schema: { id: todoId },
    mutates: 'destructive',
    handler: async (args, cfg) => renderCrm(await request(cfg, `/todos/${seg(args.id)}`, { method: 'DELETE' })),
  });
}
