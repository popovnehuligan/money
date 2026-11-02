import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CATEGORIES } from '../src/classify.ts';
import { review, reviewText, type ReviewTx } from '../src/review.ts';

let n = 0;
const at = (day: number, time: string) => `2026-10-${String(day).padStart(2, '0')}T${time}`;
const tx = (ts: string, euros: number, over: Partial<ReviewTx> = {}): ReviewTx => ({
  ts, amount: Math.round(euros * 100), kind: euros < 0 ? 'spend' : 'income', category: null, worth: null, merchant: `shop ${++n}`, note: null, label: null, ...over,
});
const cats = { ...DEFAULT_CATEGORIES, psychologist: '⛑️ Psychologist' };

// A month like a real one: income, taxis day and night, bars with regrets, a double charge, a therapy pair.
const october: ReviewTx[] = [
  tx(at(1, '09:00'), 1000, { merchant: 'Parent' }),
  tx(at(15, '09:00'), 400, { merchant: 'Client' }),
  ...Array.from({ length: 20 }, (_, i) => tx(at(i + 1, i % 2 ? '23:30' : '14:00'), -8, { category: 'taxi', merchant: 'BOLT' })),
  ...Array.from({ length: 10 }, (_, i) => tx(at(i + 2, '01:00'), -12, { category: 'eat', merchant: 'Bar', worth: i < 4 ? 0 : null })),
  ...Array.from({ length: 8 }, (_, i) => tx(at(i * 3 + 1, '12:00'), -10, { category: 'smokes', merchant: 'Tabak' })),
  tx(at(20, '12:42'), -4.39, { category: 'subscription', merchant: 'Google Play' }),
  tx(at(20, '12:43'), -4.39, { category: 'subscription', merchant: 'Google Play' }),
  tx(at(21, '18:00'), -900, { category: 'home', merchant: 'Rent' }),
  tx(at(6, '10:00'), 35, { kind: 'podmoga', category: 'psychologist', merchant: 'Parent' }),
  tx(at(7, '10:00'), -35, { kind: 'podmoga', category: 'psychologist', merchant: 'Therapist' }),
  tx(at(27, '10:00'), -35, { kind: 'podmoga', category: 'psychologist', merchant: 'Therapist' }),
  tx(at(28, '09:00'), -30, { kind: 'savings', merchant: null, note: 'Sporenie kartou' }),
];
const r = review({ month: '2026-10', today: '2026-11-02', txs: october, prevTxs: [], categories: cats, goal: { name: 'PS5', amount: 90000, saved: 15000 } });
const plain = (s: string) => s.replace(/\u00a0/g, ' '); // amounts use no-break spaces: "1 000 €" never splits

test('passed-on money is not income or spending in the review', () => {
  assert.equal(r.earned, 140000); // the therapy pair lost 35 €: nothing kept, so nothing earned from it
  assert.equal(r.spent, 16000 + 12000 + 8000 + 878 + 90000 + 3500); // taxi, bar, cigarettes, Google Play ×2, rent, and the 35 € passed on beyond what came in
  assert.equal(r.keptPassedOn, -3500);
});

test('cuts come with a saving, a cap and a how-to, biggest first', () => {
  assert.deepEqual(r.cuts.map((c) => c.category), ['taxi', 'eat', 'smokes', 'subscription']);
  const taxi = r.cuts[0];
  assert.equal(taxi.save, 5000); // 30 % of 160 €, to the nearest 5 €
  assert.equal(taxi.cap, 11000);
  assert.match(plain(taxi.text), /20 rides\* at \*8,00 €\* on average, 10 of them at night/);
  assert.equal(r.cuts[1].save, 5000); // the bar: regretted 48 € beats 25 % (30 €), rounded to 50 €
  assert.match(r.cuts[1].text, /marked \*4\* of them 👎/);
});

test('what you would need to earn to keep 20 %', () => {
  const earn = r.earn.map(plain);
  assert.match(earn[0], /You earned \*1 400 €\* and spent \*1 304 €\*: \*96 €\* to spare, 7 %/);
  assert.match(earn[1], /about \*1 630 €\* a month: \*230 €\* more, roughly \*53 €\* a week/);
  assert.match(earn[2], /With the cuts above it's \*70 €\* more, 16 € a week/); // cuts: 50 + 50 + 25 + 5 €
  assert.match(earn.at(-1)!, /Spent includes \*35 €\* more passed on than came in for it/);
});

test('notes: income source, nights out, double charge, therapy paid from your own pocket', () => {
  const text = plain(r.notes.map((x) => x.text).join('\n'));
  assert.match(text, /\*1 000 €\* \(71 %\) of your income came from Parent/);
  assert.match(text, /Nights out/);
  assert.match(text, /Google Play charged \*4,39 €\* 2× on Tue 20 Oct/);
  assert.match(text, /Psychologist: \*35 €\* came from your own pocket/);
  assert.doesNotMatch(text, /came in for it|went out:/); // never the raw passed-on amounts
  assert.match(text, /\*30 €\* went into savings/);
});

test('next month gets a budget and caps that add up to the cuts', () => {
  const p = r.plan!;
  assert.equal(p.save, r.cuts.reduce((s, c) => s + c.save, 0));
  assert.equal(p.budget, Math.floor((r.spent - p.save) / 1000) * 1000);
  assert.deepEqual(p.caps, r.cuts.map((c) => [c.category, c.cap]));
  assert.match(plain(p.text), /in November, about \*\d+ €\* a day/);
  assert.match(plain(reviewText(r, cats)), /🚕 160 € → keep it under <b>110 €<\/b> \(saves 50 €\)/);
});

test('the current month is "so far": a pace, no plan yet', () => {
  const now = review({ month: '2026-10', today: '2026-10-11', txs: october.filter((t) => t.ts < '2026-10-11'), prevTxs: [], categories: cats });
  assert.equal(now.partial, true);
  assert.equal(now.plan, null);
  assert.equal(now.headline, 'October so far');
  assert.match(now.earn[0], /At this pace October ends at about/);
});

test('what you marked necessary is never counted as something to cut', () => {
  const needed = october.map((t) => (t.category === 'taxi' ? { ...t, worth: 2 } : t));
  const r2 = review({ month: '2026-10', today: '2026-11-02', txs: needed, prevTxs: [], categories: cats });
  assert.ok(!r2.cuts.some((c) => c.category === 'taxi'));
  assert.match(plain(r2.notes.map((n) => n.text).join('\n')), /\*160 €\* \(12 %\) of spending you marked necessary/);
});

test('the share to keep is yours to set', () => {
  const r30 = review({ month: '2026-10', today: '2026-11-02', txs: october, prevTxs: [], categories: cats, saveTarget: 30 });
  assert.match(plain(r30.earn[1]), /To keep 30 % of what you earn at this spending, you'd need about \*1 870 €\*/); // 1 304 € ÷ 0.7
});
