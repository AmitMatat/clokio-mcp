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
 * employee - the key's EFFECTIVE actor (backend ActsAsAuthority, owner
 * decision 2026-10-11):
 *   - the key's "acts as" employee, when it has one;
 *   - otherwise the person who CREATED the key, but only when the key lists
 *     docs:read / docs:write EXPLICITLY. The wildcard "*" does not grant docs
 *     scopes to a key with no acts-as employee, so an ordinary full-access
 *     integration key never opens its creator's private documents.
 * Every refusal of that kind is a uniform 403 decided before any document is
 * looked up. The key then sees exactly what that employee sees: a document
 * they cannot see is a 404 (never a 403 - the API will not confirm that an id
 * exists), and a visible document they may not change is a 403. Nothing here
 * re-checks permissions; the API's answer is surfaced verbatim.
 *
 * Three permission layers decide every call, and the descriptions name them:
 *   - the KEY SCOPE: docs:read (GET routes) or docs:write (everything else);
 *   - the SECTION permission of the acting employee's role: docs.view
 *     (reads), docs.create (content writes), docs.manage (delete, sharing);
 *   - the per-document ROLE: view < comment < edit < admin.
 */

/** Appended to every docs tool description: who the call acts as. */
const ACTS_AS =
  "Acts as the key's acts-as employee, else its creator (only if the key lists docs scopes explicitly).";

const docId = z.number().int().positive().describe('The document id');

const CONTENT_FORMATS = ['markdown', 'html', 'json'] as const;
type ContentFormat = (typeof CONTENT_FORMATS)[number];

const contentArg = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe(
    'The document body. Markdown by default (headings, lists, tables, links, bold, italic, code; raw HTML ' +
      'and images inside Markdown are dropped by the server). With content_format "html", a strict 12-tag ' +
      'grammar: p br strong em u s ul ol li blockquote img a - no headings, no attributes except img[src] and ' +
      'a[href], no nested lists; anything else is refused with 422 naming the tag. With content_format ' +
      '"json", a Tiptap document {"type":"doc","content":[...]} (object or JSON string).'
  );

const contentFormatArg = z
  .enum(CONTENT_FORMATS)
  .optional()
  .describe('How to read `content`: markdown (default), html or json (Tiptap)');

const readFormatArg = z
  .enum(CONTENT_FORMATS)
  .optional()
  .describe('Body format to return: markdown (default, best for reading), html, or json (Tiptap tree)');

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

