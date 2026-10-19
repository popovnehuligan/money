import { telegramUserId } from './auth.ts';
import { CATEGORIES } from './classify.ts';
import { firstDay, getBudget, spendDaysSince, txBetween, type Env } from './db.ts';
import { noSpendStreak, safeToSpend, summarize } from './stats.ts';
import { addDays, addMonths, dayOf, localStamp, monthName, monthOf } from './time.ts';

/** Data for the dashboard; only answers when opened from your own Telegram account. */
export async function summaryApi(env: Env, req: Request, url: URL): Promise<Response> {
  const user = await telegramUserId(req.headers.get('x-init-data') ?? '', env.TELEGRAM_TOKEN);
  if (!user || user !== env.CHAT_ID) return Response.json({ error: 'Open the dashboard from the menu button in your Telegram bot.' }, { status: 403 });

  const today = dayOf(localStamp());
  const asked = url.searchParams.get('month') ?? '';
  const month = /^\d{4}-\d{2}$/.test(asked) && asked <= monthOf(today) ? asked : monthOf(today);
  const current = month === monthOf(today);
  const [txs, budget, first, spendDays] = await Promise.all([
    txBetween(env.DB, `${month}-01`, `${addMonths(month, 1)}-01`),
    getBudget(env.DB),
    firstDay(env.DB),
    spendDaysSince(env.DB, addDays(today, -90)),
  ]);
  const since = first && first > addDays(today, -90) ? first : addDays(today, -90);

  return Response.json({
    month,
    name: monthName(month),
    current,
    budget,
    safe: current && budget !== null ? safeToSpend(budget, txs, today) : null,
    streak: current && first ? noSpendStreak(spendDays, since, today) : 0,
    summary: summarize(txs),
    categories: CATEGORIES,
    tx: txs.map((t) => ({
      ts: t.ts,
      amount: t.amount,
      kind: t.kind,
      category: t.category,
      worth: t.worth,
      label: t.merchant ?? t.note ?? (t.method === 'cash' ? 'Cash' : t.method),
    })),
  });
}
