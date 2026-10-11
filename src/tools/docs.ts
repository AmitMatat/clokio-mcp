import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { markdownToHtml } from '../markdown.js';
import { ClokioApiError, ClokioConfig, request, requestUpload, seg } from '../client.js';
import { downloadDocAttachment } from '../attachments.js';
import { registerTool } from './helpers.js';

/**
 * The Docs module, on the Public API (/api/v1/docs...) with CLOKIO_API_KEY.
 *
 * Documents are permissioned per PERSON, so every docs request acts as one
 * employee - the key's EFFECTIVE actor (backend ActsAsAuthority): its
 * "acts as" employee, else the key's creator, the latter only when the key
 * lists docs:read / docs:write EXPLICITLY ("*" is not enough for a key with
 * no actor). The API decides everything else: an invisible document is 404,
 * a visible one the actor may not change is 403.
 *
 * TOKEN BUDGET. tools/list is paid by every session, so the access rules are
 * spelled out ONCE, on clokio_list_docs, and every other description points
 * there ("Docs access: see clokio_list_docs"). Each description says only
 * what the model needs to call the tool correctly: what it does, the doc
 * role it needs, and any trap (base_version, the 30-day share link default).
 *
 * RESPONSE SHAPE. The API answers with named keys (`docs`, `doc`, `comment`,
 * `comments`, ...). These tools reshape that into the envelope the task tools
 * return - `{data}` or `{data, meta}` - so a model reads every Clokio tool the
 * same way: the record or rows in `data`, paging / permissions / counts in
 * `meta`. See shape*() below.
 */

/**
 * Per-tool access tag: the SECTION permission the acting employee's role
 * must hold (the backend's sectionGate() per route), on top of the doc role
 * each description names ("needs edit", "needs admin"). The full rule lives
 * once, on clokio_list_docs. Verified against
 * app/Http/Controllers/EmployeeApi/Doc*.php (sectionGate calls).
 */
const VIEW = 'Needs docs.view; see clokio_list_docs.';
const CREATE = 'Needs docs.create; see clokio_list_docs.';
const MANAGE = 'Needs docs.manage; see clokio_list_docs.';

const docId = z.number().int().positive().describe('Document id');

const CONTENT_FORMATS = ['markdown', 'html', 'json'] as const;
type ContentFormat = (typeof CONTENT_FORMATS)[number];

const contentArg = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe(
    'Body. Markdown by default; html = Clokio\'s restricted HTML (a 422 names any unsupported tag); ' +
      'json = Tiptap {"type":"doc","content":[...]}'
  );
const contentFormatArg = z.enum(CONTENT_FORMATS).optional().describe('markdown (default), html or json');
const readFormatArg = z.enum(CONTENT_FORMATS).optional().describe('markdown (default), html or json');
const includeTitleArg = z
  .boolean()
  .optional()
  .describe('Markdown only: start the body with the title as a heading (default false)');

const scopeArg = z
  .union([z.number().int().positive(), z.literal('all'), z.literal('none')])
  .optional()
  .describe('Project id, "none" (standalone docs only) or "all" (default)');
const archivedArg = z.enum(['exclude', 'include', 'only']).optional().describe('Default exclude');

/**
 * Map (content, content_format) onto the ONE content field the API accepts.
 * Sending two content fields is a 422, so exactly one key is produced.
 *
 * An empty Markdown/HTML body becomes an empty Tiptap document: the server's
 * request filter turns "" into null, which fails validation with a misleading
 * "must be a string" message, and `{"type":"doc","content":[]}` is the
 * documented way to clear a document.
 */
function contentBody(
  content: string | Record<string, unknown> | undefined,
  format: ContentFormat = 'markdown'
): Record<string, unknown> {
  if (content === undefined) return {};

  if (format === 'json') {
    let tree: unknown = content;
    if (typeof content === 'string') {
      try {
        tree = JSON.parse(content);
      } catch (e) {
        throw new ClokioApiError(0, `content is not valid JSON: ${(e as Error).message}`);
      }
    }
    if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
      throw new ClokioApiError(0, 'content_format "json" needs a Tiptap object {"type":"doc","content":[...]}.');
    }
    return { content: tree };
  }

  if (typeof content !== 'string') {
    throw new ClokioApiError(
      0,
      `content_format "${format}" needs a string; pass content_format "json" to send a Tiptap object.`
    );
  }
  if (content.trim() === '') {
    return { content: { type: 'doc', content: [] } };
  }
  return format === 'html' ? { content_html: content } : { content_markdown: content };
}

