import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules, parseRules } from '../src/classify.ts';

const rules = parseRules('[{"match":["novak","cafe hub"],"multipleOf":150,"max":900,"category":"eat"}]');

test('a rule sorts matching payments that are a multiple of the amount', () => {
  assert.equal(applyRules(rules, -150, 'NOVAK Jan', 'Platba 1100/000000-1234567890'), 'eat');
  assert.equal(applyRules(rules, -450, null, 'Café Hub o.z.'), 'eat');
});

test('other payments to the same name are left for you to sort', () => {
  assert.equal(applyRules(rules, -2000, 'NOVAK Jan'), 'ask');
  assert.equal(applyRules(rules, -1500, 'NOVAK Jan'), 'ask'); // a multiple of 1.50, but over the cap
});

test('rules ignore other names, money coming in and broken settings', () => {
  assert.equal(applyRules(rules, -150, 'LIDL SK'), null);
  assert.equal(applyRules(rules, 150, 'NOVAK Jan'), null);
  assert.deepEqual(parseRules('not json'), []);
  assert.deepEqual(parseRules('[{"match":["x"],"category":"nope"}]'), []);
});
