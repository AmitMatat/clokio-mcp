import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { request, seg } from '../client.js';
import { idempotentPost } from '../idempotency.js';
import { calendarDate, registerTool } from './helpers.js';
import { CRM_NEEDS, createKey, customerType, employeeCode, renderCrm, subjectPath } from './crm-shared.js';
const activityId = z.number().int().positive().describe('The activity id (clokio_list_crm_activities)');
const customerId = z.number().int().positive().describe('The id of the company, contact or lead named by customer_type');
const PERIODS = ['planned', 'overdue', 'today', 'tomorrow', 'this_week', 'next_week', 'done'];
/** Who acts and what gates it. */
const ACTS = ' Acts as the key\'s person (its acts-as employee, else its issuer) with their own permissions: clients.view for every activity route (403 without), ' +
    'and a lead\'s activities need them to work leads (leads.view).' +
    CRM_NEEDS;
const WRITES_ON = ' A write the person may not make on that customer is a 403; an unreachable record is a 404.';
const BUSY = ' When the activity changed meanwhile the answer is 409 and nothing was written: read it again and retry.';
const LOCAL_TIME = ' due_on (YYYY-MM-DD) and due_time (HH:MM) are the ASSIGNEE\'s own local date and wall time, in the assignee\'s zone, not UTC.';
const ROW = 'An activity row is {id, url, kind: todo|calendar, type {id, name}, subject, due_on, due_time, all_day, overdue, assignee {employee_code, name} | null ' +
    '(employee_code is null for a person with no code), priority, done_at (UTC), cancelled_at, outcome, can_complete, contact, contacts, company, lead}.';
