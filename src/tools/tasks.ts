import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { markdownToHtml } from '../markdown.js';
import { ClokioConfig, request, requestUpload } from '../client.js';
import { registerTool } from './helpers.js';
import {
  asAttachmentArray,
  downloadAttachment,
  safeAttachmentName,
  stampIsLatest,
  type SavedFile,
} from '../attachments.js';

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
      'with page, or crawl with cursor (preferred past one page). Every task carries a task_url.\n\n' +
      'The response is {data, meta}. meta carries total, per_page, current_page and next_cursor - read '  +
      'next_cursor and pass it back as `cursor` for the following page; it is null on the last one.',
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
      compact: z
        .boolean()
        .optional()
        .describe(
          'STRONGLY PREFERRED when scanning. Returns a slim row - id, title, status, priority, ' +
            'due_date, parent_id, project_id, assignee_codes (employee_code strings), labels (names) ' +
            'and updated_at - dropping the HTML description and flattening the nested project/assignee ' +
            'objects to ids. Resolve a project_id with clokio_list_projects, and fetch the one task you ' +
            'actually need in full with clokio_get_task (its URL is /tasks/{id}/view).'
        ),
      sort: z
        .enum([
          'due_date',
          'due_date_desc',
          'created_at',
          'created_at_desc',
          'updated_at',
          'updated_at_desc',
          'title',
          'title_desc',
          'priority',
          'priority_desc',
        ])
        .optional()
        .describe(
          'Order the page. `priority` ascends low -> urgent. CANNOT be combined with cursor or ' +
            'updated_since - that is a 422, because re-ordering a crawl silently skips rows.'
        ),
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
          sort: args.sort,
          compact: args.compact === undefined ? undefined : args.compact ? 1 : 0,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_get_task',
    description:
      'Get one task by id, with its full detail (assignees, labels, status, custom fields, task_url) and ' +
      'its comments. A long-running task can carry dozens of comments: pass comments_limit to keep only the ' +
      'newest few, or 0 for none. comments_count always reports the real total.',
    schema: {
      id: z.number().int(),
      comments_limit: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe('Newest N comments only (0 = none). Omitted returns every comment'),
    },
    handler: (args, cfg) =>
      request(cfg, `/tasks/${args.id}`, { query: { comments_limit: args.comments_limit } }),
  });

  registerTool(server, config, {
    name: 'clokio_create_task',
    mutates: true,
    description:
      'Create a task in a project. People are named by employee_code (e.g. "00080"), never internal ids. ' +
      'You do NOT normally need created_by_employee_code: an unnamed task is attributed to the key\'s issuer ' +
      'automatically (whoami shows who that is). Set it only to credit someone OTHER than the key owner. ' +
      'Pass parent_task_id to create it as a SUBTASK of that task ' +
      '(same project, and the parent must not itself be a subtask - one level deep only).',
    schema: {
      project_id: z.number().int(),
      title: z.string().max(255),
      description: z.string().optional().describe('Markdown, HTML or plain text (Markdown is converted to HTML)'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      status: z.string().optional().describe("Status slug valid for THIS project's board"),
      due_date: z.string().optional().describe('YYYY-MM-DD'),
      start_date: z.string().optional().describe('YYYY-MM-DD'),
      estimated_hours: z.number().min(0).max(9999.99).optional(),
      parent_task_id: z.number().int().optional().describe('Makes this a subtask of that task'),
      assignee_employee_codes: z.array(employeeCode).max(50).optional(),
      label_names: z
        .array(z.string().max(100))
        .max(20)
        .optional()
        .describe('Label names. A name that does not exist yet is CREATED - check clokio_list_task_labels first'),
      created_by_employee_code: employeeCode.optional().describe('Credit someone OTHER than the key owner; omit to use the key issuer / CLOKIO_DEFAULT_ACTOR'),
    },
    handler: (args, cfg) =>
      request(cfg, '/tasks', {
        method: 'POST',
        body: {
          project_id: args.project_id,
          title: args.title,
          description: args.description === undefined ? undefined : markdownToHtml(args.description),
          priority: args.priority,
          status: args.status,
          due_date: args.due_date,
          start_date: args.start_date,
          estimated_hours: args.estimated_hours,
          parent_task_id: args.parent_task_id,
          assignee_employee_codes: args.assignee_employee_codes,
          label_names: args.label_names,
          created_by_employee_code: args.created_by_employee_code ?? cfg.defaultActor,
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
      actor_employee_code: employeeCode.optional().describe('Who to credit in the activity log; omit to use the key issuer / CLOKIO_DEFAULT_ACTOR'),
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
      if (typeof body.description === 'string') body.description = markdownToHtml(body.description);
      // Credit the update to CLOKIO_DEFAULT_ACTOR when the caller named no
      // actor. The API otherwise falls back to the key's issuer on its own,
      // so this only overrides for a shared/service key. An explicit
      // actor_employee_code above already sits in body and is left untouched.
      if (body.actor_employee_code === undefined && cfg.defaultActor) {
        body.actor_employee_code = cfg.defaultActor;
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
      'Add a comment to a task. author_employee_code is usually unnecessary: an unnamed comment is attributed ' +
      'to the key issuer automatically. Set it only to credit someone else. Use readable formatting ' +
      '(paragraphs, blank lines, bullet lists, **bold**, `code`); Markdown is converted to HTML, but TABLES are not rendered and post as raw text. Write ' +
      'in the language of the person you are answering. ' +
      'TO MENTION SOMEONE, write @ followed by their full name exactly as clokio_list_employees spells it ' +
      '(for example "@Kiran Bahadur") in the body text - no markup needed. It becomes a real mention and ' +
      'notifies them, but only if the comment has an author (its own field, the key issuer, or ' +
      'CLOKIO_DEFAULT_ACTOR); a truly authorless comment notifies nobody. A name that matches no one stays ' +
      'as plain text, so check the spelling first.',
    schema: {
      id: z.number().int(),
      body: z.string().max(65535),
      author_employee_code: employeeCode.optional().describe('Credit someone OTHER than the key owner; omit to use the key issuer / CLOKIO_DEFAULT_ACTOR'),
      notify: z.boolean().optional().describe('Send notifications to watchers (default: the API decides)'),
    },
    handler: (args, cfg) =>
      request(cfg, `/tasks/${args.id}/comments`, {
        method: 'POST',
        body: {
          body: markdownToHtml(args.body),
          author_employee_code: args.author_employee_code ?? cfg.defaultActor,
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
        body: { body: markdownToHtml(args.body), author_employee_code: args.author_employee_code ?? cfg.defaultActor },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_list_task_attachments',
    description:
      "A task's attachments: file name, size, mime type, who uploaded it, and the path to fetch the bytes. " +
      'A task whose real content is a screenshot or a spreadsheet reads as "(no description)" without this - ' +
      'check here before concluding a task has no detail. Each row carries is_latest: whether it is the newest ' +
      'upload with the same file name (the same name can be uploaded more than once; nothing else marks which ' +
      'is current). Pass latest_only: true to drop superseded duplicates. Use clokio_download_task_attachment ' +
      'for one file, or clokio_download_task_attachments to save them all at once.',
    schema: {
      id: z.number().int(),
      latest_only: z
        .boolean()
        .optional()
        .describe('Return only the newest upload of each file name, dropping superseded duplicates'),
    },
    handler: async (args, cfg) => {
      const raw = await request(cfg, `/tasks/${args.id}/attachments`);
      const rows = asAttachmentArray(raw);
      if (!rows) return raw; // unexpected shape - hand it back rather than hide it
      const stamped = stampIsLatest(rows);
      return args.latest_only ? stamped.filter((r) => r.is_latest) : stamped;
    },
  });

  registerTool(server, config, {
    name: 'clokio_download_task_attachment',
    description:
      'Download one attachment. With save_path, writes the file to disk (creating missing folders, refusing to ' +
      'overwrite unless overwrite: true) and returns {saved_to, sha256, mime_type, file_size}. Without ' +
      'save_path it returns the content in the most usable form: text files as text; a PDF as its extracted ' +
      'text plus page count; a ZIP as its entry list; an image as an image you can see; anything else as a ' +
      'type-and-size description. Large text/PDF is truncated with a note (use save_path for the whole file). ' +
      'Get the attachment id and file_name from clokio_list_task_attachments - file_name drives type detection.',
    schema: {
      id: z.number().int().describe('The task id'),
      attachment_id: z.number().int(),
      file_name: z
        .string()
        .optional()
        .describe('The file_name from clokio_list_task_attachments. Drives type detection (text/PDF/zip/image)'),
      save_path: z
        .string()
        .optional()
        .describe('Write the file here instead of returning its content; parent folders are created'),
      overwrite: z
        .boolean()
        .optional()
        .describe('Allow save_path to replace an existing file (default false)'),
    },
    handler: (args, cfg) =>
      downloadAttachment(cfg, args.id, args.attachment_id, {
        fileName: args.file_name,
        savePath: args.save_path,
        overwrite: args.overwrite,
      }),
  });

  registerTool(server, config, {
    name: 'clokio_download_task_attachments',
    description:
      "Save ALL of a task's attachments to a folder in one call. Creates save_dir if missing, writes each file " +
      'under its own name, and returns the list of saved paths with sizes and sha256. Pass latest_only: true to ' +
      'skip superseded duplicates (older uploads of a name that was uploaded again). A file name that appears ' +
      'more than once is disambiguated with a numeric suffix so nothing is clobbered.',
    schema: {
      id: z.number().int().describe('The task id'),
      save_dir: z.string().describe('Directory to write the files into; created if missing'),
      latest_only: z
        .boolean()
        .optional()
        .describe('Save only the newest upload of each file name'),
      overwrite: z
        .boolean()
        .optional()
        .describe('Allow replacing existing files in save_dir (default false)'),
    },
    handler: async (args, cfg) => {
      const { join } = await import('node:path');
      const rows = asAttachmentArray(await request(cfg, `/tasks/${args.id}/attachments`));
      if (!rows) {
        return { error: 'The attachments endpoint did not return a list.' };
      }
      const stamped = stampIsLatest(rows);
      const selected = args.latest_only ? stamped.filter((r) => r.is_latest) : stamped;

      const saved: SavedFile[] = [];
      const failed: Array<{ attachment_id: number; file_name?: string; error: string }> = [];
      const usedNames = new Set<string>();

      for (const row of selected) {
        // file_name is API-supplied and UNTRUSTED on the write path;
        // safeAttachmentName strips any directory part so it stays in save_dir.
        const original = safeAttachmentName(row.file_name as string | undefined, row.id);
        let name = original;
        let counter = 2;
        while (usedNames.has(name)) {
          const dot = original.lastIndexOf('.');
          name =
            dot > 0
              ? `${original.slice(0, dot)} (${counter})${original.slice(dot)}`
              : `${original} (${counter})`;
          counter++;
        }
        usedNames.add(name);

        try {
          const result = (await downloadAttachment(cfg, args.id, row.id, {
            fileName: row.file_name,
            savePath: join(args.save_dir, name),
            overwrite: args.overwrite,
          })) as SavedFile;
          saved.push(result);
        } catch (e) {
          failed.push({
            attachment_id: row.id,
            file_name: row.file_name,
            error: (e as Error).message,
          });
        }
      }

      return { saved_count: saved.length, saved, ...(failed.length ? { failed } : {}) };
    },
  });

  registerTool(server, config, {
    name: 'clokio_upload_task_attachment',
    mutates: true,
    description:
      'Upload a LOCAL FILE to a task as an attachment - a screenshot, a log, a spreadsheet. Give the path to ' +
      'a file on this machine; it is read and sent. Allowed types include images, PDF, Office docs, txt/csv/' +
      'md/json, code diffs, zip and video, up to 200 MB. The uploader is the key issuer unless you set ' +
      'uploaded_by_employee_code.',
    schema: {
      id: z.number().int().describe('The task id'),
      file_path: z.string().describe('Path to a file on THIS machine'),
      uploaded_by_employee_code: employeeCode
        .optional()
        .describe('Credit someone other than the key owner; omit to use the key issuer'),
    },
    handler: (args, cfg) =>
      requestUpload(cfg, `/tasks/${args.id}/attachments`, args.file_path, {
        uploaded_by_employee_code: args.uploaded_by_employee_code ?? cfg.defaultActor,
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

  registerTool(server, config, {
    name: 'clokio_bulk_update_tasks',
    mutates: true,
    description:
      'Apply ONE change (any of status, priority, due_date) to up to 200 tasks at once - for cleaning up a ' +
      'board without a call per task. Partial success is normal: the result is {updated, not_found, ' +
      'invalid_status}. not_found lists ids that do not exist in your org (skipped, not fatal); ' +
      'invalid_status lists tasks whose board does not have the given status slug. Give at least one of ' +
      'status/priority/due_date. Attribution follows the key issuer unless actor_employee_code is set.',
    schema: {
      ids: z.array(z.number().int()).min(1).max(200),
      status: z.string().optional().describe('Status slug - validated per task against its own board'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      due_date: z.string().nullable().optional().describe('YYYY-MM-DD, or null to clear'),
      actor_employee_code: employeeCode.optional().describe('Who to credit; omit to use the key issuer'),
    },
    handler: (args, cfg) => {
      const body: Record<string, unknown> = { ids: args.ids };
      if (args.status !== undefined) body.status = args.status;
      if (args.priority !== undefined) body.priority = args.priority;
      if (args.due_date !== undefined) body.due_date = args.due_date;
      body.actor_employee_code = args.actor_employee_code ?? cfg.defaultActor;
      return request(cfg, '/tasks/bulk', { method: 'PATCH', body });
    },
  });
}
