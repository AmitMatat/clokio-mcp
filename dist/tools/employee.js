import { z } from 'zod';
import { markdownToHtml } from '../markdown.js';
import { request, requestUpload, seg } from '../client.js';
import { downloadAttachment } from '../attachments.js';
import { registerTool } from './helpers.js';
/**
 * Employee mode: the tools a personal X-Employee-Key can use, acting AS that
 * person. The server judges every call against the employee's own roles and
 * project permissions, so nothing here takes an employee_code to credit a
 * writer - the key is the identity, and a 403 means "you may not do that in
 * this project", verbatim from Clokio.
 *
 * Same tool names as admin mode where the contract is a subset of it (the
 * model's habits carry over); the admin-only tools simply do not exist here.
 * The docs tools are the admin ones unchanged: that surface is identical for
 * both keys, only the identity differs.
 */
export function registerEmployeeModeTools(server, config) {
    const ACTS = 'Acting as the key\'s employee, with their own permissions.';
    registerTool(server, config, {
        name: 'clokio_whoami',
        description: 'Who this employee key acts as: the person (employee_code, name, role, position, department), their ' +
            'organisation, and the key\'s name and expiry. Every write this session makes carries that name. ' +
            'CALL THIS FIRST in a session.',
        schema: {},
        handler: (_args, cfg) => request(cfg, '/me'),
    });
    registerTool(server, config, {
        name: 'clokio_list_projects',
        description: `Projects this person can create tasks in, with ids. ${ACTS}`,
        schema: {},
        handler: (_args, cfg) => request(cfg, '/projects'),
    });
    registerTool(server, config, {
        name: 'clokio_list_tasks',
        description: 'Tasks ASSIGNED to this person (their queue), open ones by default. Filter by status slug, ' +
            'updated_since (ISO-8601, incremental sync) or include_done. limit 1-100. ' +
            'Tasks they are not assigned to are not listed here; open one directly with clokio_get_task if they can see it.',
        schema: {
            status: z.string().max(60).optional().describe('Status slug, e.g. "in_progress"'),
            updated_since: z.string().optional().describe('ISO-8601: only tasks changed at or after this instant'),
            include_done: z.boolean().optional().describe('Include completed tasks (default false)'),
            limit: z.number().int().min(1).max(100).optional(),
        },
        handler: (args, cfg) => request(cfg, '/tasks', { query: args }),
    });
    registerTool(server, config, {
        name: 'clokio_get_task',
        description: `One task in full: description, subtasks, assignees, the newest 50 comments, attachments. ${ACTS}`,
        schema: { id: z.number().int() },
        handler: (args, cfg) => request(cfg, `/tasks/${seg(args.id)}`),
    });
    const taskFields = {
        description: z.string().optional().describe('Markdown, HTML or plain text (Markdown is converted to HTML)'),
        status: z.string().max(60).optional().describe("Status slug valid for THIS project's board"),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
        due_date: z.string().optional().describe('YYYY-MM-DD'),
        start_date: z.string().optional().describe('YYYY-MM-DD'),
        estimated_hours: z.number().min(0).max(9999.99).optional(),
    };
    registerTool(server, config, {
        name: 'clokio_create_task',
        mutates: true,
        description: `Create a task in a project the person may create in (clokio_list_projects); it is created BY them and they watch it. ${ACTS} ` +
            'Mention someone in the description as plain text "@Full Name".',
        schema: { project_id: z.number().int(), title: z.string().min(1).max(255), ...taskFields },
        handler: (args, cfg) => request(cfg, '/tasks', {
            method: 'POST',
            body: strip({ ...args, description: args.description === undefined ? undefined : markdownToHtml(args.description) }),
        }),
    });
    registerTool(server, config, {
        name: 'clokio_update_task',
        mutates: true,
        description: `Change title, description, status, priority, dates or estimate on a task the person may edit. Only the fields you pass change. ${ACTS}`,
        schema: { id: z.number().int(), title: z.string().min(1).max(255).optional(), ...taskFields },
        handler: (args, cfg) => {
            const { id, ...rest } = args;
            const body = strip({ ...rest, description: rest.description === undefined ? undefined : markdownToHtml(rest.description) });
            return request(cfg, `/tasks/${seg(id)}`, { method: 'PATCH', body });
        },
    });
    registerTool(server, config, {
        name: 'clokio_add_task_comment',
        mutates: true,
        description: `Comment on a task the person may comment on, as them. ${ACTS} Markdown is converted to HTML. ` +
            'TO MENTION SOMEONE, write @ followed by their full name as Clokio spells it; it becomes a real mention and notifies them.',
        schema: { id: z.number().int(), body: z.string().min(1).max(65535) },
        handler: (args, cfg) => request(cfg, `/tasks/${seg(args.id)}/comments`, { method: 'POST', body: { body: markdownToHtml(args.body) } }),
    });
    registerTool(server, config, {
        name: 'clokio_upload_task_attachment',
        mutates: true,
        description: `Upload a LOCAL FILE to a task as an attachment, uploaded by the person. ${ACTS}`,
        schema: { id: z.number().int(), file_path: z.string().describe('Path to a file on THIS machine') },
        handler: (args, cfg) => requestUpload(cfg, `/tasks/${seg(args.id)}/attachments`, args.file_path),
    });
    registerTool(server, config, {
        name: 'clokio_download_task_attachment',
        description: 'Download one attachment of a task the person can see. With save_path, writes it to disk; otherwise text, ' +
            'PDF text, ZIP entries or an image come back inline. Attachment ids are in clokio_get_task.',
        schema: {
            id: z.number().int().describe('The task id'),
            attachment_id: z.number().int(),
            file_name: z.string().optional().describe('Drives type detection (text/PDF/zip/image)'),
            save_path: z.string().optional(),
            overwrite: z.boolean().optional(),
        },
        handler: (args, cfg) => downloadAttachment(cfg, args.id, args.attachment_id, {
            fileName: args.file_name,
            savePath: args.save_path,
            overwrite: args.overwrite,
        }),
    });
    registerTool(server, config, {
        name: 'clokio_log_time',
        mutates: true,
        description: `Record a work session of the person on a task (a timer entry between two instants). ${ACTS}`,
        schema: {
            id: z.number().int(),
            started_at: z.string().describe('ISO-8601 with offset'),
            ended_at: z.string().describe('ISO-8601 with offset, after started_at'),
            description: z.string().max(255).optional(),
        },
        handler: (args, cfg) => {
            const { id, ...body } = args;
            return request(cfg, `/tasks/${seg(id)}/time`, { method: 'POST', body: strip(body) });
        },
    });
}
/** Drop undefined entries so a PATCH changes only what was named. */
function strip(o) {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
