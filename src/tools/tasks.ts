import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ClokioConfig, request, requestRaw } from '../client.js';
import { registerTool } from './helpers.js';

/** See employees.ts - the same stable-identifier rule applies to task filters. */
const employeeCode = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,50}$/, 'employee_code must be 1-50 chars of letters, digits, _ or -');

/** Task-management tools: the core of the Clokio API surface. */
export function registerTaskTools(server: McpServer, config: ClokioConfig): void {
  registerTool(server, config, {
    name: 'clokio_list_tasks',
    description:
      'List tasks across projects, with server-side filters so you do not page the whole board and count in ' +
      'your own code. An UNKNOWN query parameter is a 422 naming it, so use exactly these names. Paginate ' +
      'with page, or crawl with cursor (preferred past one page). Every task carries a task_url.',
    schema: {
      project_id: z.number().int().optional(),
      status: z.string().optional().describe('Status slug, e.g. "in_progress"'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      assignee_employee_code: employeeCode.optional().describe('employee_code, e.g. "00080"'),
      label: z.string().optional(),
      search: z.string().optional().describe('Free text over title and description'),
      open: z.boolean().optional().describe('true = only tasks whose status is not a "done" one'),
      parent_task_id: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe('A task id returns only ITS subtasks; null returns only top-level tasks'),
      created_before: z.string().optional().describe('YYYY-MM-DD, organization timezone'),
      created_after: z.string().optional().describe('YYYY-MM-DD, organization timezone'),
      due_before: z.string().optional().describe('YYYY-MM-DD, organization timezone'),
      due_after: z
        .string()
        .optional()
        .describe('YYYY-MM-DD. With due_before, asks for one window ("due this week") in a single request'),
      updated_since: z
        .string()
        .optional()
        .describe('ISO-8601. Incremental sync: only tasks changed at or after this instant'),
      include_comments: z.boolean().optional(),
      per_page: z.number().int().min(1).max(100).optional(),
      page: z.number().int().optional(),
      cursor: z.string().optional().describe('meta.next_cursor from a previous page; preferred over page'),
    },
    handler: (args, cfg) =>
      request(cfg, '/tasks', {
        query: {
          project_id: args.project_id,
          status: args.status,
          priority: args.priority,
          assignee_employee_code: args.assignee_employee_code,
          label: args.label,
          search: args.search,
          open: args.open === undefined ? undefined : args.open ? 1 : 0,
          parent_task_id: args.parent_task_id === null ? '' : args.parent_task_id,
          created_before: args.created_before,
          created_after: args.created_after,
          due_before: args.due_before,
          due_after: args.due_after,
          updated_since: args.updated_since,
          include_comments: args.include_comments === undefined ? undefined : args.include_comments ? 1 : 0,
          per_page: args.per_page,
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
    description:
      'Create a task in a project. People are named by employee_code (e.g. "00080"), never internal ids. ' +
      'ALWAYS set created_by_employee_code to attribute the task to a person - without it the task shows as ' +
      'the API key owner ("External System"). Pass parent_task_id to create it as a SUBTASK of that task ' +
      '(same project, and the parent must not itself be a subtask - one level deep only).',
    schema: {
      project_id: z.number().int(),
      title: z.string().max(255),
      description: z.string().optional().describe('HTML or plain text'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      status: z.string().optional().describe("Status slug valid for THIS project's board"),
      due_date: z.string().optional().describe('YYYY-MM-DD'),
      start_date: z.string().optional().describe('YYYY-MM-DD'),
      estimated_hours: z.number().min(0).max(9999.99).optional(),
      parent_task_id: z.number().int().optional().describe('Makes this a subtask of that task'),
      assignee_employee_codes: z.array(employeeCode).max(50).optional(),
      label_names: z.array(z.string().max(100)).max(20).optional(),
      created_by_employee_code: employeeCode.optional().describe('Attribute the task to this person'),
    },
    handler: (args, cfg) =>
      request(cfg, '/tasks', {
        method: 'POST',
        body: {
          project_id: args.project_id,
          title: args.title,
          description: args.description,
          priority: args.priority,
          status: args.status,
          due_date: args.due_date,
          start_date: args.start_date,
          estimated_hours: args.estimated_hours,
          parent_task_id: args.parent_task_id,
          assignee_employee_codes: args.assignee_employee_codes,
          label_names: args.label_names,
          created_by_employee_code: args.created_by_employee_code,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_update_task',
    mutates: true,
    description:
      'Update a task. ONLY the fields you pass are changed; omitted fields are left alone. Pass null to ' +
      'due_date / start_date / estimated_hours / description to CLEAR them. Set actor_employee_code so the ' +
      'activity log names the person rather than the API key.',
    schema: {
      id: z.number().int(),
      title: z.string().max(255).optional(),
      description: z.string().nullable().optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      status: z.string().optional().describe("Status slug valid for this task's board"),
      due_date: z.string().nullable().optional().describe('YYYY-MM-DD, or null to clear'),
      start_date: z.string().nullable().optional().describe('YYYY-MM-DD, or null to clear'),
      estimated_hours: z.number().min(0).max(9999.99).nullable().optional(),
      project_id: z.number().int().optional().describe('Move the task to another project'),
      actor_employee_code: employeeCode.optional().describe('Who to credit in the activity log'),
    },
    handler: (args, cfg) => {
      // Only keys the caller actually supplied may go in the body: PATCH
      // semantics are "change what is named", and sending an untouched field
      // as null would CLEAR it.
      const body: Record<string, unknown> = {};
      for (const key of [
        'title',
        'description',
        'priority',
        'status',
        'due_date',
        'start_date',
        'estimated_hours',
        'project_id',
        'actor_employee_code',
      ] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
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
    description:
      "Change a task's assignees. mode is REQUIRED: \"add\" appends, \"replace\" overwrites the whole list, " +
      '"remove" takes those people off. People are named by employee_code (e.g. "00080").',
    schema: {
      id: z.number().int(),
      employee_codes: z.array(employeeCode).min(1).max(50),
      mode: z.enum(['add', 'replace', 'remove']).describe('Required'),
    },
    handler: (args, cfg) =>
      request(cfg, `/tasks/${args.id}/assignees`, {
        method: 'PATCH',
        body: { employee_codes: args.employee_codes, mode: args.mode },
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
    description:
      'Add a comment to a task. Set author_employee_code to attribute it to a person; otherwise it shows as ' +
      'the API key owner ("External System"). Use readable formatting (paragraphs, blank lines, bullet ' +
      'lists); markdown TABLES are not rendered and post as raw text. Write in the language of the person ' +
      'you are answering. A comment cannot be edited or deleted through this API, so get it right first time.',
    schema: {
      id: z.number().int(),
      body: z.string().max(65535),
      author_employee_code: employeeCode.optional().describe('Attribute the comment to this person'),
      notify: z.boolean().optional().describe('Send notifications to watchers (default: the API decides)'),
    },
    handler: (args, cfg) =>
      request(cfg, `/tasks/${args.id}/comments`, {
        method: 'POST',
        body: {
          body: args.body,
          author_employee_code: args.author_employee_code,
          notify: args.notify,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_update_task_comment',
    mutates: true,
    description:
      'Correct a comment YOUR integration published - a wrong number, a dead link, a mistaken finding. ' +
      'Two conditions, both required: the comment was created through this API, and author_employee_code ' +
      "names its own author. You cannot edit what a person wrote in the web or mobile app (403), and you " +
      'cannot edit someone else\'s comment (403). There is no delete: correcting leaves an audit entry, ' +
      'destroying would leave nothing.',
    schema: {
      id: z.number().int().describe('The task id'),
      comment_id: z.number().int(),
      body: z.string().max(65535),
      author_employee_code: employeeCode.describe("Required: the comment's own author"),
    },
    handler: (args, cfg) =>
      request(cfg, `/tasks/${args.id}/comments/${args.comment_id}`, {
        method: 'PATCH',
        body: { body: args.body, author_employee_code: args.author_employee_code },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_list_task_attachments',
    description:
      "A task's attachments: file name, size, mime type, who uploaded it, and the path to fetch the bytes. " +
      'A task whose real content is a screenshot or a spreadsheet reads as "(no description)" without this - ' +
      'check here before concluding a task has no detail. Use clokio_download_task_attachment for the file.',
    schema: { id: z.number().int() },
    handler: (args, cfg) => request(cfg, `/tasks/${args.id}/attachments`),
  });

  registerTool(server, config, {
    name: 'clokio_download_task_attachment',
    description:
      'Download one attachment. Returns the FILE, not JSON - text files come back as text, and binary ones ' +
      '(images, PDFs, spreadsheets) are reported with their type and size rather than dumped into the ' +
      'conversation. Get the attachment id from clokio_list_task_attachments.',
    schema: {
      id: z.number().int().describe('The task id'),
      attachment_id: z.number().int(),
    },
    handler: (args, cfg) =>
      requestRaw(cfg, `/tasks/${args.id}/attachments/${args.attachment_id}`),
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
    handler: (args, cfg) =>
      request(cfg, `/tasks/${args.id}/dependencies`, {
        method: 'POST',
        body: { depends_on_task_id: args.depends_on_task_id, type: args.type },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_remove_task_dependency',
    mutates: 'destructive',
    description:
      'Remove a dependency from a task. dependency_id is the id of the DEPENDENCY row, as returned by ' +
      'clokio_list_task_dependencies - not the id of the other task.',
    schema: {
      id: z.number().int().describe('The task that holds the dependency'),
      dependency_id: z.number().int(),
    },
    handler: (args, cfg) =>
      request(cfg, `/tasks/${args.id}/dependencies/${args.dependency_id}`, { method: 'DELETE' }),
  });

  registerTool(server, config, {
    name: 'clokio_set_task_custom_field',
    mutates: true,
    description:
      'Set one custom field value on a task, identified by field_key (never field_id). An API key sees ' +
      'PUBLIC fields only.',
    schema: {
      id: z.number().int(),
      field_key: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
    },
    handler: (args, cfg) =>
      request(cfg, `/tasks/${args.id}/custom-fields`, {
        method: 'PATCH',
        body: { field_key: args.field_key, value: args.value },
      }),
  });
}
