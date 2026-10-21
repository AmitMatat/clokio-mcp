// MCP QA of 0.28.0 (2026-10-21), the two fixes of 0.28.1:
//  1. clokio_delete_time_entry names a project-only entry like every other
//     line ("no task, project <name>"), through ONE helper, entryTarget().
//  2. clokio_start_timer with force: true names the entry it stopped
//     ("Stopped first: ...") and warns when it lasted under a minute, from
//     the server's stopped_entry (backend 2026-10-21); an older server's
//     answer is unchanged.
//
// Run by hand:  npm run build && node test/qa-0281.mjs
// Break-verified: the delete line back to its own task-or-"no task" text
// fails "the delete line uses entryTarget"; withStoppedFirst() ignoring
// stopped_entry fails "a forced start names the stopped entry".
import { readFileSync } from 'node:fs';
import { entryTarget, timeEntryLine, withStoppedFirst } from '../dist/tools/attendance.js';

let fails = 0;
const check = (label, ok) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

check('a task entry names the task', entryTarget({ task: { id: 7, title: 'Header' }, project: { name: 'Site' } }) === 'task #7 Header');
check('a project-only entry names the project', entryTarget({ project: { name: 'Site' } }) === 'no task, project Site');
check('a personal entry names nothing', entryTarget({}) === 'no task');
check('the entry line uses it', timeEntryLine({ id: 1, project: { name: 'Site' } }).includes('| no task, project Site |'));

const src = readFileSync(new URL('../src/tools/attendance.ts', import.meta.url), 'utf8');
const del = src.slice(src.indexOf("name: 'clokio_delete_time_entry'"), src.indexOf("name: 'clokio_list_leaves'"));
check('the delete line uses entryTarget', /\$\{entryTarget\(e\)\}/.test(del) && !del.includes("'no task'"));

const entry = (id, inAt, outAt) => ({ id, date: '2026-10-21', check_in: inAt, check_out: outAt, work_hour: 0 });
const forced = withStoppedFirst({ entry: entry(2, '2026-10-21T05:00:02Z', null), stopped_entry: entry(1, '2026-10-21T05:00:00Z', '2026-10-21T05:00:02Z') });
check('a forced start names the stopped entry', typeof forced.stopped_first === 'string' && forced.stopped_first.startsWith('Stopped first: #1 '));
check('a stopped entry under a minute gets the stop tool\'s warning', /lasted 2 seconds[\s\S]*clokio_delete_time_entry id=1/.test(forced.warning ?? ''));
check('the new entry keeps its line', typeof forced.entry_line === 'string' && forced.entry_line.startsWith('#2 '));
const longer = withStoppedFirst({ entry: entry(4, '2026-10-21T06:00:00Z', null), stopped_entry: entry(3, '2026-10-21T05:00:00Z', '2026-10-21T06:00:00Z') });
check('a longer stopped entry gets no warning', !('warning' in longer) && longer.stopped_first?.startsWith('Stopped first: #3 '));
const plain = withStoppedFirst({ entry: entry(5, '2026-10-21T06:00:00Z', null) });
check('a plain start (or an older server) is unchanged', !('stopped_first' in plain) && !('warning' in plain));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