/** The Docs tools (/api/v1/docs, CLOKIO_API_KEY with an acts-as employee). */
export function registerDocTools(server: McpServer, config: ClokioConfig): void {
  // ---------------------------------------------------------------- reading

  registerTool(server, config, {
    name: 'clokio_list_docs',
    description:
      'List documents the key\'s employee can view, as flat rows (id, title, icon, project_id, parent_id, ' +
      'visibility, is_archived, content_version, effective_role, ...) plus meta {page, per_page, total, has_more, ' +
      'truncated}. NOTE the default scope: omitting project_id returns STANDALONE docs only (those in no ' +
      'project); pass project_id "all" for every scope. effective_role (view/comment/edit/admin) is YOUR role ' +
      'on that row; edit or admin means content writes will be accepted. Needs section docs.view. Scope docs:read. ' +
      ACTS_AS +
      ' WHO: every docs tool acts as ONE employee - the key\'s "acts as" employee, or, for a key without one, the ' +
      'person who created the key, and only when docs:read / docs:write are listed on the key explicitly (the ' +
      'wildcard "*" is not enough). Otherwise every docs tool answers 403; set an acts-as employee or add the ' +
      'docs scopes explicitly in Settings > API keys.',
    schema: {
      project_id: z
        .union([z.number().int().positive(), z.literal('all')])
        .optional()
        .describe('A project id, or "all". Omitted = standalone docs only'),
      parent_id: z
        .union([z.number().int().positive(), z.literal('root')])
        .optional()
        .describe('A doc id to list its children (project_id is then ignored), or "root" for top-level docs only'),
      q: z.string().max(120).optional().describe('Case-insensitive title substring'),
      archived: z
        .enum(['exclude', 'include', 'only'])
        .optional()
        .describe('Archived docs: exclude (default), include, or only'),
      page: z.number().int().min(1).optional(),
      per_page: z.number().int().min(1).max(100).optional().describe('1-100, default 50'),
    },
    handler: (args, cfg) =>
      request(cfg, '/docs', {
        query: {
          project_id: args.project_id,
          parent_id: args.parent_id,
          q: args.q,
          archived: args.archived,
          page: args.page,
          per_page: args.per_page,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_get_doc_tree',
    description:
      'The visible documents as a nested tree (data.tree, each node with `children`), paged over the top level, ' +
      'plus meta. A doc whose parent you cannot see appears at the top level. Same scope rule as ' +
      'clokio_list_docs: omitting project_id means standalone docs only; "all" means every scope. Needs ' +
      'section docs.view. Scope docs:read. ' + ACTS_AS,
    schema: {
      project_id: z
        .union([z.number().int().positive(), z.literal('all')])
        .optional()
        .describe('A project id, or "all". Omitted = standalone docs only'),
      archived: z.enum(['exclude', 'include', 'only']).optional(),
      page: z.number().int().min(1).optional(),
      per_page: z.number().int().min(1).max(100).optional().describe('Top-level nodes per page, 1-100'),
    },
    handler: (args, cfg) =>
      request(cfg, '/docs', {
        query: {
          tree: 1,
          project_id: args.project_id,
          archived: args.archived,
          page: args.page,
          per_page: args.per_page,
        },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_search_docs',
    description:
      'Search the titles AND body text of documents you can view, newest edit first. Each row has the listing ' +
      'shape plus `snippet` (~160 chars around the first match). Archived docs are left out. Needs section ' +
      'docs.view. Scope docs:read. ' + ACTS_AS,
    schema: {
      q: z.string().min(2).max(120).describe('2-120 characters; % and _ match literally'),
      project_id: z.number().int().positive().optional().describe('Limit to one project'),
      limit: z.number().int().min(1).max(50).optional().describe('1-50, default 20'),
    },
    handler: (args, cfg) =>
      request(cfg, '/docs/search', {
        query: { q: args.q, project_id: args.project_id, limit: args.limit },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_get_doc',
    description:
      'Read one document: data.doc (metadata incl. content_version), breadcrumbs, effective_role, can_comment, ' +
      'can_edit, can_manage, and the body BESIDE the record as content_markdown / content_html / content (json). ' +
      'Keep doc.content_version: clokio_update_doc_content needs it as base_version. HTML read back is NOT ' +
      'writable as-is (it carries dir/style attributes and possibly headings) - to edit, write Markdown. ' +
      'Archived docs are readable. 404 = no such doc OR one you cannot see. Needs section docs.view. Scope docs:read. ' + ACTS_AS,
    schema: { id: docId, format: readFormatArg },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}`, { query: { format: args.format ?? 'markdown' } }),
  });

  // ---------------------------------------------------------------- writing

  registerTool(server, config, {
    name: 'clokio_create_doc',
    description:
      'Create a document. Where it lands: parent_id = a sub-page (inherits the parent\'s project; needs edit on ' +
      'the parent); project_id = inside that project (needs the right to create tasks there); neither = a ' +
      'standalone org-level doc (org admins / docs.manage only, else 403). Content is Markdown by default. ' +
      'Returns data.doc with content_version 0 - the base_version for the first content write. You become the ' +
      'doc\'s admin. Needs section docs.create. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: {
      title: z.string().min(1).max(255),
      icon: z.string().max(10).optional().describe('A single emoji'),
      project_id: z.number().int().positive().optional(),
      parent_id: z.number().int().positive().optional().describe('Create as a sub-page of this doc'),
      content: contentArg.optional(),
      content_format: contentFormatArg,
    },
    handler: (args, cfg) => {
      const body: Record<string, unknown> = {
        title: args.title,
        icon: args.icon,
        project_id: args.project_id,
        parent_id: args.parent_id,
      };
      // An empty body on create is simply an empty document: omit content.
      const blank = typeof args.content === 'string' && args.content.trim() === '';
      if (!blank) Object.assign(body, contentBody(args.content, args.content_format));
      return request(cfg, '/docs', { method: 'POST', body });
    },
  });

  registerTool(server, config, {
    name: 'clokio_update_doc_content',
    description:
      'REPLACE a document\'s whole body (not a patch, not an append). base_version is REQUIRED: the ' +
      'content_version you last read (clokio_get_doc, or a previous write\'s response). A 409 means someone ' +
      'else changed the doc since: do NOT retry with the same base_version - re-read with clokio_get_doc, ' +
      'reconcile, and write again with the new version (the 409 names current_version and edited_by). ' +
      'Markdown by default; an empty string clears the doc. Returns {content_version, last_edited_at}. ' +
      'Needs section docs.create and edit on the doc (a read-only share is 403). Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: {
      id: docId,
      content: contentArg,
      content_format: contentFormatArg,
      base_version: z.number().int().min(0).describe('The content_version you last read'),
    },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/content`, {
        method: 'PUT',
        body: { ...contentBody(args.content, args.content_format), base_version: args.base_version },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_update_doc_meta',
    description:
      'Change a document\'s metadata - send only what changes. title, icon (null clears), full_width (page ' +
      'layout) and sort_order need edit on the doc; visibility (private/project/organization), ' +
      'inherit_permissions and is_archived need admin on the doc (a call mixing both needs admin). To change ' +
      'parent or project use clokio_move_doc. Returns data.doc and `changed` (fields that actually changed). ' +
      'Needs section docs.create. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: {
      id: docId,
      title: z.string().min(1).max(255).optional(),
      icon: z.string().max(10).nullable().optional().describe('An emoji, or null to clear'),
      full_width: z.boolean().optional(),
      sort_order: z.number().int().min(0).optional(),
      visibility: z.enum(['private', 'project', 'organization']).optional(),
      inherit_permissions: z.boolean().optional(),
      is_archived: z.boolean().optional(),
    },
    handler: (args, cfg) => {
      const { id, ...fields } = args;
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (Object.keys(body).length === 0) {
        throw new ClokioApiError(0, 'Nothing to change: pass at least one field.');
      }
      return request(cfg, `/docs/${seg(id)}`, { method: 'PATCH', body });
    },
  });

  registerTool(server, config, {
    name: 'clokio_move_doc',
    description:
      'Move a document (with its sub-pages) in the tree or between projects. BOTH parent_id and project_id ' +
      'must be given, null meaning top level / standalone, so a forgotten project_id never reads as "move to ' +
      'standalone". With a parent_id the parent\'s project wins. Moving into its own sub-tree is 422; into a ' +
      'project needs the right to create tasks there; into standalone needs docs.manage. Needs section ' +
      'docs.create and admin on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: {
      id: docId,
      parent_id: z.number().int().positive().nullable().describe('New parent doc id, or null for top level'),
      project_id: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe('Target project id, or null for standalone (ignored when parent_id is set)'),
      sort_order: z.number().int().min(0).optional().describe('Position among the new siblings'),
    },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/move`, {
        method: 'POST',
        body: { parent_id: args.parent_id, project_id: args.project_id, sort_order: args.sort_order },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_archive_doc',
    description:
      'Archive a document (hidden from the default listing; still readable by id). Reversible with ' +
      'clokio_restore_doc. Needs section docs.create and admin on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: { id: docId },
    handler: (args, cfg) => request(cfg, `/docs/${seg(args.id)}/archive`, { method: 'POST' }),
  });

  registerTool(server, config, {
    name: 'clokio_restore_doc',
    description:
      'Un-archive a document. (A DELETED doc cannot be restored through the API.) Needs section docs.create ' +
      'and admin on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: { id: docId },
    handler: (args, cfg) => request(cfg, `/docs/${seg(args.id)}/restore`, { method: 'POST' }),
  });

  registerTool(server, config, {
    name: 'clokio_delete_doc',
    description:
      'DELETE a document. A pre-delete version snapshot is kept for administrators, but the doc cannot be ' +
      'restored through the API - prefer clokio_archive_doc unless deletion is explicitly wanted. Needs ' +
      'section docs.manage and admin on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: 'destructive',
    schema: { id: docId },
    handler: (args, cfg) => request(cfg, `/docs/${seg(args.id)}`, { method: 'DELETE' }),
  });

  // -------------------------------------------------------------- templates

  registerTool(server, config, {
    name: 'clokio_list_doc_templates',
    description:
      'List the document templates ({key, name, icon, description}) and can_create_standalone (whether you may ' +
      'create a doc outside any project). Needs section docs.view. Scope docs:read. ' + ACTS_AS,
    schema: {},
    handler: (_args, cfg) => request(cfg, '/docs/templates'),
  });

  registerTool(server, config, {
    name: 'clokio_create_doc_from_template',
    description:
      'Create a top-level document from a template (key from clokio_list_doc_templates; unknown is 404). With ' +
      'project_id it lands in that project (needs the right to create tasks there); without, it is standalone ' +
      '(needs docs.manage). Returns data.doc. Needs section docs.create. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: {
      template: z.string().min(1).max(60).describe('The template key'),
      title: z.string().max(255).optional().describe('Defaults to the template name'),
      project_id: z.number().int().positive().optional(),
    },
    handler: (args, cfg) =>
      request(cfg, '/docs/from-template', {
        method: 'POST',
        body: { template: args.template, title: args.title, project_id: args.project_id },
      }),
  });

  // ---------------------------------------------------------------- sharing

  registerTool(server, config, {
    name: 'clokio_list_doc_members',
    description:
      'Who a document is shared with: members (direct person grants: employee_code, employee_id, name, role; ' +
      'email only when the key has employees:pii), teams (team grants: team_id, name, role), inherited (people ' +
      'reaching it through a parent - change those on the parent), visibility, inherit_permissions and the ' +
      'live share_link if any. Needs section docs.view and admin on the doc. Scope docs:read. ' + ACTS_AS,
    schema: { id: docId },
    handler: (args, cfg) => request(cfg, `/docs/${seg(args.id)}/members`),
  });

  const memberRole = z.enum(['view', 'comment', 'edit', 'admin']);
  // A person is named by employee_code (preferred - the way every other tool
  // here names people) OR by the internal employee_id. Exactly one.
  const personArgs = {
    employee_code: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,50}$/, 'employee_code must be 1-50 chars of letters, digits, _ or -')
      .optional()
      .describe('The person\'s employee_code, zero-padded (e.g. "00080"). Preferred. Resolve names with clokio_list_employees'),
    employee_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Alternative to employee_code: Clokio\'s INTERNAL employee id (as clokio_list_doc_members reports it)'),
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
    description:
      'Share a document with a person, or change their direct role if already shared. Name them by ' +
      'employee_code (preferred) or employee_id. role: view, comment, edit or admin. The person must be an ' +
      'active member of your organisation (422 otherwise) and is notified on a first grant. Needs section ' +
      'docs.manage and admin on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: { id: docId, ...personArgs, role: memberRole },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/members`, {
        method: 'POST',
        body: { ...person(args), role: args.role },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_update_doc_member',
    description:
      'Change an existing direct grant\'s role. Name the person by employee_code (preferred) or employee_id. ' +
      '404 if the person has no direct grant; demoting the last admin is 422. Needs section docs.manage and ' +
      'admin on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: { id: docId, ...personArgs, role: memberRole },
    handler: (args, cfg) => {
      const who = person(args);
      // An id has its own path route; a code rides in the body of the
      // collection route (PATCH /docs/{id}/members).
      return 'employee_id' in who
        ? request(cfg, `/docs/${seg(args.id)}/members/${seg(who.employee_id)}`, {
            method: 'PATCH',
            body: { role: args.role },
          })
        : request(cfg, `/docs/${seg(args.id)}/members`, {
            method: 'PATCH',
            body: { ...who, role: args.role },
          });
    },
  });

  registerTool(server, config, {
    name: 'clokio_remove_doc_member',
    description:
      'Remove a person\'s direct grant. Name them by employee_code (preferred; may name someone who has since ' +
      'left, to revoke their grant) or employee_id. Removing the ' +
      'last admin is 422; inherited access must be removed on the parent. Needs section docs.manage and admin ' +
      'on the doc. Scope docs:write. ' + ACTS_AS,
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

  registerTool(server, config, {
    name: 'clokio_list_doc_shareable_teams',
    description:
      'The organisation\'s teams this document can be shared with ({id, name, color, members_count}) - use the ' +
      'id as team_id in ' +
      'clokio_add_doc_team. Needs section docs.view and admin on the doc. Scope docs:read. ' + ACTS_AS,
    schema: { id: docId },
    handler: (args, cfg) => request(cfg, `/docs/${seg(args.id)}/shareable-teams`),
  });

  const teamRole = z.enum(['view', 'comment', 'edit']).describe('Teams cannot be admins');
  const teamId = z
    .number()
    .int()
    .positive()
    .describe('The team id (from clokio_list_doc_shareable_teams, or teams[].team_id in clokio_list_doc_members)');

  registerTool(server, config, {
    name: 'clokio_add_doc_team',
    description:
      'Share a document with a team (role view, comment or edit). The team must be in your organisation. ' +
      'Find team ids with clokio_list_doc_shareable_teams; current team grants are in clokio_list_doc_members. Needs section docs.manage and admin on the ' +
      'doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: { id: docId, team_id: teamId, role: teamRole },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/teams`, {
        method: 'POST',
        body: { team_id: args.team_id, role: args.role },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_update_doc_team',
    description:
      'Change a team grant\'s role (404 if the team has no grant). Needs section docs.manage and admin on the ' +
      'doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: { id: docId, team_id: teamId, role: teamRole },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/teams/${seg(args.team_id)}`, {
        method: 'PATCH',
        body: { role: args.role },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_remove_doc_team',
    description:
      'Remove a team\'s grant on a document. Needs section docs.manage and admin on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: 'destructive',
    schema: { id: docId, team_id: teamId },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/teams/${seg(args.team_id)}`, { method: 'DELETE' }),
  });

  registerTool(server, config, {
    name: 'clokio_create_doc_share_link',
    description:
      'Create a PUBLIC link to a document (anyone with the URL can read it), or REPLACE the existing one - the ' +
      'old URL stops working. Returns {share_token, share_url, expires_at}. Needs section docs.manage and ' +
      'admin on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: {
      id: docId,
      expires_at: z
        .string()
        .optional()
        .describe('Optional expiry, a date/time in the future (e.g. 2026-12-31 or an ISO 8601 timestamp)'),
    },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/share-link`, {
        method: 'POST',
        body: { expires_at: args.expires_at },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_revoke_doc_share_link',
    description:
      'Revoke a document\'s public link. Needs section docs.manage and admin on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: 'destructive',
    schema: { id: docId },
    handler: (args, cfg) => request(cfg, `/docs/${seg(args.id)}/share-link`, { method: 'DELETE' }),
  });

  // --------------------------------------------------------------- comments

  registerTool(server, config, {
    name: 'clokio_list_doc_comments',
    description:
      'A document\'s comment threads, newest first (max 100), replies nested under `replies`, plus counts ' +
      '{unresolved, resolved, total}. Needs section docs.view and view on the doc. Scope docs:read. ' + ACTS_AS,
    schema: {
      id: docId,
      filter: z
        .enum(['unresolved', 'resolved', 'all'])
        .optional()
        .describe('Which threads: unresolved (default), resolved or all'),
      block_id: z.string().max(40).optional().describe('Only threads anchored to this block'),
    },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/comments`, {
        query: { filter: args.filter, block_id: args.block_id },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_add_doc_comment',
    description:
      'Comment on a document, or reply to a thread (parent_id = a thread on THIS doc; a reply to a reply is ' +
      '422). The body accepts Markdown (converted to HTML) or HTML. @Full Name mentions of active colleagues ' +
      'notify them. Needs section docs.create and comment on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: {
      id: docId,
      body: z.string().min(1).max(20000).describe('Markdown or HTML'),
      parent_id: z.number().int().positive().optional().describe('Reply to this thread'),
      block_id: z.string().max(40).optional().describe('Anchor the comment to a block of the doc'),
    },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/comments`, {
        method: 'POST',
        body: { body: markdownToHtml(args.body), parent_id: args.parent_id, block_id: args.block_id },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_resolve_doc_comment',
    description:
      'Resolve a comment thread (a thread, not a reply - a reply is 422). Needs section docs.create and ' +
      'comment on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: { id: docId, comment_id: z.number().int().positive() },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/comments/${seg(args.comment_id)}/resolve`, { method: 'POST' }),
  });

  registerTool(server, config, {
    name: 'clokio_reopen_doc_comment',
    description:
      'Reopen a resolved comment thread. Needs section docs.create and comment on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: { id: docId, comment_id: z.number().int().positive() },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/comments/${seg(args.comment_id)}/reopen`, { method: 'POST' }),
  });

  // --------------------------------------------------------------- versions

  registerTool(server, config, {
    name: 'clokio_list_doc_versions',
    description:
      'A document\'s version history, newest first (max 50): {id, version, reason, created_at, creator}. reason ' +
      'is manual_save, auto_save, restore, pre_delete or conflict_backup. Pass the `id` (not the `version` ' +
      'number) to the other version tools. Needs section docs.view and view on the doc. Scope docs:read. ' + ACTS_AS,
    schema: { id: docId },
    handler: (args, cfg) => request(cfg, `/docs/${seg(args.id)}/versions`),
  });

  registerTool(server, config, {
    name: 'clokio_get_doc_version',
    description:
      'Read one snapshot from a document\'s history, in markdown (default), html or json. version_id is the ' +
      '`id` from clokio_list_doc_versions. Needs section docs.view and view on the doc. Scope docs:read. ' + ACTS_AS,
    schema: { id: docId, version_id: z.number().int().positive(), format: readFormatArg },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/versions/${seg(args.version_id)}`, {
        query: { format: args.format ?? 'markdown' },
      }),
  });

  registerTool(server, config, {
    name: 'clokio_restore_doc_version',
    description:
      'Copy a snapshot back over the document\'s content (recorded as a new `restore` version). Returns ' +
      '{content_version, version}: content_version MOVES, so use the returned value as base_version for the ' +
      'next content write. Needs section docs.create and edit on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: { id: docId, version_id: z.number().int().positive() },
    handler: (args, cfg) =>
      request(cfg, `/docs/${seg(args.id)}/versions/${seg(args.version_id)}/restore`, { method: 'POST' }),
  });

  // ------------------------------------------------------------ attachments

  registerTool(server, config, {
    name: 'clokio_list_doc_attachments',
    description:
      'Files uploaded to a document (max 200): {kind: media|file, name, path, url}. Read from storage, so a ' +
      'file removed from the text is still listed. Download with clokio_download_doc_attachment using `path` ' +
      '(the `url` values need a browser session). Needs section docs.view and view on the doc. Scope docs:read. ' + ACTS_AS,
    schema: { id: docId },
    handler: (args, cfg) => request(cfg, `/docs/${seg(args.id)}/attachments`),
  });

  registerTool(server, config, {
    name: 'clokio_upload_doc_attachment',
    description:
      'Upload a LOCAL FILE to a document. kind "file" (default): anything up to 100 MB except executable and ' +
      'markup types (php, js, sh, exe, svg, html, xml...). kind "media": jpg/jpeg/png/gif/webp/heic/heif ' +
      '(HEIC becomes JPEG)/mp4/webm/mov, up to 50 MB. Returns {kind, url, path, name, size, mime}. Uploading ' +
      'does NOT change the text: to show it, write content (content_format json) with an `image` node ' +
      '(src = url) for media or a `fileAttachment` node (url, name, size, mime) for a file. Needs section ' +
      'docs.create and edit on the doc. Scope docs:write. ' + ACTS_AS,
    mutates: true,
    schema: {
      id: docId,
      file_path: z.string().describe('Path to a file on THIS machine'),
      kind: z.enum(['file', 'media']).optional().describe('file (default) or media'),
    },
    handler: (args, cfg) =>
      requestUpload(cfg, `/docs/${seg(args.id)}/attachments`, args.file_path, { kind: args.kind ?? 'file' }),
  });

  registerTool(server, config, {
    name: 'clokio_download_doc_attachment',
    description:
      'Download one document attachment by its storage `path` (from clokio_list_doc_attachments). With ' +
      'save_path, writes the file to disk (creating folders, refusing to overwrite unless overwrite: true) and ' +
      'returns {saved_to, sha256, mime_type, file_size}. Without it, returns the content in the most usable ' +
      'form: text as text, a PDF as extracted text plus page count, a ZIP as its entry list, an image as an ' +
      'image you can see, anything else as a type-and-size description. Large text/PDF is truncated (use ' +
      'save_path for the whole file). Needs section docs.view and view on the doc. Scope docs:read. ' + ACTS_AS,
    schema: {
      id: docId,
      path: z.string().min(1).max(1024).describe('The attachment `path` from clokio_list_doc_attachments'),
      file_name: z
        .string()
        .optional()
        .describe('The attachment `name` from the listing. Drives type detection (text/PDF/zip/image)'),
      save_path: z
        .string()
        .optional()
        .describe('Write the file here instead of returning its content; parent folders are created'),
      overwrite: z.boolean().optional().describe('Allow save_path to replace an existing file (default false)'),
    },
    handler: (args, cfg) =>
      downloadDocAttachment(cfg, args.id, args.path, {
        fileName: args.file_name,
        savePath: args.save_path,
        overwrite: args.overwrite,
      }),
  });
}
