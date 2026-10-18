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
    // ── Board configuration writes (0.27.0, backend #5874 part 4) ──
    // projects:write. Every rule is the web editor's own copy on the server;
    // nothing is judged here beyond the shapes. No delete in this version.
    const fieldOptions = z
        .array(z.object({
        value: z.string().min(1).max(100).describe('The stored value tasks hold; keep it stable'),
        label: z.string().max(100).optional().describe('What people see; defaults to the value'),
        color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb')
            .optional(),
    }))
        .min(1)
        .max(200);
    const fieldType = z.enum(['text', 'number', 'date', 'dropdown', 'checkbox', 'multi_select', 'url', 'email']);
    const actorCode = z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,50}$/, 'employee_code: letters, digits, _ or -')
        .optional()
        .describe('Checked by the server (an unknown code is refused); a configuration edit writes no activity row');
    const statusColor = z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb')
        .nullable()
        .optional();
    registerTool(server, config, {
        name: 'clokio_create_project_custom_field',
        mutates: true,
        description: 'Create a custom field on a project (the board\'s columns). type is one of text, number, date, dropdown, ' +
            'checkbox, multi_select, url, email. A dropdown or multi_select NEEDS options ({value, label?, color?}; ' +
            'the label defaults to the value); every other type takes none. The field key is generated from the ' +
            'name and never changes (it is what clokio_set_task_custom_field and the list filters take). An API ' +
            'key creates PUBLIC fields only. A release or sprint is a dropdown field: create it once, add an ' +
            'option per release with clokio_update_project_custom_field, set it on tasks with ' +
            'clokio_bulk_set_task_custom_field, read it with clokio_get_project_task_summary group_by_custom_field. ' +
            'Needs the projects:write scope.',
        schema: {
            project_id: z.number().int(),
            name: z.string().min(1).max(50),
            type: fieldType,
            options: fieldOptions.optional(),
            is_required: z.boolean().optional(),
            actor_employee_code: actorCode,
        },
        handler: (args, cfg) => {
            const optioned = args.type === 'dropdown' || args.type === 'multi_select';
            if (optioned && args.options === undefined) {
                throw new Error(`A ${args.type} field needs options: give at least one {value, label}.`);
            }
            if (!optioned && args.options !== undefined) {
                throw new Error(`A ${args.type} field takes no options; only dropdown and multi_select do.`);
            }
            const body = { name: args.name, type: args.type };
            if (args.options !== undefined)
                body.options = args.options;
            if (args.is_required !== undefined)
                body.is_required = args.is_required;
            const actor = args.actor_employee_code ?? cfg.defaultActor;
            if (actor)
                body.actor_employee_code = actor;
            return request(cfg, `/projects/${args.project_id}/custom-fields`, { method: 'POST', body });
        },
    });
    registerTool(server, config, {
        name: 'clokio_update_project_custom_field',
        mutates: true,
        description: 'Edit a project custom field by its field_key: rename it (the key stays), change its type, flip ' +
            'is_required, or replace its options with the WHOLE new list. To add a release, read the field with ' +
            'clokio_get_project_custom_fields and send every option plus the new one; renaming a label or ' +
            'reordering is free (tasks store the value). Removing an option tasks still hold is refused naming ' +
            'it; so is a type change that would leave stored answers unreadable. A private field answers not ' +
            'found. Needs the projects:write scope.',
        schema: {
            project_id: z.number().int(),
            field_key: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/, 'field_key: letters, digits, _ or -'),
            name: z.string().min(1).max(50).optional(),
            type: fieldType.optional(),
            options: fieldOptions.optional(),
            is_required: z.boolean().optional(),
            actor_employee_code: actorCode,
        },
        handler: (args, cfg) => {
            const body = {};
            for (const key of ['name', 'type', 'options', 'is_required']) {
                if (args[key] !== undefined)
                    body[key] = args[key];
            }
            if (Object.keys(body).length === 0) {
                throw new Error('Nothing to change: give at least one of name, type, options, is_required.');
            }
            const actor = args.actor_employee_code ?? cfg.defaultActor;
            if (actor)
                body.actor_employee_code = actor;
            return request(cfg, `/projects/${args.project_id}/custom-fields/${args.field_key}`, { method: 'PATCH', body });
        },
    });
    registerTool(server, config, {
        name: 'clokio_create_project_status',
        mutates: true,
        description: 'Add a status (a board column) to a project. The name must be new in the project (compared ignoring ' +
            'case); the slug is generated from it and never changes. A new status is always ACTIVE: a project has ' +
            'exactly one completed status, which always stays the last column. position (0-based) places it. A ' +
            'project still using the organisation\'s statuses gets its own copy first, so no other project ' +
            'changes. Needs the projects:write scope.',
        schema: {
            project_id: z.number().int(),
            name: z.string().min(1).max(50),
            color: statusColor.describe('#rrggbb'),
            position: z.number().int().min(0).max(200).optional().describe('0-based place on the board'),
            actor_employee_code: actorCode,
        },
        handler: (args, cfg) => {
            const body = { name: args.name };
            if (args.color !== undefined)
                body.color = args.color;
            if (args.position !== undefined)
                body.position = args.position;
            const actor = args.actor_employee_code ?? cfg.defaultActor;
            if (actor)
                body.actor_employee_code = actor;
            return request(cfg, `/projects/${args.project_id}/statuses`, { method: 'POST', body });
        },
    });
    registerTool(server, config, {
        name: 'clokio_update_project_status',
        mutates: true,
        description: 'Edit a project status by its slug (clokio_get_project_statuses): rename (the slug stays), recolour, ' +
            'move (position, 0-based; the completed status stays last) or change category. A status cannot become ' +
            'a second completed one, and the completed one cannot become active. Statuses cannot be deleted ' +
            'through the API. Needs the projects:write scope.',
        schema: {
            project_id: z.number().int(),
            slug: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'slug: letters, digits, _ or -'),
            name: z.string().min(1).max(50).optional(),
            color: statusColor.describe('#rrggbb, or null for the default colour'),
            category: z.enum(['active', 'done']).optional(),
            position: z.number().int().min(0).max(200).optional().describe('0-based place on the board'),
            actor_employee_code: actorCode,
        },
        handler: (args, cfg) => {
            const body = {};
            for (const key of ['name', 'color', 'category', 'position']) {
                if (args[key] !== undefined)
                    body[key] = args[key];
            }
            if (Object.keys(body).length === 0) {
                throw new Error('Nothing to change: give at least one of name, color, category, position.');
            }
            const actor = args.actor_employee_code ?? cfg.defaultActor;
            if (actor)
                body.actor_employee_code = actor;
            return request(cfg, `/projects/${args.project_id}/statuses/${args.slug}`, { method: 'PATCH', body });
        },
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
