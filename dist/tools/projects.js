import { z } from 'zod';
import { request } from '../client.js';
import { registerTool } from './helpers.js';
import { VERSION } from '../version.js';
/** Projects, clients, and the board-configuration + reference lookups. */
export function registerProjectTools(server, config) {
    registerTool(server, config, {
        name: 'clokio_list_projects',
        description: 'List projects, optionally filtered by a search term (name / client) or status. Use this to resolve a ' +
            'project NAME to the project_id every task tool needs. Paginated: {data, meta}.',
        schema: {
            search: z.string().max(200).optional(),
            status: z.enum(['active', 'archived']).optional(),
            per_page: z.number().int().min(1).max(100).optional(),
        },
        handler: (args, cfg) => request(cfg, '/projects', {
            query: { search: args.search, status: args.status, per_page: args.per_page },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_get_project_statuses',
        description: "A project's resolved task-status set, in order (what a task in this project may become).",
        schema: { project_id: z.number().int() },
        handler: (args, cfg) => request(cfg, `/projects/${args.project_id}/statuses`),
    });
    registerTool(server, config, {
        name: 'clokio_get_project_custom_fields',
        description: "A project's custom-field definitions, in sort order. An API key sees PUBLIC fields only.",
        schema: { project_id: z.number().int() },
        handler: (args, cfg) => request(cfg, `/projects/${args.project_id}/custom-fields`),
    });
    registerTool(server, config, {
        name: 'clokio_get_project_contacts',
        description: "The contacts for a project's client.",
        schema: { project_id: z.number().int() },
        handler: (args, cfg) => request(cfg, `/projects/${args.project_id}/contacts`),
    });
    registerTool(server, config, {
        name: 'clokio_get_client',
        description: 'Get a client by id.',
        schema: { client_id: z.number().int() },
        handler: (args, cfg) => request(cfg, `/clients/${args.client_id}`),
    });
    registerTool(server, config, {
        name: 'clokio_add_client_contact',
        mutates: true,
        description: 'Add a contact to a client. Every field is optional, but supply at least a name or an email.',
        schema: {
            client_id: z.number().int(),
            name: z.string().max(255).optional(),
            email: z.string().max(255).optional(),
            phone: z.string().max(50).optional(),
        },
        handler: (args, cfg) => request(cfg, `/clients/${args.client_id}/contacts`, {
            method: 'POST',
            body: { name: args.name, email: args.email, phone: args.phone },
        }),
    });
    // ── Reference / vocabulary lookups ──
    registerTool(server, config, {
        name: 'clokio_list_task_statuses',
        description: 'The organisation-wide task-status vocabulary, with is_open per slug (including project-specific slugs). ' +
            'Use this to discover valid status slugs before creating/updating a task.',
        schema: {},
        handler: (_args, cfg) => request(cfg, '/task-statuses'),
    });
    registerTool(server, config, {
        name: 'clokio_list_task_labels',
        description: 'List the available task labels (tags), with names and colors. There is no separate "create label" ' +
            'call and none is needed: naming a label that does not exist yet in clokio_create_task\'s label_names ' +
            'creates it. Check this list first so you reuse an existing label instead of creating a near-duplicate.',
        schema: {},
        handler: (_args, cfg) => request(cfg, '/task-labels'),
    });
    registerTool(server, config, {
        name: 'clokio_list_locations',
        description: 'List the organisation\'s locations.',
        schema: {},
        handler: (_args, cfg) => request(cfg, '/locations'),
    });
    registerTool(server, config, {
        name: 'clokio_list_webhooks',
        description: 'The organisation\'s webhooks with their delivery health (sent / succeeded / failed, last error), for ' +
            'answering "why did a notification not arrive?". READ ONLY - webhooks are created in the Clokio ' +
            'dashboard, never through the API. The destination URL is masked (a webhook URL carries a secret token).',
        schema: {
            active: z.boolean().optional().describe('Filter to active (true) or inactive (false) webhooks'),
        },
        handler: (args, cfg) => request(cfg, '/webhooks', {
            query: { active: args.active === undefined ? undefined : args.active ? 1 : 0 },
        }),
    });
    registerTool(server, config, {
        name: 'clokio_whoami',
        description: 'Who this API key belongs to: the organisation (with its timezone - every date filter is evaluated in ' +
            'it), the rate limits that apply, and the person who issued it. It does NOT report the key\'s scopes ' +
            'or expiry, deliberately - find out what a key may do by using it. ' +
            'CALL THIS FIRST in a session: `issued_by.employee_code` is the value to pass as ' +
            'created_by_employee_code / author_employee_code on every write, so the work is attributed to a person ' +
            'instead of showing up as "External System" on a board the team reads. `issued_by` can be null.',
        schema: {},
        // mcp_version is added CLIENT-side, from the running package, because the
        // server cannot know which build is talking to it.
        //
        // It exists for one reason: `npx -y clokio-mcp` can serve a CACHED old
        // build, and a session then reports bugs that were fixed releases ago
        // against tools it does not actually have. That happened on 2026-09-26 -
        // a session ran 0.1.2 while 0.5.3 was current, and the mismatch took a
        // while to spot. Now the first call of a session states the version.
        handler: async (_args, cfg) => {
            const me = (await request(cfg, '/me'));
            return { ...me, mcp_version: VERSION };
        },
    });
}
