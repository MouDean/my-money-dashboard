// Run with: node tests/parser.test.js   (uses only made-up sample messages)
const assert = require('assert');
const P = require('../src/parser.js');
const me = ['JOHN A SMITH'];
const rules = P.rulesFromTable(P.DEFAULT_RULES);
function check(text, sender, want) {
  const t = P.parseMessage(text, sender, me);
  for (const k of Object.keys(want)) assert.strictEqual(t[k], want[k], `${k} for: ${text}\n got ${JSON.stringify(t)}`);
  return t;
}
check('Trx. of AED33.25 on your card ending *1234 at EMIRATES POST, UAE is Approved. Avl. card bal is 9849.25.', 'ADIB', { type: 'Out', amount: 33.25, party: 'Emirates Post' });
check('115.00 AED credited to account ending with 5678 for AANI Transfer, FAB SARA AHMED KHAN. Balance: 249.83 AED.', 'AlHilal', { type: 'In', party: 'Sara Ahmed Khan' });
check('15000.00 AED credited to account ending with 5678 for WPS Transfers, Salary Jan2026. Balance: 15200.00 AED.', 'AlHilal', { type: 'In', kind: 'salary' });
check('50.00 AED credited to account ending with 5678 for AANI Transfer, ADCB JOHN A SMITH. Balance: 1.00 AED.', 'AlHilal', { type: 'Own' });
check('Dear Customer, AED 1000.00 was credited to your account *4321. Your available account balance is AED 1000.53', 'ADIB', { type: 'In', amount: 1000 });
const c = check('Trx. of AED18.00 on your card ending *1234 at STARBUCKS MARINA, UAE is Approved.', 'ADIB', { type: 'Out' });
assert.strictEqual(P.categorize(c, rules), 'Coffee & tea');
console.log('All parser tests passed');
