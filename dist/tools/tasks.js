import { z } from 'zod';
import { request } from '../client.js';
import { registerTool } from './helpers.js';
/** Task-management tools: the core of the Clokio API surface. */
export function registerTaskTools(server, config) {
    registerTool(server, config, {
        name: 'clokio_list_tasks',
        description: 'List tasks. Supports filters: project_id, status (slug), priority, assignee (employee_code), ' +
            'label, search, open (1 = only open tasks), created_before / due_before (YYYY-MM-DD, org timezone). ' +
            'Paginate with page, or crawl with cursor. Each task carries a task_url.',
        schema: {
            project_id: z.number().int().optional(),
            status: z.string().optional().describe('Status slug, e.g. "in_progress"'),
            priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
            assignee: z.string().optional().describe('employee_code, e.g. "00080"'),
            label: z.string().optional(),
            search: z.string().optional(),
            open: z.boolean().optional().describe('true = only tasks whose status is not "done"'),
            created_before: z.string().optional().describe('YYYY-MM-DD'),
            due_before: z.string().optional().describe('YYYY-MM-DD'),
            page: z.number().int().optional(),
            cursor: z.string().optional(),
        },
        handler: (args, cfg) => request(cfg, '/tasks', {
            query: {
                project_id: args.project_id,
                status: args.status,
                priority: args.priority,
                assignee: args.assignee,
                label: args.label,
                search: args.search,
                open: args.open ? 1 : undefined,
                created_before: args.created_before,
                due_before: args.due_before,
                page: args.page,
                cursor: args.cursor,
            },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_get_task',
        description: 'Get one task by id, with its full detail (assignees, labels, status, custom fields, task_url).',
        schema: { id: z.number().int() },
        handler: (args, cfg) => request(cfg, `/tasks/${args.id}`),
    });
    registerTool(server, config, {
        name: 'clokio_create_task',
        mutates: true,
        description: 'Create a task in a project. assignees/creator use employee_code (e.g. "00080"), not internal ids. ' +
            'To attribute the task to a person set creator_employee_code, otherwise it shows as the API key owner.',
        schema: {
            project_id: z.number().int(),
            title: z.string(),
            description: z.string().optional().describe('HTML or plain text'),
            priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
            status: z.string().optional().describe('Status slug'),
            due_date: z.string().optional().describe('YYYY-MM-DD'),
            assignee_employee_codes: z.array(z.string()).optional(),
            label_names: z.array(z.string()).optional(),
            creator_employee_code: z.string().optional(),
        },
        handler: (args, cfg) => request(cfg, '/tasks', {
            method: 'POST',
            body: {
                project_id: args.project_id,
                title: args.title,
                description: args.description,
                priority: args.priority,
                status: args.status,
                due_date: args.due_date,
                assignees: args.assignee_employee_codes,
                labels: args.label_names,
                created_by_employee_code: args.creator_employee_code,
            },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_update_task',
        mutates: true,
        description: 'Update a task. Only the fields you pass are changed. status/priority/title/description/due_date are supported.',
        schema: {
            id: z.number().int(),
            title: z.string().optional(),
            description: z.string().optional(),
            priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
            status: z.string().optional().describe('Status slug'),
            due_date: z.string().optional().describe('YYYY-MM-DD, or empty string to clear'),
        },
        handler: (args, cfg) => {
            const body = {};
            if (args.title !== undefined)
                body.title = args.title;
            if (args.description !== undefined)
                body.description = args.description;
            if (args.priority !== undefined)
                body.priority = args.priority;
            if (args.status !== undefined)
                body.status = args.status;
            if (args.due_date !== undefined)
                body.due_date = args.due_date;
            return request(cfg, `/tasks/${args.id}`, { method: 'PATCH', body });
        },
    });
    registerTool(server, config, {
        name: 'clokio_delete_task',
        mutates: 'destructive',
        description: 'Delete a task by id. This is irreversible.',
        schema: { id: z.number().int() },
        handler: (args, cfg) => request(cfg, `/tasks/${args.id}`, { method: 'DELETE' }),
    });
    registerTool(server, config, {
        name: 'clokio_set_task_assignees',
        mutates: true,
        description: 'Set a task\'s assignees. mode "add" appends, "replace" overwrites, "remove" removes. ' +
            'Assignees are employee_codes (e.g. "00080").',
        schema: {
            id: z.number().int(),
            employee_codes: z.array(z.string()),
            mode: z.enum(['add', 'replace', 'remove']).optional().describe('default: add'),
        },
        handler: (args, cfg) => request(cfg, `/tasks/${args.id}/assignees`, {
            method: 'PATCH',
            body: { assignees: args.employee_codes, mode: args.mode ?? 'add' },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_list_task_comments',
        description: 'List the comments on a task.',
        schema: { id: z.number().int() },
        handler: (args, cfg) => request(cfg, `/tasks/${args.id}/comments`),
    });
    registerTool(server, config, {
        name: 'clokio_add_task_comment',
        mutates: true,
        description: 'Add a comment to a task. Set author_employee_code to attribute it to a person; otherwise it shows as ' +
            'the API key owner ("External System"). Use readable formatting (paragraphs, bullet lists); markdown ' +
            'tables are not rendered.',
        schema: {
            id: z.number().int(),
            body: z.string(),
            author_employee_code: z.string().optional(),
        },
        handler: (args, cfg) => request(cfg, `/tasks/${args.id}/comments`, {
            method: 'POST',
            body: { body: args.body, author_employee_code: args.author_employee_code },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_get_task_activity',
        description: 'Get the activity log (audit trail) for a task.',
        schema: { id: z.number().int() },
        handler: (args, cfg) => request(cfg, `/tasks/${args.id}/activity`),
    });
    registerTool(server, config, {
        name: 'clokio_list_task_dependencies',
        description: 'List a task\'s dependencies (blocks / waiting-on).',
        schema: { id: z.number().int() },
        handler: (args, cfg) => request(cfg, `/tasks/${args.id}/dependencies`),
    });
    registerTool(server, config, {
        name: 'clokio_add_task_dependency',
        mutates: true,
        description: 'Add a dependency between two tasks. Circular dependencies are rejected by the API.',
        schema: {
            id: z.number().int().describe('The task that depends'),
            depends_on_task_id: z.number().int(),
            type: z.enum(['blocks', 'waiting_on']).optional(),
        },
        handler: (args, cfg) => request(cfg, `/tasks/${args.id}/dependencies`, {
            method: 'POST',
            body: { depends_on_task_id: args.depends_on_task_id, type: args.type },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_set_task_custom_field',
        mutates: true,
        description: 'Set one custom field value on a task, identified by field_key (never field_id). An API key sees ' +
            'PUBLIC fields only.',
        schema: {
            id: z.number().int(),
            field_key: z.string(),
            value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
        },
        handler: (args, cfg) => request(cfg, `/tasks/${args.id}/custom-fields`, {
            method: 'PATCH',
            body: { field_key: args.field_key, value: args.value },
        }),
    });
}
