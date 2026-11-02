import { debtFor, owed, owedText, parseDebts, type Categories } from './classify.ts';
import { parseCaps } from './dashboard.ts';
import { firstDay, getBudget, getCategories, getSetting, getSettings, loanPayments, passedOnBefore, passedOnTotal, savedByMonth, spendDaysSince, txBetween, txInMonth, type Env, type Tx } from './db.ts';
import { review, reviewText } from './review.ts';
import { noSpendStreak, safeToSpend, summarize, type Summary } from './stats.ts';
import { eur } from './telegram.ts';
import { addDays, addMonths, dayOf, localStamp, monthName, monthOf } from './time.ts';

/** "🚕 45 of 155 €" for each cap of the month's challenge; over ones say so. */
function capsLine(caps: Record<string, number>, s: Summary, cats: Categories, only?: string): string {
  const spent = new Map(s.byCategory);
  return Object.entries(caps)
    .filter(([c]) => !only || c === only)
    .map(([c, cap]) => {
      const sp = spent.get(c) ?? 0, em = (cats[c] ?? '📦').split(' ')[0];
      return sp > cap ? `${em} <b>${eur(sp)}</b> of ${eur(cap)}: over by ${eur(sp - cap)}` : `${em} ${eur(sp)} of ${eur(cap)}`;
    })
    .join(only ? '' : ' · ');
}

/** The line under each transaction message that says where you stand now. */
export async function footerFor(env: Env, t: Tx): Promise<string | undefined> {
  const month = monthOf(t.ts);
  const name = monthName(month);
  const txs = await txInMonth(env.DB, month);
  const s = summarize(txs, await passedOnBefore(env.DB, `${month}-01`));
  switch (t.kind) {
    case 'spend': {
      const today = dayOf(localStamp());
      const budget = await getBudget(env.DB);
      // This month's challenge: how this category stands against its cap.
      const caps = month === monthOf(today) && t.category ? parseCaps(await getSetting(env.DB, 'caps')) : {};
      let cap = t.category && caps[t.category] ? `\n${capsLine(caps, s, await getCategories(env.DB), t.category)} this month` : '';
      if (t.loan_part && t.debt) {
        // Half of it paid a loan back: where that loan stands now.
        const debts = parseDebts(await getSetting(env.DB, 'debts'));
        const d = debts.find((x) => x.name === t.debt);
        if (d) cap += `\n${owedText(owed([d], (await loanPayments(env.DB)).filter((x) => debtFor(debts, x) === d))[0], eur)}`;
      }
      if (budget === null || dayOf(t.ts) !== today) return `Spent in ${name}: ${eur(s.spent)}${cap}`;
      const safe = safeToSpend(budget, txs, today);
      return (safe.left >= 0
        ? `Left for today: <b>${eur(safe.left)}</b>`
        : `Over today's ${eur(safe.allowance)} by <b>${eur(-safe.left)}</b>, so the next days get a bit less`) + cap;
    }
    case 'loan': {
      const debts = parseDebts(await getSetting(env.DB, 'debts'));
      if (!debts.length) return 'Tell me what you owe with /owe, e.g. /owe Mom 100';
      const d = debtFor(debts, t);
      if (!d) return 'Which loan is this? Pick it below.';
      const loans = (await loanPayments(env.DB)).filter((x) => debtFor(debts, x) === d);
      return owedText(owed([d], loans)[0], eur);
    }
    case 'podmoga': {
      // Not income, not spending: only what you keep counts, as a running total.
      const total = await passedOnTotal(env.DB);
      return `🔁 Kept from passed-on money so far: <b>${eur(total.kept, true)}</b> (${name}: ${eur(s.podmogaNet, true)})`;
    }
    case 'savings':
      return `Saved in ${name}: <b>${eur(s.saved)}</b> 🌱`;
    case 'income':
      return `Earned in ${name}: ${eur(s.earned)}`;
    default:
      return undefined;
  }
}

export async function morningText(env: Env): Promise<string> {
  const today = dayOf(localStamp());
  const month = monthOf(today);
  const [monthTxs, yesterdayTxs, budget, first, spendDays] = await Promise.all([
    txInMonth(env.DB, month),
    txBetween(env.DB, addDays(today, -1), today),
    getBudget(env.DB),
    firstDay(env.DB),
    spendDaysSince(env.DB, addDays(today, -90)),
  ]);
  const s = summarize(monthTxs, await passedOnBefore(env.DB, `${month}-01`));
  const spentYesterday = summarize(yesterdayTxs).spent;

  const lines = [
    budget === null
      ? '☀️ Good morning! Set a monthly budget to get a daily allowance: /budget 600'
      : `☀️ Safe to spend today: <b>${eur(safeToSpend(budget, monthTxs, today).allowance)}</b>`,
    spentYesterday > 0 ? `Yesterday you spent ${eur(spentYesterday)}.` : 'Yesterday: nothing spent 🎉',
  ];
  const streak = first ? noSpendStreak(spendDays, first > addDays(today, -90) ? first : addDays(today, -90), today) : 0;
  if (streak >= 2) lines.push(`🔥 No-spend streak: ${streak} days`);
  lines.push(`${monthName(month)} so far: spent ${eur(s.spent)}${budget === null ? '' : ` of ${eur(budget)}`} · saved ${eur(s.saved)}`);
  const caps = parseCaps(await getSetting(env.DB, 'caps'));
  if (Object.keys(caps).length) lines.push(`🎯 ${capsLine(caps, s, await getCategories(env.DB))}`);
  return lines.join('\n');
}

/** The month in review (the full one is in the dashboard), plus the passed-on running total. */
export async function wrapText(env: Env, month: string): Promise<string> {
  const [txs, prevTxs, settings, cats, saved, total, before] = await Promise.all([
    txInMonth(env.DB, month),
    txInMonth(env.DB, addMonths(month, -1)),
    getSettings(env.DB),
    getCategories(env.DB),
    savedByMonth(env.DB),
    passedOnTotal(env.DB),
    passedOnBefore(env.DB, `${month}-01`),
  ]);
  const savedSoFar = Number(settings.savings_start ?? 0) + saved.reduce((sum, m) => sum + m.saved, 0);
  const goal = { name: settings.goal_name || null, amount: settings.goal_amount ? Number(settings.goal_amount) : null, saved: savedSoFar };
  const r = review({ month, today: dayOf(localStamp()), txs: txs as Tx[], prevTxs, categories: cats, goal, passedOnBefore: before, saveTarget: settings.save_target ? Number(settings.save_target) : 20 });
  const lines = [reviewText(r, cats)];
  if (total.in || total.out) lines.push('', `🔁 Kept from passed-on money so far: <b>${eur(total.kept, true)}</b>`);
  const caps = parseCaps(settings.caps);
  if (r.partial && Object.keys(caps).length) lines.push('', `🎯 ${capsLine(caps, summarize(txs, before), cats)}`);
  return lines.join('\n');
}