const WRAPPED = ' Customer-linked text (the subject, notes, outcome, location, video link and the names of the contacts and company) comes back inside <untrusted_customer_content>.';
const priority = z.enum(['low', 'normal', 'high']);
/** The fields a create and an edit share (everything optional here; the create adds its two required ones). */
const sharedFields = {
    subject: z.string().max(190).nullable().optional().describe('Plain text, one line. Empty: the type\'s name'),
    notes: z.string().max(5000).nullable().optional().describe('Plain text, line breaks kept'),
    due_time: z
        .string()
        .regex(/^\d{2}:\d{2}$/, 'due_time must be HH:MM')
        .nullable()
        .optional()
        .describe('HH:MM, the assignee\'s own wall time. A timed calendar activity needs one (or all_day)'),
    all_day: z.boolean().optional().describe('Calendar activities only'),
    duration_minutes: z.number().int().min(1).nullable().optional().describe('A timed calendar activity\'s length; the server defaults 30'),
    contact_ids: z.array(z.number().int()).max(20).nullable().optional().describe('The customer\'s people it is with (max 20); the first is the primary'),
    participant_employee_codes: z.array(employeeCode).max(50).nullable().optional().describe('Calendar activities only: colleagues invited, by employee code (max 50); they are told'),
    priority: priority.nullable().optional().describe('low, normal or high; null clears'),
    location: z.string().max(255).nullable().optional().describe('Calendar activities only'),
    video_url: z.string().max(500).nullable().optional().describe('Calendar activities only; an http or https link'),
    outcome: z.string().max(500).nullable().optional().describe('What came of it, plain text, one line'),
};
export function registerCrmActivityTools(server, config) {
    registerTool(server, config, {
        name: 'clokio_list_crm_activities',
        description: 'List CRM activities, as the Activities page shows them. assignee: me (the default), all, or an employee code (a departed person\'s code still filters); ' +
            'period: planned (the default), overdue, today, tomorrow, this_week, next_week or done; filters type_id (clokio_list_crm_activity_types) and priority (none, low, normal, high). ' +
            'Paginated: {data, meta}: 25 a page, meta {page, per_page, total, last_page}; pass page to continue. ' +
            ROW + LOCAL_TIME + WRAPPED + ACTS,
        schema: {
            assignee: z.union([z.enum(['me', 'all']), employeeCode]).optional().describe('me (default), all, or an employee code'),
            period: z.enum(PERIODS).optional().describe('Default planned'),
            type_id: z.number().int().positive().optional().describe('An activity type id'),
            priority: z.enum(['none', 'low', 'normal', 'high']).optional(),
            page: z.number().int().positive().optional().describe('From 1'),
        },
        handler: async (args, cfg) => renderCrm(await request(cfg, '/crm/activities', {
            query: { assignee: args.assignee, period: args.period, type_id: args.type_id, priority: args.priority, page: args.page },
        })),
    });
    registerTool(server, config, {
        name: 'clokio_get_crm_activity',
        description: 'One CRM activity. Answers {activity}: the row fields (clokio_list_crm_activities) plus notes, duration_minutes, assignee_left, origin (crm or linked to a calendar event or to-do), ' +
            'done_by, location, video_url, participants, can {edit, delete, reassign, complete}, editable_fields and locked_hint (why a field cannot be changed). ' +
            LOCAL_TIME + WRAPPED + ACTS,
        schema: { id: activityId },
        handler: async (args, cfg) => renderCrm(await request(cfg, `/crm/activities/${seg(args.id)}`)),
    });
    registerTool(server, config, {
        name: 'clokio_list_crm_activity_types',
        description: 'The active activity types of the organisation, in order: [{id, name, kind: calendar|todo, outcome_required}]. ' +
            'type_id on create and edit takes one of these; a calendar type also writes the assignee\'s calendar event (left out while the calendar is off), a todo type their My To-Do item; ' +
            'outcome_required types need an outcome to be done. Open to anyone who works leads or may see customers.' +
            CRM_NEEDS,
        schema: {},
        handler: (_args, cfg) => request(cfg, '/crm/activity-types'),
    });
    registerTool(server, config, {
        name: 'clokio_create_crm_activity',
        description: 'Add an activity (a call, meeting or to-do) to a company, a contact or a lead. customer_type is company, contact or lead and customer_id its id. ' +
            'type_id (clokio_list_crm_activity_types) and due_on are required; assignee_employee_code defaults to the acting employee (an assignee other than them is told). ' +
            'done: true logs it as already done (an outcome-required type then needs outcome; the server answers 422 otherwise). ' +
            'Every call sends an Idempotency-Key: a fresh one (returned as idempotency_key), or the one you pass. To retry after a timeout pass the SAME idempotency_key ' +
            'and the same fields: the first answer comes back with "replayed: nothing new was created". Answers {activity, replayed}.' +
            LOCAL_TIME + WRITES_ON + WRAPPED + ACTS,
        schema: {
            customer_type: customerType,
            customer_id: customerId,
            type_id: z.number().int().positive().describe('An active activity type'),
            due_on: calendarDate('due_on').describe('YYYY-MM-DD, the assignee\'s own day'),
            ...sharedFields,
            assignee_employee_code: employeeCode.nullable().optional().describe('Default: the acting employee'),
            done: z.boolean().optional().describe('Log it as already done'),
            idempotency_key: createKey.describe('Reuse the key of an earlier call only to retry THAT call; omit for a new activity'),
        },
        mutates: true,
        handler: async (args, cfg) => {
            const key = args.idempotency_key ?? `mcp-${randomUUID()}`;
            const { customer_type, customer_id, idempotency_key: _k, ...fields } = args;
            const { res, replayed } = await idempotentPost(cfg, subjectPath(customer_type, customer_id, 'activities'), key, fields);
            const id = res?.activity?.id ?? '-';
            const outcome = replayed
                ? { replayed_note: `Activity #${id} was already created by this request (replayed: nothing new was created).` }
                : {};
            return renderCrm({ ...outcome, ...res, idempotency_key: key });
        },
    });
    registerTool(server, config, {
        name: 'clokio_update_crm_activity',
        description: 'Edit an activity: only the fields you give are sent (null clears where the field allows it). The kind (calendar or to-do) is kept; ' +
            'the activity\'s editable_fields say which fields can change (a to-do paired with someone else\'s My To-Do item can be locked). ' +
            'Reassigning is clokio_reassign_crm_activity, never this. Answers {activity}.' +
            LOCAL_TIME + WRITES_ON + BUSY + WRAPPED + ACTS,
        schema: {
            id: activityId,
            type_id: z.number().int().positive().optional().describe('An active activity type'),
            due_on: calendarDate('due_on').optional().describe('YYYY-MM-DD, the assignee\'s own day'),
            ...sharedFields,
        },
        mutates: true,
        handler: async (args, cfg) => {
            const { id, ...body } = args;
            return renderCrm(await request(cfg, `/crm/activities/${seg(id)}`, { method: 'PATCH', body }));
        },
    });
    registerTool(server, config, {
        name: 'clokio_complete_crm_activity',
        description: 'Mark an activity done, with an optional outcome (what came of it). A type that needs an outcome answers 422 without one. ' +
            'A paired My To-Do item is completed with it. Answers {activity}.' +
            WRITES_ON + BUSY + WRAPPED + ACTS,
        schema: {
            id: activityId,
            outcome: z.string().max(500).nullable().optional().describe('What came of it, plain text, one line'),
        },
        mutates: true,
        handler: async (args, cfg) => renderCrm(await request(cfg, `/crm/activities/${seg(args.id)}/done`, { method: 'POST', body: { outcome: args.outcome } })),
    });
    registerTool(server, config, {
        name: 'clokio_reopen_crm_activity',
        description: 'Reopen a done activity (no body). A paired My To-Do item is reopened with it. Answers {activity}.' + WRITES_ON + BUSY + WRAPPED + ACTS,
        schema: { id: activityId },
        mutates: true,
        handler: async (args, cfg) => renderCrm(await request(cfg, `/crm/activities/${seg(args.id)}/reopen`, { method: 'POST' })),
    });
    registerTool(server, config, {
        name: 'clokio_reassign_crm_activity',
        description: 'Give an activity to another assignee, by employee code. An unknown code is a 422 on assignee_employee_code; the new assignee must be allowed to see the customer. ' +
            'The new assignee is told. Answers {activity}.' +
            LOCAL_TIME + WRITES_ON + BUSY + WRAPPED + ACTS,
        schema: { id: activityId, assignee_employee_code: employeeCode.describe('The new assignee') },
        mutates: true,
        handler: async (args, cfg) => renderCrm(await request(cfg, `/crm/activities/${seg(args.id)}/assignee`, {
            method: 'POST',
            body: { assignee_employee_code: args.assignee_employee_code },
        })),
    });
    registerTool(server, config, {
        name: 'clokio_delete_crm_activity',
        description: 'Delete an activity, and the calendar event or My To-Do item paired with it. No undo. Only its creator or an administrator may: otherwise 403 ' +
            '"Only its creator or an administrator can delete this activity." Answers {id}.' +
            WRITES_ON + BUSY + ACTS,
        schema: { id: activityId },
        mutates: 'destructive',
        handler: async (args, cfg) => renderCrm(await request(cfg, `/crm/activities/${seg(args.id)}`, { method: 'DELETE' })),
    });
    registerTool(server, config, {
        name: 'clokio_get_crm_next_step',
        description: 'A customer\'s next step: its nearest open activity (and the open count). customer_type is company, contact or lead and customer_id its id; ' +
            'null when nothing is open. due_on and due_time in it are the assignee\'s local date and time.' +
            WRAPPED + ACTS,
        schema: { customer_type: customerType, customer_id: customerId },
        handler: async (args, cfg) => renderCrm(await request(cfg, subjectPath(args.customer_type, args.customer_id, 'next-step'))),
    });
}
