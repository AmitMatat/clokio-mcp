// recurrenceToRule: the structured object the agent fills must serialize into
// exactly the rule grammar Clokio's scheduler executes - a wrong string here
// is a task that silently never recurs (or recurs on the wrong days).
//
// Run by hand:  node test/recurrence.mjs   (after npm run build)

import { recurrenceToRule } from '../dist/tools/tasks.js';

let failures = 0;
function eq(name, actual, expected) {
  if (actual === expected) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} - got "${actual}", want "${expected}"`); }
}
function throws(name, fn, needle) {
  try {
    fn();
    failures++;
    console.log(`  FAIL ${name} - did not throw`);
  } catch (e) {
    if (String(e.message).includes(needle)) console.log(`  ok   ${name}`);
    else { failures++; console.log(`  FAIL ${name} - threw "${e.message}", want mention of "${needle}"`); }
  }
}

console.log('recurrenceToRule:');

// The acceptance case: task #5445, every Sunday.
eq('weekly on Sunday', recurrenceToRule({ frequency: 'weekly', days_of_week: ['sun'] }), 'weekly:sun');
eq('weekly multi-day', recurrenceToRule({ frequency: 'weekly', days_of_week: ['mon', 'thu'] }), 'weekly:mon,thu');
eq('daily', recurrenceToRule({ frequency: 'daily' }), 'daily');
eq('monthly on the 15th', recurrenceToRule({ frequency: 'monthly', day_of_month: 15 }), 'monthly:15');
eq('quarterly anchored', recurrenceToRule({ frequency: 'quarterly', anchor: '02-10' }), 'quarterly:02-10');
eq('semiannual anchored', recurrenceToRule({ frequency: 'semiannual', anchor: '02-01' }), 'semiannual:02-01');
eq('yearly anchored', recurrenceToRule({ frequency: 'yearly', anchor: '08-09' }), 'yearly:08-09');

// every: N > 1 becomes the custom:N cadence (counts from the due date).
eq('every 3 days', recurrenceToRule({ frequency: 'daily', every: 3 }), 'custom:3:day');
eq('every 2 weeks on Mon', recurrenceToRule({ frequency: 'weekly', every: 2, days_of_week: ['mon'] }), 'custom:2:week:mon');
eq('every 6 months on the 15th', recurrenceToRule({ frequency: 'monthly', every: 6, day_of_month: 15 }), 'custom:6:month:15');

// The dead shapes are refused HERE with the fix named - a day-less weekly is
// the rule shape behind the 2026-08-05 production outage.
throws('day-less weekly refused', () => recurrenceToRule({ frequency: 'weekly' }), 'days_of_week');
// The scheduler spawns ONE occurrence per custom:N cycle - the day list only
// seeds WHICH day - so this combination would silently drop Thursday.
throws('every 2 weeks on TWO days refused', () => recurrenceToRule({ frequency: 'weekly', every: 2, days_of_week: ['mon', 'thu'] }), 'earliest day');
throws('day-less monthly refused', () => recurrenceToRule({ frequency: 'monthly' }), 'day_of_month');
throws('anchor-less quarterly refused', () => recurrenceToRule({ frequency: 'quarterly' }), 'anchor');
throws('quarterly with every refused', () => recurrenceToRule({ frequency: 'quarterly', every: 2, anchor: '01-01' }), 'every');

console.log(failures ? `\nFAIL (${failures})` : '\nPASS');
process.exit(failures ? 1 : 0);
