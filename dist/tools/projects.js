import { z } from 'zod';
import { request } from '../client.js';
import { registerTool } from './helpers.js';
/** Projects, clients, and the board-configuration + reference lookups. */
export function registerProjectTools(server, config) {
    registerTool(server, config, {
        name: 'clokio_list_projects',
        description: 'List projects, optionally filtered by a search term (name / client).',
        schema: { search: z.string().optional() },
        handler: (args, cfg) => request(cfg, '/projects', { query: { search: args.search } }),
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
        description: 'Add a contact to a client.',
        schema: {
            client_id: z.number().int(),
            name: z.string(),
            email: z.string().optional(),
            phone: z.string().optional(),
            role: z.string().optional(),
        },
        handler: (args, cfg) => request(cfg, `/clients/${args.client_id}/contacts`, {
            method: 'POST',
            body: { name: args.name, email: args.email, phone: args.phone, role: args.role },
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
        description: 'List the available task labels (tags), with names and colors.',
        schema: {},
        handler: (_args, cfg) => request(cfg, '/task-labels'),
    });
    registerTool(server, config, {
        name: 'clokio_list_locations',
        description: 'List the organisation\'s locations.',
        schema: {},
        handler: (_args, cfg) => request(cfg, '/locations'),
    });
}
