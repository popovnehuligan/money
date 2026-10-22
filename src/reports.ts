import { debtFor, owed, owedText, parseDebts } from './classify.ts';
import { firstDay, getBudget, getCategories, getSetting, loanPayments, spendDaysSince, txBetween, txInMonth, type Env, type Tx } from './db.ts';
import { noSpendStreak, safeToSpend, summarize } from './stats.ts';
import { eur } from './telegram.ts';
import { addDays, addMonths, dayOf, localStamp, monthName, monthOf } from './time.ts';

/** The line under each transaction message that says where you stand now. */
export async function footerFor(env: Env, t: Tx): Promise<string | undefined> {
  const month = monthOf(t.ts);
  const name = monthName(month);
  const txs = await txInMonth(env.DB, month);
  const s = summarize(txs);
  switch (t.kind) {
    case 'spend': {
      const today = dayOf(localStamp());
      const budget = await getBudget(env.DB);
      if (budget === null || dayOf(t.ts) !== today) return `Spent in ${name}: ${eur(s.spent)}`;
      const safe = safeToSpend(budget, txs, today);
      return safe.left >= 0
        ? `Left for today: <b>${eur(safe.left)}</b>`
        : `Over today's ${eur(safe.allowance)} by <b>${eur(-safe.left)}</b>, so the next days get a bit less`;
    }
    case 'loan': {
      const debts = parseDebts(await getSetting(env.DB, 'debts'));
      if (!debts.length) return 'Tell me what you owe with /owe, e.g. /owe Mom 100';
      const d = debtFor(debts, t);
      if (!d) return 'Which loan is this? Pick it below.';
      const loans = (await loanPayments(env.DB)).filter((x) => debtFor(debts, x) === d);
      return owedText(owed([d], loans)[0], eur);
    }
    case 'podmoga':
      return `Passed on in ${name}: ${eur(s.podmogaIn)} in, ${eur(s.podmogaOut)} out → net <b>${eur(s.podmogaNet, true)}</b>`;
    case 'savings':
      return `Saved in ${name}: <b>${eur(s.saved)}</b> 🌱`;
    case 'income':
      return `Income in ${name}: ${eur(s.realIncome)}`;
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
  const s = summarize(monthTxs);
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
  return lines.join('\n');
}

export async function wrapText(env: Env, month: string): Promise<string> {
  const prevMonth = addMonths(month, -1);
  const [s, p] = (await Promise.all([txInMonth(env.DB, month), txInMonth(env.DB, prevMonth)])).map(summarize);
  const vs =
    p.realSpent > 0
      ? ` (${s.realSpent <= p.realSpent ? '▼' : '▲'} ${Math.round((Math.abs(s.realSpent - p.realSpent) / p.realSpent) * 100)} % vs ${monthName(prevMonth)})`
      : '';
  const lines = [
    `📊 <b>${monthName(month)} wrap-up</b>`,
    '',
    `💰 Real income: <b>${eur(s.realIncome)}</b>${s.podmogaNet ? ` (passed-on net ${eur(s.podmogaNet, true)})` : ''}`,
    `💸 Spent: <b>${eur(s.realSpent)}</b>${vs}`,
    `🏦 Saved: <b>${eur(s.saved)}</b>`,
    `➡️ Left over: <b>${eur(s.left, true)}</b>`,
  ];
  if (s.byCategory.length) {
    const cats = await getCategories(env.DB);
    lines.push('', `Top: ${s.byCategory.slice(0, 3).map(([c, v]) => `${(cats[c] ?? '📦').split(' ')[0]} ${eur(v)}`).join(' · ')}`);
  }
  if (s.regret > 0 && s.spent > 0) lines.push(`👎 Regretted: ${eur(s.regret)} (${Math.round((s.regret / s.spent) * 100)} % of spending)`);
  return lines.join('\n');
}