// ------------------------------------------------------------ response shapes

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** `{data, meta}`, with meta left out when it would be empty. */
export function envelope(data: unknown, meta?: Obj): Obj {
  const m = meta ? Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) : {};
  return Object.keys(m).length ? { data, meta: m } : { data };
}

/** Lift `key` out of the API's data object into `data`; every other key becomes meta. */
export function liftKey(raw: unknown, key: string): Obj {
  if (!isObj(raw) || !(key in raw)) return envelope(raw);
  const { [key]: data, ...rest } = raw;
  // A nested meta (the list endpoints put paging in data.meta) is flattened
  // into the same meta object rather than nested a second time.
  const { meta: nested, ...others } = rest as Obj;
  return envelope(data, { ...(isObj(nested) ? nested : {}), ...others });
}

/**
 * A document read (live or a version): the record and its body together in
 * `data` (the body sits BESIDE the record in the API, which is easy to miss),
 * the reader's permissions and breadcrumbs in `meta`.
 */
export function shapeDocRead(raw: unknown, recordKey: 'doc' | 'version'): Obj {
  if (!isObj(raw) || !isObj(raw[recordKey])) return envelope(raw);
  const { [recordKey]: record, ...rest } = raw;
  const data: Obj = { ...(record as Obj) };
  const meta: Obj = {};
  for (const [k, v] of Object.entries(rest)) {
    if (k === 'content' || k === 'content_html' || k === 'content_markdown') data[k] = v;
    else meta[k] = v;
  }
  return envelope(data, meta);
}

/**
 * Drop every profile_pic key, at any depth, unless avatars were asked for. A
 * signed avatar URL is a few hundred characters per person and tells a model
 * nothing.
 */
export function stripAvatars<T>(rows: T, keep = false): T {
  if (keep) return rows;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!isObj(v)) return v;
    const out: Obj = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'profile_pic') continue;
      out[k] = strip(val);
    }
    return out;
  };
  return strip(rows) as T;
}

/** Attachment rows with name / size / mime / uploaded_at first, null when the API omits one. */
export function shapeAttachments(raw: unknown): Obj {
  const rows = isObj(raw) && Array.isArray(raw.attachments) ? raw.attachments : Array.isArray(raw) ? raw : null;
  if (!rows) return envelope(raw);
  return envelope(
    rows.map((r: unknown) => {
      if (!isObj(r)) return r;
      const { name, size, mime, uploaded_at, ...rest } = r;
      return { name: name ?? null, size: size ?? null, mime: mime ?? null, uploaded_at: uploaded_at ?? null, ...rest };
    })
  );
}

// ---------------------------------------------------------------------- tools

