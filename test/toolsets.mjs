// CLOKIO_TOOLSETS selects which optional tool groups register.
//
// tools/list is ~8k tokens with everything on. A task-focused session never
// uses the attendance/leave/time or employee tools. `projects` is always on -
// it holds whoami and the reference lookups the task tools resolve names
// against.
//
// Run by hand:  node test/toolsets.mjs
import { spawnSync } from 'node:child_process';

let fails = 0;
const check = (l, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok?'PASS':'FAIL'} ${l}: ${JSON.stringify(got)}`); };

function listTools(env) {
  const input =
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}\n' +
    '{"jsonrpc":"2.0","method":"notifications/initialized"}\n' +
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n';
  const r = spawnSync('node', ['dist/index.js'], {
    input,
    env: { ...process.env, CLOKIO_API_KEY: 'clk_test', ...env },
    encoding: 'utf8',
    timeout: 8000,
  });
  for (const line of r.stdout.split('\n')) {
    try { const d = JSON.parse(line); if (d.id === 2) return { names: d.result.tools.map((t) => t.name), stderr: r.stderr, code: r.status }; } catch {}
  }
  return { names: null, stderr: r.stderr, code: r.status };
}

// Default: everything.
const all = listTools({});
check('default registers a full set of tools', (all.names?.length ?? 0) >= 46, true);

// tasks only: projects (always on) + tasks; no attendance/employees.
const tasksOnly = listTools({ CLOKIO_TOOLSETS: 'tasks' });
check('tasks toolset keeps clokio_create_task', tasksOnly.names?.includes('clokio_create_task'), true);
check('tasks toolset keeps clokio_whoami (projects always on)', tasksOnly.names?.includes('clokio_whoami'), true);
check('tasks toolset keeps clokio_list_task_statuses (a lookup tasks need)', tasksOnly.names?.includes('clokio_list_task_statuses'), true);
check('tasks toolset keeps clokio_list_project_people', tasksOnly.names?.includes('clokio_list_project_people'), true);
check('tasks toolset DROPS attendance', tasksOnly.names?.includes('clokio_clock_in'), false);
check('tasks toolset DROPS employees', tasksOnly.names?.includes('clokio_list_employees'), false);
check('tasks toolset DROPS the time-logging tools', tasksOnly.names?.includes('clokio_log_time'), false);
const attendanceOnly = listTools({ CLOKIO_TOOLSETS: 'attendance' });
check('attendance toolset carries the four time-logging tools', ['clokio_log_time', 'clokio_start_timer', 'clokio_stop_timer', 'clokio_get_active_timer'].every((n) => attendanceOnly.names?.includes(n)), true);
check('default registers 131 tools', all.names?.length, 131);
check('tasks toolset carries the project task summary', tasksOnly.names?.includes('clokio_get_project_task_summary'), true);
check('tasks toolset registers 42 tools', tasksOnly.names?.length, 42);
check('tasks toolset carries the project activity feed', tasksOnly.names?.includes('clokio_list_project_activity'), true);
check('the board configuration tools are always on (projects)', ['clokio_create_project_custom_field', 'clokio_update_project_custom_field', 'clokio_create_project_status', 'clokio_update_project_status', 'clokio_delete_project_status', 'clokio_delete_project_custom_field'].every((n) => attendanceOnly.names?.includes(n)), true);
check('tasks toolset is smaller than the full set', (tasksOnly.names?.length ?? 99) < (all.names?.length ?? 0), true);

// Multiple toolsets.
const two = listTools({ CLOKIO_TOOLSETS: 'tasks,employees' });
check('tasks,employees keeps employees', two.names?.includes('clokio_list_employees'), true);
check('tasks,employees still drops attendance', two.names?.includes('clokio_clock_in'), false);

// An unknown toolset fails at startup (no tools list returned, non-zero exit).
const bad = listTools({ CLOKIO_TOOLSETS: 'nonsense' });
check('an unknown toolset refuses to start', bad.code !== 0, true);
check('and says which value was unknown', bad.stderr.includes('nonsense'), true);

const ticketsOnly = listTools({ CLOKIO_TOOLSETS: 'tickets' });
check('tickets toolset keeps clokio_reply_ticket', ticketsOnly.names?.includes('clokio_reply_ticket'), true);
check('tickets toolset carries clokio_get_contact_client', ticketsOnly.names?.includes('clokio_get_contact_client'), true);
check('tasks toolset DROPS clokio_get_contact_client', tasksOnly.names?.includes('clokio_get_contact_client'), false);
check('attendance toolset carries the edit and delete tools', ['clokio_update_time_entry', 'clokio_delete_time_entry'].every((n) => attendanceOnly.names?.includes(n)), true);
check('tickets toolset carries the download and draft tools', ['clokio_download_ticket_attachment', 'clokio_create_reply_draft'].every((n) => ticketsOnly.names?.includes(n)), true);
check('tasks toolset carries the inline media tool', tasksOnly.names?.includes('clokio_download_task_media'), true);
check('tickets toolset keeps clokio_whoami (projects always on)', ticketsOnly.names?.includes('clokio_whoami'), true);
check('tasks toolset DROPS tickets', tasksOnly.names?.includes('clokio_list_tickets'), false);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
