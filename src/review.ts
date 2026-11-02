// A month in review: where to cut and how, what you'd need to earn to have money to spare,
// what else stood out, and a challenge for next month. Pure, so the Worker, the bot and the
// design preview build it the same way. Texts mark the numbers to stress with *stars*.
import { DEFAULT_CATEGORIES, type Categories } from './classify.ts';
import type { Tx } from './db.ts';
import { summarize, type StatTx } from './stats.ts';
import { addMonths, daysInMonth, monthName } from './time.ts';

export type ReviewTx = Pick<Tx, 'ts' | 'amount' | 'kind' | 'category' | 'worth' | 'merchant' | 'note' | 'label'>;

export interface Cut {
  category: string;
  spent: number; // cents this month
  count: number;
  save: number; // cents a month you could keep
  cap: number; // next month's limit for it
  text: string;
}

export interface Note {
  icon: string;
  text: string;
}

export interface Review {
  month: string;
  name: string;
  nextName: string;
  partial: boolean; // the month isn't over yet
  headline: string;
  income: number;
  spent: number;
  saved: number;
  spare: number; // income - spent
  keptPassedOn: number; // this month's change of the passed-on running total
  cuts: Cut[];
  earn: string[];
  notes: Note[];
  plan: { budget: number; perDay: number; save: number; caps: [string, number][]; text: string } | null;
}

export interface ReviewInput {
  month: string;
  today: string;
  txs: ReviewTx[];
  prevTxs: StatTx[];
  categories: Categories;
  goal?: { name: string | null; amount: number | null; saved: number } | null;
}

const N0 = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 0 });
const N2 = new Intl.NumberFormat('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 142336 → "1 423 €" */
export const e0 = (c: number) => `${N0.format(Math.round(c / 100))}\u00a0€`; // no-break space: "5 €" never splits
const e2 = (c: number) => `${N2.format(c / 100)}\u00a0€`;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : 0);
const five = (c: number) => Math.round(c / 500) * 500; // to the nearest 5 €
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayName = (day: string) => `${WD[new Date(`${day}T12:00Z`).getUTCDay()]} ${+day.slice(8, 10)} ${MON[+day.slice(5, 7) - 1]}`;
const hour = (t: { ts: string }) => Number(t.ts.slice(11, 13));
const atNight = (t: { ts: string }) => hour(t) >= 22 || hour(t) < 5;
const who = (t: ReviewTx) => t.label ?? t.merchant ?? t.note ?? 'Cash';

/** What each category's cut looks like: the share you could keep, and how. */
type Stats = { spent: number; count: number; avg: number; regret: number; regrets: number; night: number; list: ReviewTx[] };
const HOW: Record<string, { share: number; how: (x: Stats, all: Map<string, Stats>, save: number) => string }> = {
  taxi: {
    share: 0.3,
    how: (x, all) => {
      const scooter = all.get('scooter');
      return `*${plural(x.count, 'ride')}* at *${e2(x.avg)}* on average${x.night ? `, ${x.night} of them at night` : ''}.${scooter && scooter.count >= 3 ? ` A scooter ride costs you *${e2(scooter.avg)}*.` : ''} Keep taxis for late nights and take the scooter or bus by day.`;
    },
  },
  eat: {
    share: 0.25,
    how: (x) => `*${plural(x.count, 'payment')}* at bars${x.regrets ? `, and you marked *${x.regrets}* of them 👎 (${e0(x.regret)})` : ''}. Decide the night's limit before you go out, and stop when it's reached.`,
  },
  smokes: {
    share: 0, // see save() below: one purchase fewer a week
    how: (x, _, save) => `*${plural(x.count, 'purchase')}* at *${e2(x.avg)}* on average. Buying one time fewer a week keeps about *${e0(save)}* a month in your pocket.`,
  },
  parking: {
    share: 0.25,
    how: (x) => `*${plural(x.count, 'parking payment')}* at *${e2(x.avg)}*. Park a little further out, or leave the car when a scooter or the bus will do.`,
  },
  'coffee-food': {
    share: 0.25,
    how: (x) => `*${x.count}× coffee or a bite out* at *${e2(x.avg)}*. Make the weekday coffee at home and keep going out for the good ones.`,
  },
  shop: { share: 0.3, how: (x) => `*${plural(x.count, 'purchase')}*. Leave things in the basket for two days before you buy; most of them stop mattering.` },
  subscription: {
    share: 0, // what repeats or what you regret
    how: (x) => {
      const by = new Map<string, number>();
      for (const t of x.list) by.set(who(t), (by.get(who(t)) ?? 0) - t.amount);
      const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, v]) => `${n} ${e0(v)}`);
      return `${top.join(', ')}. Cancel what you didn't open this month; a charge that came twice is worth a look.`;
    },
  },
};

