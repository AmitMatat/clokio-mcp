// 0.26.0: labels on an existing task (backend task #5874 part 1).
//   clokio_update_task     label_names (replace) | add_label_names / remove_label_names (diff)
//   clokio_bulk_update_tasks  add_label_names / remove_label_names, part of "at least one of"
//
// Run by hand:  npm run build && node test/task-labels-026.mjs
import { checker, runTools } from './support/harness.mjs';
import { refuseLabelConflicts, hasNames } from '../dist/tools/tasks.js';

const { check, has, done } = checker();

// ── the client-side refusals, as a function ────────────────────────────
const threw = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return String(e.message);
  }
};
has('replace with add is refused', threw(() => refuseLabelConflicts({ label_names: ['a'], add_label_names: ['b'] }, true)), 'not both');
has('replace with remove is refused', threw(() => refuseLabelConflicts({ label_names: [], remove_label_names: ['b'] }, true)), 'not both');
check('replace alone is fine', threw(() => refuseLabelConflicts({ label_names: ['a'] }, true)), null);
check('add and remove of different names is fine', threw(() => refuseLabelConflicts({ add_label_names: ['a'], remove_label_names: ['b'] }, true)), null);
// One label in both lists is the SERVER's call (it judges resolved labels,
// accent variants included), so the client lets it through.
check('one name in both lists is left to the server', threw(() => refuseLabelConflicts({ add_label_names: ['Bug'], remove_label_names: ['bug'] }, false)), null);
// An empty diff list is not a change, so it never collides with a replace.
check('replace with an empty diff is fine', threw(() => refuseLabelConflicts({ label_names: ['a'], add_label_names: [] }, true)), null);
check('hasNames: empty is nothing', [hasNames([]), hasNames(undefined), hasNames(['a'])], [false, false, true]);

// ── the tools over the wire ────────────────────────────────────────────
const OK = { json: { status: 'success', data: { id: 7, labels: [{ id: 1, name: 'Bug', color: '#6b7280' }] } } };
const run = await runTools({
  toolsets: 'tasks',
  calls: [
    ['clokio_update_task', { id: 7, label_names: ['Bug', 'Urgent'] }], // 0
    ['clokio_update_task', { id: 7, label_names: [] }], // 1 empty = remove all, still sent
    ['clokio_update_task', { id: 7, add_label_names: ['New'], remove_label_names: ['Old'] }], // 2
    ['clokio_update_task', { id: 7, label_names: ['a'], add_label_names: ['b'] }], // 3 refused before any request
    ['clokio_update_task', { id: 7, title: 'Only a title' }], // 4 no label key sent
    ['clokio_bulk_update_tasks', { ids: [1, 2], add_label_names: ['Fresh'] }], // 5 labels alone are a change
    ['clokio_bulk_update_tasks', { ids: [1, 2], remove_label_names: ['Old'], priority: 'high' }], // 6
    ['clokio_bulk_update_tasks', { ids: [1, 2] }], // 7 nothing to change: refused
    ['clokio_bulk_update_tasks', { ids: [1], add_label_names: [], remove_label_names: [] }], // 8 empty lists: nothing to change, refused
    ['clokio_bulk_update_tasks', { ids: [1], label_names: ['x'] }], // 9 not a bulk field: schema refuses or drops it
    ['clokio_update_task', { id: 7, add_label_names: ['x'.repeat(51)] }], // 10 over the column
    ['clokio_update_task', { id: 7, label_names: ['a'], add_label_names: [], remove_label_names: [] }], // 11 empty diffs dropped, replace sent
    ['clokio_bulk_update_tasks', { ids: [1], priority: 'low', add_label_names: [] }], // 12 empty list not sent
    ['clokio_update_task', { id: 7, add_label_names: [], remove_label_names: [] }], // 13 nothing left: refused locally
    ['clokio_update_task', { id: 7 }], // 14 nothing at all: refused locally
  ],
  respond: () => OK,
});

const bodies = run.hits.map((h) => `${h.method} ${h.path} ${JSON.stringify(h.body)}`);
check('replace sends label_names', run.hits[0]?.body?.label_names, ['Bug', 'Urgent']);
check('an empty replace is sent as []', run.hits[1]?.body?.label_names, []);
check('a diff sends both diff fields', [run.hits[2]?.body?.add_label_names, run.hits[2]?.body?.remove_label_names], [['New'], ['Old']]);
check('the diff sends no label_names', 'label_names' in (run.hits[2]?.body ?? {}), false);
check('replace plus diff errors', run.errored(3), true);
has('...in words', run.text(3), 'not both');
check('a title-only update sends no label key', ['label_names', 'add_label_names', 'remove_label_names'].some((k) => k in (run.hits[3]?.body ?? {})), false);
check('bulk with labels alone is sent', run.hits[4]?.body, { ids: [1, 2], add_label_names: ['Fresh'] });
check('bulk with labels and a field', run.hits[5]?.body, { ids: [1, 2], priority: 'high', remove_label_names: ['Old'] });
check('bulk with nothing errors', run.errored(7), true);
has('...naming the label fields', run.text(7), 'add_label_names, remove_label_names');
check('bulk with only empty lists errors', run.errored(8), true);
check('label_names never reaches the bulk route', run.hits.filter((h) => h.path === '/tasks/bulk').some((h) => 'label_names' in (h.body ?? {})), false);
check('a 51-character name errors before any request', run.errored(10), true);
check('replace with empty diffs sends the replace only', run.hits[6]?.body, { label_names: ['a'] });
check('an empty bulk list is not sent', run.hits[7]?.body, { ids: [1], priority: 'low' });
check('update with only empty lists errors', run.errored(13), true);
has('...saying nothing is to change', run.text(13), 'Nothing to change');
check('update with no field errors', run.errored(14), true);
check('exactly eight requests went out (3, 7, 8, 10 refused locally; 9 has nothing to change)', run.hits.length, 8);
check('all of them PATCHes', run.hits.every((h) => h.method === 'PATCH'), true);
console.log(bodies.join('\n'));

// ── the descriptions say what an agent needs ───────────────────────────
const upd = run.tools.clokio_update_task;
const bulk = run.tools.clokio_bulk_update_tasks;
has('update says replace', upd?.description, '`label_names` REPLACES');
has('update says created when missing', upd?.description, 'CREATED');
has('update says not to combine', upd?.description, 'Do not combine');
has('update says an empty list is not a change', upd?.description, 'An empty list is not a change');
has('bulk describes labels_failed', bulk?.description, 'labels_failed');
check('update schema has the three fields', ['label_names', 'add_label_names', 'remove_label_names'].every((k) => k in (upd?.inputSchema?.properties ?? {})), true);
check('bulk schema has the two diff fields only', [
  'add_label_names' in (bulk?.inputSchema?.properties ?? {}),
  'remove_label_names' in (bulk?.inputSchema?.properties ?? {}),
  'label_names' in (bulk?.inputSchema?.properties ?? {}),
], [true, true, false]);
has('bulk names the labels in "at least one of"', bulk?.description, 'status/priority/due_date/add_label_names/remove_label_names');
has('bulk points at update for a replace', bulk?.description, 'clokio_update_task with label_names');
check('both stay mutating, not read-only', [upd?.annotations?.readOnlyHint, bulk?.annotations?.readOnlyHint], [false, false]);

done();
