import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { markdownToHtml } from '../markdown.js';
import { ClokioConfig, request, requestUpload, seg } from '../client.js';
import { VERSION } from '../version.js';
import { ESTIMATED_HOURS_MAX } from './tasks.js';
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
/**
 * Always registered in employee mode, whatever CLOKIO_TOOLSETS names, like the
 * admin `projects` group: a session is told to call clokio_whoami first, and
 * without it a docs-only session could not learn who it acts as or which
 * build it runs (review of PR #2, 2026-10-26).
 */
export function registerEmployeeIdentityTools(server: McpServer, config: ClokioConfig): void {
  registerTool(server, config, {
    name: 'clokio_whoami',
    description:
      'Who this employee key acts as: the person (employee_code, name, role, position, department), their ' +
      'organisation, and the key\'s name and expiry. Every write this session makes carries that name. ' +
      'Also `mcp_version`, the running clokio-mcp build: if it is older than the current release, start a NEW session. ' +
      'CALL THIS FIRST in a session.',
    schema: {},
    // mcp_version is added client-side, as the admin whoami does: `npx -y
    // clokio-mcp` can serve a cached old build, and only the running package
    // knows which one it is.
    handler: async (_args, cfg) => ({ ...((await request(cfg, '/me')) as Record<string, unknown>), mcp_version: VERSION }),
  });

  registerTool(server, config, {
    name: 'clokio_list_projects',
    description: 'Projects this person can create tasks in, with ids. Acting as the key\'s employee, with their own permissions.',
    schema: {},
    handler: (_args, cfg) => request(cfg, '/projects'),
  });
}

export function registerEmployeeModeTools(server: McpServer, config: ClokioConfig): void {
  const ACTS = 'Acting as the key\'s employee, with their own permissions.';

  registerTool(server, config, {
    name: 'clokio_list_tasks',
    description:
      'Tasks ASSIGNED to this person (their queue), open ones by default. Filter by status slug, ' +
      'updated_since (ISO-8601, incremental sync) or include_done. limit 1-100. ' +
      'Tasks they are not assigned to are not listed here; open one directly with clokio_get_task if they can see it.',
    schema: {
      status: z.string().max(60).optional().describe('Status slug, e.g. "in_progress"'),
      updated_since: z.string().optional().describe('ISO-8601: only tasks changed at or after this instant'),
      include_done: z.boolean().optional().describe('Include completed tasks (default false)'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    // include_done as 1/0: the server's `boolean` rule refuses the strings
    // "true"/"false" a query would otherwise carry (a 422 on every call).
    handler: (args, cfg) =>
      request(cfg, '/tasks', {
        query: { ...args, include_done: args.include_done === undefined ? undefined : args.include_done ? 1 : 0 },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_get_task',
    description: `One task in full: description, subtasks, assignees, the newest 50 comments, attachments. ${ACTS}`,
    schema: { id: z.number().int() },
    handler: (args, cfg) => request(cfg, `/tasks/${seg(args.id)}`),
  });

  // description, dates and estimate take null to CLEAR them, as the server
  // allows (`nullable`) and as the admin update_task does.
  const taskFields = {
    description: z.string().nullable().optional().describe('Markdown, HTML or plain text (Markdown is converted to HTML); null clears it'),
    status: z.string().max(60).optional().describe("Status slug valid for THIS project's board"),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    due_date: z.string().nullable().optional().describe('YYYY-MM-DD, or null to clear'),
    start_date: z.string().nullable().optional().describe('YYYY-MM-DD, or null to clear'),
    estimated_hours: z.number().min(0).max(ESTIMATED_HOURS_MAX).nullable().optional().describe('null clears it'),
  };

  registerTool(server, config, {
    name: 'clokio_create_task',
    mutates: true,
    description:
      `Create a task in a project the person may create in (clokio_list_projects); it is created BY them and they watch it. ${ACTS} ` +
      'Mention someone in the description as plain text "@Full Name".',
    schema: { project_id: z.number().int(), title: z.string().min(1).max(255), ...taskFields },
    handler: (args, cfg) =>
      request(cfg, '/tasks', {
        method: 'POST',
        body: strip({ ...args, description: htmlField(args.description, 'description', false) }),
      }),
  });

  registerTool(server, config, {
    name: 'clokio_update_task',
    mutates: true,
    description: `Change title, description, status, priority, dates or estimate on a task the person may edit. Only the fields you pass change. ${ACTS}`,
    schema: { id: z.number().int(), title: z.string().min(1).max(255).optional(), ...taskFields },
    handler: (args, cfg) => {
      const { id, ...rest } = args;
      const body = strip({ ...rest, description: htmlField(rest.description, 'description', false) });
      return request(cfg, `/tasks/${seg(id)}`, { method: 'PATCH', body });
    },
  });

  registerTool(server, config, {
    name: 'clokio_add_task_comment',
    mutates: true,
    description:
      `Comment on a task the person may comment on, as them. ${ACTS} Markdown is converted to HTML. ` +
      'TO MENTION SOMEONE, write @ followed by their full name as Clokio spells it; it becomes a real mention and notifies them.',
    schema: { id: z.number().int(), body: z.string().min(1).max(65535) },
    handler: (args, cfg) =>
      request(cfg, `/tasks/${seg(args.id)}/comments`, { method: 'POST', body: { body: htmlField(args.body, 'body', true) } }),
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
    description:
      'Download one attachment of a task the person can see. With save_path, writes it to disk; otherwise text, ' +
      'PDF text, ZIP entries or an image come back inline. Attachment ids are in clokio_get_task.',
    schema: {
      id: z.number().int().describe('The task id'),
      attachment_id: z.number().int(),
      file_name: z.string().optional().describe('Drives type detection (text/PDF/zip/image)'),
      save_path: z.string().optional(),
      overwrite: z.boolean().optional(),
    },
    handler: (args, cfg) =>
      downloadAttachment(cfg, args.id, args.attachment_id, {
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

/** The server's cap on a description or a comment body, measured AFTER the Markdown conversion. */
const HTML_MAX = 65535;

/**
 * Markdown to the HTML Clokio stores, checked the way the server will check
 * it: the conversion can turn whitespace into '' and grow long Markdown past
 * the cap, so the limits are judged on the result, with a sentence the model
 * can act on instead of the server's bare 422 (review of PR #2). undefined
 * stays undefined (not sent) and null stays null (clears the field).
 */
function htmlField(value: string | null | undefined, field: string, required: boolean): string | null | undefined {
  if (value === undefined || value === null) return value;
  const html = markdownToHtml(value);
  if (html.trim() === '' && (required || value.trim() !== '')) {
    throw new Error(`The ${field} is empty once converted to HTML. Write some text, or ${required ? 'leave the comment out' : 'pass null to clear it'}.`);
  }
  if (html.length > HTML_MAX) {
    throw new Error(`The ${field} is ${html.length} characters once converted to HTML; the limit is ${HTML_MAX}. Shorten it.`);
  }
  return html;
}

/** Drop undefined entries so a PATCH changes only what was named. */
function strip<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