function statsOf(txs: ReviewTx[]): Map<string, Stats> {
  const m = new Map<string, Stats>();
  for (const t of txs) {
    if (t.kind !== 'spend' || t.amount >= 0) continue;
    const c = t.category ?? 'other';
    const x = m.get(c) ?? { spent: 0, count: 0, avg: 0, regret: 0, regrets: 0, night: 0, list: [] };
    x.spent -= t.amount;
    x.count++;
    if (t.worth === 0) (x.regret -= t.amount), x.regrets++;
    if (atNight(t)) x.night++;
    x.list.push(t);
    m.set(c, x);
  }
  for (const x of m.values()) x.avg = Math.round(x.spent / x.count);
  return m;
}

/** Payments with the same name and amount on the same day: possibly charged twice. */
function doubles(txs: ReviewTx[]): { name: string; amount: number; day: string; times: number }[] {
  const seen = new Map<string, number>();
  for (const t of txs) if (t.kind === 'spend' && t.amount < 0) {
    const k = `${who(t)}|${t.amount}|${t.ts.slice(0, 10)}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n >= 2).map(([k, times]) => {
    const [name, amount, day] = k.split('|');
    return { name, amount: -Number(amount), day, times };
  });
}

export function review(o: ReviewInput): Review {
  const cats = { ...DEFAULT_CATEGORIES, ...o.categories };
  const label = (c: string) => cats[c] ?? cats.other;
  const catName = (c: string) => label(c).slice(label(c).indexOf(' ') + 1);
  const emoji = (c: string) => label(c).split(' ')[0];
  const s = summarize(o.txs);
  const partial = o.today < addMonths(o.month, 1) && o.today >= o.month;
  const name = monthName(o.month), next = addMonths(o.month, 1), nextName = monthName(next);
  const daysSoFar = partial ? Math.max(1, Number(o.today.slice(8, 10)) - 1) : daysInMonth(o.month);
  const spare = s.income - s.spent;
  const all = statsOf(o.txs);

  // 1. Where to cut.
  const cuts: Cut[] = [];
  for (const [c, x] of all) {
    const rule = HOW[c];
    // The category's own way to save, else what you marked 👎 there; whichever is bigger.
    let own = rule ? x.spent * rule.share : 0;
    if (c === 'smokes') own = x.count >= 8 ? Math.min(x.avg * 4.3, x.spent * 0.3) : 0; // one purchase fewer a week, if you buy twice a week or more
    if (c === 'subscription') own = doubles(x.list).reduce((sum, d) => sum + d.amount * (d.times - 1), 0) + x.regret;
    const save = five(Math.max(own, x.regret));
    if (save < 500) continue;
    const text = rule && own > 0 ? rule.how(x, all, save) : `You marked *${plural(x.regrets, 'payment')}* here 👎 (${e0(x.regret)}). Those are the easiest to skip next time.`;
    cuts.push({ category: c, spent: x.spent, count: x.count, save, cap: five(x.spent - save), text });
  }
  cuts.sort((a, b) => b.save - a.save).splice(4);
  const cutTotal = cuts.reduce((sum, c) => sum + c.save, 0);

  // 2. What you'd need to earn: keep 20 % of income (the 50/30/20 rule) at this spending.
  const earn: string[] = [];
  const spent = partial ? Math.round((s.spent * daysInMonth(o.month)) / daysSoFar) : s.spent;
  const need = (sp: number) => Math.ceil(sp / 0.8 / 1000) * 1000;
  if (partial) earn.push(`So far: *${e0(s.income)}* in, *${e0(s.spent)}* spent. At this pace ${name} ends at about *${e0(spent)}* spent.`);
  else if (s.income > 0) earn.push(`You took in *${e0(s.income)}* and spent *${e0(s.spent)}*: ${spare >= 0 ? `*${e0(spare)}* to spare, ${pct(spare, s.income)} % of what came in.` : `*${e0(-spare)}* more than came in.`}`);
  else earn.push(`No income came in this month, and you spent *${e0(s.spent)}*.`);
  const more = Math.max(0, need(spent) - s.income), moreWithCuts = Math.max(0, need(spent - cutTotal) - s.income);
  if (more > 0) {
    earn.push(`To keep 20 % of what you earn at this spending, you'd need about *${e0(need(spent))}* a month: *${e0(more)}* more, roughly *${e0(more / 4.33)}* a week.`);
    if (cutTotal) earn.push(moreWithCuts > 0 ? `With the cuts above it's *${e0(moreWithCuts)}* more, ${e0(moreWithCuts / 4.33)} a week.` : `With the cuts above you'd keep 20 % without earning a cent more.`);
  } else if (!partial) earn.push(`That's at least 20 % kept: right where it should be. 🎉`);
  if (s.podmogaNet) earn.push(`Passed-on money isn't counted here: it ${s.podmogaNet > 0 ? `left you *${e0(s.podmogaNet)}*` : `cost you *${e0(-s.podmogaNet)}*`} this month.`);

  // 3. What else stood out.
  const notes: Note[] = [];
  const income = new Map<string, number>();
  for (const t of o.txs) if (t.kind === 'income' && t.amount > 0) income.set(who(t), (income.get(who(t)) ?? 0) + t.amount);
  const [topSource, topAmount] = [...income].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  if (s.income > 0 && pct(topAmount, s.income) >= 35) notes.push({ icon: '💰', text: `*${e0(topAmount)}* (${pct(topAmount, s.income)} %) of your income came from ${topSource}.` });

  const spends = o.txs.filter((t) => t.kind === 'spend' && t.amount < 0);
  const night = spends.filter(atNight);
  const nightSum = -night.reduce((sum, t) => sum + t.amount, 0);
  if (pct(nightSum, s.spent) >= 15) {
    const byCat = statsOf(night);
    const top = [...byCat].sort((a, b) => b[1].spent - a[1].spent).slice(0, 2).map(([c, x]) => `${emoji(c)} ${e0(x.spent)}`);
    notes.push({ icon: '🌙', text: `Nights out: *${e0(nightSum)}* (${pct(nightSum, s.spent)} % of spending) went out between 22:00 and 05:00, mostly ${top.join(' and ')}.` });
  }

  const byDay = new Map<string, number>();
  for (const t of spends) byDay.set(t.ts.slice(0, 10), (byDay.get(t.ts.slice(0, 10)) ?? 0) - t.amount);
  const [bigDay, bigSum] = [...byDay].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  if (bigDay) {
    const biggest = spends.filter((t) => t.ts.startsWith(bigDay)).sort((a, b) => a.amount - b.amount)[0];
    notes.push({ icon: '📈', text: `Biggest day: *${dayName(bigDay)}*, *${e0(bigSum)}*${biggest ? `, ${e0(-biggest.amount)} of it ${who(biggest)}` : ''}.` });
  }

  const dry = Array.from({ length: daysSoFar }, (_, i) => `${o.month}-${String(i + 1).padStart(2, '0')}`).filter((d) => !byDay.has(d)).length;
  notes.push(dry ? { icon: '✦', text: `*${plural(dry, 'day')}* without spending a cent.` } : { icon: '✦', text: `Not one day without spending. One dry day a week is the cheapest win there is.` });

  for (const d of doubles(spends).slice(0, 2)) notes.push({ icon: '🔍', text: `${d.name} charged *${e2(d.amount)}* ${d.times}× on ${dayName(d.day)}: check it isn't a double charge.` });

  if (s.saved > 0) notes.push({ icon: '🏦', text: `*${e0(s.saved)}* went into savings, round-ups included. That habit is already working: keep it.` });

  if (s.regret > 0) notes.push({ icon: '👎', text: `You marked *${e0(s.regret)}* as not worth it (${pct(s.regret, s.spent)} % of spending). That's money you already know you'd rather keep.` });

  const groups = new Map<string, { in: number; out: number }>();
  for (const t of o.txs) if (t.kind === 'podmoga' && t.category) {
    const g = groups.get(t.category) ?? { in: 0, out: 0 };
    if (t.amount > 0) g.in += t.amount;
    else g.out -= t.amount;
    groups.set(t.category, g);
  }
  for (const [c, g] of groups) {
    if (!g.out) continue; // only bills someone else's money was meant to pay
    const net = g.in - g.out;
    notes.push({ icon: '🔁', text: `${catName(c)}: ${e0(g.in)} came in for it, ${e0(g.out)} went out${net < 0 ? `: *${e0(-net)}* from your own pocket.` : net > 0 ? `: *${e0(net)}* still waiting to be passed on.` : ', fully covered.'}` });
  }

  const unsorted = spends.filter((t) => !t.category);
  if (unsorted.length) notes.push({ icon: '❓', text: `*${plural(unsorted.length, 'payment')}* (${e0(-unsorted.reduce((sum, t) => sum + t.amount, 0))}) still need a category.` });

  const p = summarize(o.prevTxs);
  if (!partial && p.spent > 0 && o.prevTxs.filter((t) => t.kind === 'spend').length >= 30) {
    notes.push({ icon: s.spent <= p.spent ? '▼' : '▲', text: `Spending ${s.spent <= p.spent ? 'down' : 'up'} *${pct(Math.abs(s.spent - p.spent), p.spent)} %* on ${monthName(addMonths(o.month, -1))}.` });
  }

  // 4. Next month's challenge.
  let plan: Review['plan'] = null;
  if (!partial && s.spent > 0) {
    const budget = Math.floor((s.spent - cutTotal) / 1000) * 1000;
    const perDay = Math.floor(budget / daysInMonth(next));
    const goal = o.goal?.amount && o.goal.amount > o.goal.saved ? o.goal : null;
    const toGoal = goal ? ` That alone is ${pct(cutTotal, (goal.amount ?? 0) - goal.saved)} % of the way to your ${goal.name || 'goal'}.` : '';
    plan = {
      budget,
      perDay,
      save: cutTotal,
      caps: cuts.map((c) => [c.category, c.cap]),
      text: `Spend at most *${e0(budget)}* in ${nextName}, about *${e0(perDay)}* a day. Keep to the caps and you keep *${e0(cutTotal)}* more than in ${name}.${toGoal}`,
    };
  }

  const headline = partial
    ? `${name} so far`
    : s.income > 0 && spare >= s.income * 0.2
      ? `${name}: you kept ${pct(spare, s.income)} % of what came in`
      : spare >= 0
        ? `${name}: you broke about even`
        : `${name}: ${e0(-spare)} more went out than came in`;

  return { month: o.month, name, nextName, partial, headline, income: s.income, spent: s.spent, saved: s.saved, spare, keptPassedOn: s.podmogaNet, cuts, earn, notes, plan };
}

/** The review as a Telegram message (HTML), for the 1st of the month. */
export function reviewText(r: Review, categories: Categories): string {
  const cats = { ...DEFAULT_CATEGORIES, ...categories };
  const html = (t: string) => t.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!).replace(/\*([^*]+)\*/g, '<b>$1</b>');
  const lines = [`📋 <b>${html(r.headline)}</b>`, '', `💰 In ${e0(r.income)} · 💸 spent ${e0(r.spent)} · 🏦 saved ${e0(r.saved)}`];
  if (r.cuts.length) {
    lines.push('', '<b>Where to cut</b>');
    for (const c of r.cuts) lines.push(`${(cats[c.category] ?? cats.other).split(' ')[0]} ${e0(c.spent)} → keep it under <b>${e0(c.cap)}</b> (saves ${e0(c.save)})`);
  }
  if (r.plan) lines.push('', `🎯 <b>${html(r.nextName)} challenge</b>`, html(r.plan.text));
  lines.push('', 'The full review, with how to get there, is in the dashboard.');
  return lines.join('\n');
}