export function registerDocTools(server: McpServer, config: ClokioConfig): void {
  // ---------------------------------------------------------------- reading

  registerTool(server, config, {
    name: 'clokio_list_docs',
    description:
      'List documents you can view (all scopes by default; project_id narrows). Rows include effective_role ' +
      '(view/comment/edit/admin): edit or admin means you may write content. ' +
      'DOCS ACCESS (applies to every clokio_*doc* tool): each call acts as the API key\'s "acts as" employee, ' +
      'or, if the key has none, as the key\'s creator - only when the key lists docs:read / docs:write ' +
      'explicitly ("*" is not enough). Otherwise every docs tool returns 403: set an acts-as employee or add ' +
      'the docs scopes in Settings > API keys. Reads need scope docs:read, everything else docs:write. You see ' +
      'exactly what that employee sees; a doc they cannot see is 404. ' +
      'Two separate gates: the employee\'s ROLE must hold the section permission each tool names (docs.view ' +
      'reads; docs.create writes, comments, uploads; docs.manage delete and sharing) - a 403 "Forbidden: ' +
      'Insufficient permissions" means it does not; and the DOC role (view<comment<edit<admin, "needs edit" ' +
      'etc.) - a 403 with another message means that is too low. Needs docs.view.',
    schema: {
      project_id: scopeArg,
      parent_id: z
        .union([z.number().int().positive(), z.literal('root')])
        .optional()
        .describe('A doc id to list its children, or "root" for top-level docs only'),
      q: z.string().max(120).optional().describe('Title substring'),
      archived: archivedArg,
      page: z.number().int().min(1).optional(),
      per_page: z.number().int().min(1).max(100).optional().describe('Default 50'),
    },
    handler: async (args, cfg) =>
      liftKey(
        await request(cfg, '/docs', {
          query: {
            project_id: args.project_id ?? 'all',
            parent_id: args.parent_id,
            q: args.q,
            archived: args.archived,
            page: args.page,
            per_page: args.per_page,
          },
        }),
        'docs'
      ),
  });

  registerTool(server, config, {
    name: 'clokio_get_doc_tree',
    description: `Documents you can view as a nested tree (children), paged over the top level. ${VIEW}`,
    schema: {
      project_id: scopeArg,
      archived: archivedArg,
      page: z.number().int().min(1).optional(),
      per_page: z.number().int().min(1).max(100).optional(),
    },
    handler: async (args, cfg) =>
      liftKey(
        await request(cfg, '/docs', {
          query: {
            tree: 1,
            project_id: args.project_id ?? 'all',
            archived: args.archived,
            page: args.page,
            per_page: args.per_page,
          },
        }),
        'tree'
      ),
  });

  registerTool(server, config, {
    name: 'clokio_search_docs',
    description: `Search titles and body text (not archived), newest first; each row has a snippet. ${VIEW}`,
    schema: {
      q: z.string().min(2).max(120),
      project_id: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
    },
    handler: async (args, cfg) =>
      liftKey(
        await request(cfg, '/docs/search', { query: { q: args.q, project_id: args.project_id, limit: args.limit } }),
        'docs'
      ),
  });

  registerTool(server, config, {
    name: 'clokio_get_doc',
    description:
      'Read a document: data = the record plus its body; meta = your role and breadcrumbs. Keep ' +
      `data.content_version for clokio_update_doc_content. ${VIEW}`,
    schema: { id: docId, format: readFormatArg, include_title: includeTitleArg },
    handler: async (args, cfg) =>
      shapeDocRead(
        await request(cfg, `/docs/${seg(args.id)}`, {
          query: { format: args.format ?? 'markdown', include_title: args.include_title ? 1 : undefined },
        }),
        'doc'
      ),
  });

  // ---------------------------------------------------------------- writing

  registerTool(server, config, {
    name: 'clokio_create_doc',
    description:
      'Create a document. parent_id = sub-page (needs edit on the parent); project_id = in that project; ' +
      'neither = standalone (needs docs.manage). Starts at content_version 0. ' +
      CREATE,
    mutates: true,
    schema: {
      title: z.string().min(1).max(255),
      icon: z.string().max(10).optional().describe('One emoji'),
      project_id: z.number().int().positive().optional(),
      parent_id: z.number().int().positive().optional(),
      content: contentArg.optional(),
      content_format: contentFormatArg,
    },
    handler: async (args, cfg) => {
      const body: Record<string, unknown> = {
        title: args.title,
        icon: args.icon,
        project_id: args.project_id,
        parent_id: args.parent_id,
      };
      // An empty body on create is simply an empty document: omit content.
      const blank = typeof args.content === 'string' && args.content.trim() === '';
      if (!blank) Object.assign(body, contentBody(args.content, args.content_format));
      return liftKey(await request(cfg, '/docs', { method: 'POST', body }), 'doc');
    },
  });

  registerTool(server, config, {
    name: 'clokio_update_doc_content',
    description:
      'REPLACE the whole body (needs edit). base_version = the content_version you last read. On 409 do not ' +
      'retry the same base_version: re-read, reconcile, write with the new version. Empty content clears. ' +
      CREATE,
    mutates: true,
    schema: {
      id: docId,
      content: contentArg,
      content_format: contentFormatArg,
      base_version: z.number().int().min(0),
    },
    handler: async (args, cfg) =>
      envelope(
        await request(cfg, `/docs/${seg(args.id)}/content`, {
          method: 'PUT',
          body: { ...contentBody(args.content, args.content_format), base_version: args.base_version },
        })
      ),
  });

  registerTool(server, config, {
    name: 'clokio_update_doc_meta',
    description:
      'Change metadata; send only what changes. title/icon/full_width/sort_order need edit; visibility, ' +
      'inherit_permissions, is_archived need admin. Use clokio_move_doc for parent/project. ' +
      CREATE,
    mutates: true,
    schema: {
      id: docId,
      title: z.string().min(1).max(255).optional(),
      icon: z.string().max(10).nullable().optional().describe('null clears'),
      full_width: z.boolean().optional(),
      sort_order: z.number().int().min(0).optional(),
      visibility: z.enum(['private', 'project', 'organization']).optional(),
      inherit_permissions: z.boolean().optional(),
      is_archived: z.boolean().optional(),
    },
    handler: async (args, cfg) => {
      const { id, ...fields } = args;
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (Object.keys(body).length === 0) {
        throw new ClokioApiError(0, 'Nothing to change: pass at least one field.');
      }
      return liftKey(await request(cfg, `/docs/${seg(id)}`, { method: 'PATCH', body }), 'doc');
    },
  });

  registerTool(server, config, {
    name: 'clokio_move_doc',
    description:
      'Move a document and its sub-pages (needs admin). Send both parent_id and project_id; null = top ' +
      `level / standalone. With a parent, the parent's project wins. ${CREATE}`,
    mutates: true,
    schema: {
      id: docId,
      parent_id: z.number().int().positive().nullable(),
      project_id: z.number().int().positive().nullable(),
      sort_order: z.number().int().min(0).optional(),
    },
    handler: async (args, cfg) =>
      liftKey(
        await request(cfg, `/docs/${seg(args.id)}/move`, {
          method: 'POST',
          body: { parent_id: args.parent_id, project_id: args.project_id, sort_order: args.sort_order },
        }),
        'doc'
      ),
  });

  registerTool(server, config, {
    name: 'clokio_archive_doc',
    description: `Archive a document (needs admin; reversible with clokio_restore_doc). ${CREATE}`,
    mutates: true,
    schema: { id: docId },
    handler: async (args, cfg) =>
      liftKey(await request(cfg, `/docs/${seg(args.id)}/archive`, { method: 'POST' }), 'doc'),
  });

  registerTool(server, config, {
    name: 'clokio_restore_doc',
    description: `Un-archive a document (needs admin). ${CREATE}`,
    mutates: true,
    schema: { id: docId },
    handler: async (args, cfg) =>
      liftKey(await request(cfg, `/docs/${seg(args.id)}/restore`, { method: 'POST' }), 'doc'),
  });

  registerTool(server, config, {
    name: 'clokio_delete_doc',
    description: `DELETE a document (needs admin; not restorable via the API - prefer archive). ${MANAGE}`,
    mutates: 'destructive',
    schema: { id: docId },
    handler: (args, cfg) => request(cfg, `/docs/${seg(args.id)}`, { method: 'DELETE' }),
  });

  // -------------------------------------------------------------- templates

  registerTool(server, config, {
    name: 'clokio_list_doc_templates',
    description: `List document templates (key, name, description). ${VIEW}`,
    schema: {},
    handler: async (_args, cfg) => liftKey(await request(cfg, '/docs/templates'), 'templates'),
  });

  registerTool(server, config, {
    name: 'clokio_create_doc_from_template',
    description: `Create a top-level document from a template key. No project_id = standalone (needs docs.manage). ${CREATE}`,
    mutates: true,
    schema: {
      template: z.string().min(1).max(60),
      title: z.string().max(255).optional(),
      project_id: z.number().int().positive().optional(),
    },
    handler: async (args, cfg) =>
      liftKey(
        await request(cfg, '/docs/from-template', {
          method: 'POST',
          body: { template: args.template, title: args.title, project_id: args.project_id },
        }),
        'doc'
      ),
  });

  // ---------------------------------------------------------------- sharing

  registerTool(server, config, {
    name: 'clokio_list_doc_members',
    description:
      'Who a document is shared with (needs admin): data = members, teams, inherited (change those on the ' +
      `parent); meta = visibility, inherit_permissions, share_link. ${VIEW}`,
    schema: {
      id: docId,
      include_avatars: z.boolean().optional().describe('Include profile pictures (default false)'),
    },
    handler: async (args, cfg) => {
      const raw = await request(cfg, `/docs/${seg(args.id)}/members`, {
        query: { include_avatars: args.include_avatars ? 1 : undefined },
      });
      if (!isObj(raw)) return envelope(raw);
      const { members, teams, inherited, ...meta } = raw;
      const keep = args.include_avatars === true;
      return envelope(
        { members: stripAvatars(members, keep), teams, inherited: stripAvatars(inherited, keep) },
        meta
      );
    },
  });

  registerTool(server, config, {
    name: 'clokio_list_doc_shareable_teams',
    description: `Teams this document can be shared with (needs admin); use id as team_id. ${VIEW}`,
    schema: { id: docId },
    handler: async (args, cfg) => liftKey(await request(cfg, `/docs/${seg(args.id)}/shareable-teams`), 'teams'),
  });

  const memberRole = z.enum(['view', 'comment', 'edit', 'admin']);
  // A person is named by employee_code (preferred - the way every other tool
  // here names people) OR by the internal employee_id. Exactly one.
  const personArgs = {
    employee_code: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,50}$/, 'employee_code must be 1-50 chars of letters, digits, _ or -')
      .optional()
      .describe('Zero-padded, e.g. "00080" (preferred)'),
    employee_id: z.number().int().positive().optional().describe('Internal id, instead of employee_code'),
  };

  /** Exactly one of employee_code / employee_id, as the API requires. */
  function person(args: { employee_code?: string; employee_id?: number }):
    | { employee_code: string }
    | { employee_id: number } {
    const hasCode = args.employee_code !== undefined;
    const hasId = args.employee_id !== undefined;
    if (hasCode === hasId) {
      throw new ClokioApiError(0, 'Name the person with exactly one of employee_code (preferred) or employee_id.');
    }
    return hasCode ? { employee_code: args.employee_code! } : { employee_id: args.employee_id! };
  }

  registerTool(server, config, {
    name: 'clokio_add_doc_member',
    description: `Share a document with a person or change their role (needs admin; they are notified once). ${MANAGE}`,
    mutates: true,
    schema: { id: docId, ...personArgs, role: memberRole },
    handler: async (args, cfg) =>
      envelope(
        await request(cfg, `/docs/${seg(args.id)}/members`, {
          method: 'POST',
          body: { ...person(args), role: args.role },
        })
      ),
  });

  registerTool(server, config, {
    name: 'clokio_update_doc_member',
    description: `Change a person's direct role (needs admin; demoting the last admin is 422). ${MANAGE}`,
    mutates: true,
    schema: { id: docId, ...personArgs, role: memberRole },
    handler: async (args, cfg) => {
      const who = person(args);
      // An id has its own path route; a code rides in the body of the
      // collection route (PATCH /docs/{id}/members).
      return envelope(
        'employee_id' in who
          ? await request(cfg, `/docs/${seg(args.id)}/members/${seg(who.employee_id)}`, {
              method: 'PATCH',
              body: { role: args.role },
            })
          : await request(cfg, `/docs/${seg(args.id)}/members`, {
              method: 'PATCH',
              body: { ...who, role: args.role },
            })
      );
    },
  });

  registerTool(server, config, {
    name: 'clokio_remove_doc_member',
    description: `Remove a person's direct grant (needs admin; a code may name someone who has left). ${MANAGE}`,
    mutates: 'destructive',
    schema: { id: docId, ...personArgs },
    handler: (args, cfg) => {
      const who = person(args);
      // A code travels in the query string of DELETE /docs/{id}/members (the
      // API accepts body or query; a query survives any proxy that drops a
      // DELETE body).
      return 'employee_id' in who
        ? request(cfg, `/docs/${seg(args.id)}/members/${seg(who.employee_id)}`, { method: 'DELETE' })
        : request(cfg, `/docs/${seg(args.id)}/members`, {
            method: 'DELETE',
            query: { employee_code: who.employee_code },
          });
    },
  });

  const teamRole = z.enum(['view', 'comment', 'edit']);
  const teamId = z.number().int().positive().describe('From clokio_list_doc_shareable_teams');

  registerTool(server, config, {
    name: 'clokio_add_doc_team',
    description: `Share a document with a team (needs admin; teams cannot be admins). ${MANAGE}`,
    mutates: true,
    schema: { id: docId, team_id: teamId, role: teamRole },
    handler: async (args, cfg) =>
      envelope(
        await request(cfg, `/docs/${seg(args.id)}/teams`, {
          method: 'POST',
          body: { team_id: args.team_id, role: args.role },
        })
      ),
  });

  registerTool(server, config, {
    name: 'clokio_update_doc_team',
    description: `Change a team's role on a document (needs admin). ${MANAGE}`,
    mutates: true,
    schema: { id: docId, team_id: teamId, role: teamRole },
    handler: async (args, cfg) =>
      envelope(
        await request(cfg, `/docs/${seg(args.id)}/teams/${seg(args.team_id)}`, {
          method: 'PATCH',
          body: { role: args.role },
        })
      ),
  });

  registerTool(server, config, {
    name: 'clokio_remove_doc_team',
    description: `Remove a team's grant (needs admin). ${MANAGE}`,
    mutates: 'destructive',
    schema: { id: docId, team_id: teamId },
    handler: (args, cfg) => request(cfg, `/docs/${seg(args.id)}/teams/${seg(args.team_id)}`, { method: 'DELETE' }),
  });

  registerTool(server, config, {
    name: 'clokio_create_doc_share_link',
    description:
      'Create or REPLACE the public read link (needs admin; the old URL stops working). Expires in 30 days ' +
      `unless expires_at or never_expires is given. ${MANAGE}`,
    mutates: true,
    schema: {
      id: docId,
      expires_at: z.string().optional().describe('Future date or ISO 8601 timestamp'),
      never_expires: z.boolean().optional().describe('No expiry (overrides the 30-day default)'),
    },
    handler: async (args, cfg) => {
      if (args.never_expires && args.expires_at) {
        throw new ClokioApiError(0, 'Pass expires_at or never_expires, not both.');
      }
      return envelope(
        await request(cfg, `/docs/${seg(args.id)}/share-link`, {
          method: 'POST',
          body: { expires_at: args.expires_at, never_expires: args.never_expires },
        })
      );
    },
  });

  registerTool(server, config, {
    name: 'clokio_revoke_doc_share_link',
    description: `Revoke the public link (needs admin). ${MANAGE}`,
    mutates: 'destructive',
    schema: { id: docId },
    handler: (args, cfg) => request(cfg, `/docs/${seg(args.id)}/share-link`, { method: 'DELETE' }),
  });

  // --------------------------------------------------------------- comments

  registerTool(server, config, {
    name: 'clokio_list_doc_comments',
    description: `Comment threads, newest first, replies nested; meta has counts. ${VIEW}`,
    schema: {
      id: docId,
      filter: z.enum(['unresolved', 'resolved', 'all']).optional().describe('Default unresolved'),
      block_id: z.string().max(40).optional(),
    },
    handler: async (args, cfg) =>
      liftKey(
        stripAvatars(
          await request(cfg, `/docs/${seg(args.id)}/comments`, {
            query: { filter: args.filter, block_id: args.block_id },
          })
        ),
        'comments'
      ),
  });

  registerTool(server, config, {
    name: 'clokio_add_doc_comment',
    description: `Comment, or reply to a thread with parent_id (needs comment). Markdown or HTML; @Full Name notifies. ${CREATE}`,
    mutates: true,
    schema: {
      id: docId,
      body: z.string().min(1).max(20000),
      parent_id: z.number().int().positive().optional(),
      block_id: z.string().max(40).optional(),
    },
    handler: async (args, cfg) =>
      liftKey(
        stripAvatars(
          await request(cfg, `/docs/${seg(args.id)}/comments`, {
            method: 'POST',
            body: { body: markdownToHtml(args.body), parent_id: args.parent_id, block_id: args.block_id },
          })
        ),
        'comment'
      ),
  });

  registerTool(server, config, {
    name: 'clokio_resolve_doc_comment',
    description: `Resolve a comment thread (needs comment). ${CREATE}`,
    mutates: true,
    schema: { id: docId, comment_id: z.number().int().positive() },
    handler: async (args, cfg) =>
      liftKey(
        stripAvatars(
          await request(cfg, `/docs/${seg(args.id)}/comments/${seg(args.comment_id)}/resolve`, { method: 'POST' })
        ),
        'comment'
      ),
  });

  registerTool(server, config, {
    name: 'clokio_reopen_doc_comment',
    description: `Reopen a resolved comment thread (needs comment). ${CREATE}`,
    mutates: true,
    schema: { id: docId, comment_id: z.number().int().positive() },
    handler: async (args, cfg) =>
      liftKey(
        stripAvatars(
          await request(cfg, `/docs/${seg(args.id)}/comments/${seg(args.comment_id)}/reopen`, { method: 'POST' })
        ),
        'comment'
      ),
  });

  // --------------------------------------------------------------- versions

  registerTool(server, config, {
    name: 'clokio_list_doc_versions',
    description: `Version history, newest first. Pass a row's id (not its version number) to the other version tools. ${VIEW}`,
    schema: { id: docId },
    handler: async (args, cfg) => liftKey(await request(cfg, `/docs/${seg(args.id)}/versions`), 'versions'),
  });

  registerTool(server, config, {
    name: 'clokio_get_doc_version',
    description: `Read one version snapshot. ${VIEW}`,
    schema: {
      id: docId,
      version_id: z.number().int().positive(),
      format: readFormatArg,
      include_title: includeTitleArg,
    },
    handler: async (args, cfg) =>
      shapeDocRead(
        await request(cfg, `/docs/${seg(args.id)}/versions/${seg(args.version_id)}`, {
          query: { format: args.format ?? 'markdown', include_title: args.include_title ? 1 : undefined },
        }),
        'version'
      ),
  });

  registerTool(server, config, {
    name: 'clokio_restore_doc_version',
    description: `Restore a snapshot over the content (needs edit). content_version moves: use the returned one. ${CREATE}`,
    mutates: true,
    schema: { id: docId, version_id: z.number().int().positive() },
    handler: async (args, cfg) =>
      envelope(
        await request(cfg, `/docs/${seg(args.id)}/versions/${seg(args.version_id)}/restore`, { method: 'POST' })
      ),
  });

  // ------------------------------------------------------------ attachments

  registerTool(server, config, {
    name: 'clokio_list_doc_attachments',
    description: `Files uploaded to a document: name, size, mime, uploaded_at, path (for download). ${VIEW}`,
    schema: { id: docId },
    handler: async (args, cfg) => shapeAttachments(await request(cfg, `/docs/${seg(args.id)}/attachments`)),
  });

  registerTool(server, config, {
    name: 'clokio_upload_doc_attachment',
    description:
      'Upload a LOCAL file (needs edit). kind file (default, 100 MB) or media (images/video, 50 MB). Does not ' +
      `change the text: reference the returned url in the body yourself. ${CREATE}`,
    mutates: true,
    schema: {
      id: docId,
      file_path: z.string().describe('Path on THIS machine'),
      kind: z.enum(['file', 'media']).optional(),
    },
    handler: async (args, cfg) =>
      envelope(
        await requestUpload(cfg, `/docs/${seg(args.id)}/attachments`, args.file_path, { kind: args.kind ?? 'file' })
      ),
  });

  registerTool(server, config, {
    name: 'clokio_download_doc_attachment',
    description:
      'Download an attachment by its path. save_path writes it to disk; otherwise text, PDF text, ZIP entries ' +
      `or an image come back inline. ${VIEW}`,
    schema: {
      id: docId,
      path: z.string().min(1).max(1024).describe('`path` from clokio_list_doc_attachments'),
      file_name: z.string().optional().describe('`name` from the listing (type detection)'),
      save_path: z.string().optional(),
      overwrite: z.boolean().optional().describe('Replace an existing save_path file'),
    },
    handler: (args, cfg) =>
      downloadDocAttachment(cfg, args.id, args.path, {
        fileName: args.file_name,
        savePath: args.save_path,
        overwrite: args.overwrite,
      }),
  });
}
