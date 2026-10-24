import { BadInput, applyChoice, type Choice } from './actions.ts';
import { telegramUserId } from './auth.ts';
import { DEFAULT_CATEGORIES, categoriesFrom, categoryLabel, newCategory, owed, parseDebts } from './classify.ts';
import { dashboard, readSettings } from './dashboard.ts';
import { deleteSetting, deleteTx, getSettings, getTx, loanPayments, myCategories, saveMyCategories, savedByMonth, setSetting, spendDaysSince, firstDay, txBetween, txInMonth, uncategorize, type Env } from './db.ts';
import { notify, record } from './ingest.ts';
import { noSpendStreak } from './stats.ts';
import { tg } from './telegram.ts';
import { addDays, addMonths, dayOf, localStamp, monthOf } from './time.ts';

async function summary(env: Env, asked?: string | null) {
  const today = dayOf(localStamp());
  const month = asked && /^\d{4}-\d{2}$/.test(asked) && asked <= monthOf(today) ? asked : monthOf(today);
  const since = addDays(today, -90);
  const [txs, prevTxs, settings, saved, first, spendDays, loans] = await Promise.all([
    txBetween(env.DB, `${month}-01`, `${addMonths(month, 1)}-01`),
    txInMonth(env.DB, addMonths(month, -1)),
    getSettings(env.DB),
    savedByMonth(env.DB),
    firstDay(env.DB),
    spendDaysSince(env.DB, since),
    loanPayments(env.DB),
  ]);
  return dashboard({
    month,
    today,
    txs,
    prevTxs,
    settings: readSettings(settings),
    savedByMonth: saved,
    streak: first ? noSpendStreak(spendDays, first > since ? first : since, today) : 0,
    debts: owed(parseDebts(settings.debts ?? null), loans),
    categories: categoriesFrom(settings.categories ?? null),
  });
}

const cents = (v: unknown): number | null => {
  if (v === null || v === '' || v === undefined) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 1e10) throw new BadInput('Amounts must be positive numbers.');
  return n;
};

/** The dashboard's data API. Answers only when opened from the owner's Telegram. */
export async function api(env: Env, req: Request, url: URL): Promise<Response> {
  const user = await telegramUserId(req.headers.get('x-init-data') ?? '', env.TELEGRAM_TOKEN);
  if (!user || user !== env.CHAT_ID) return Response.json({ error: 'Open the dashboard from the menu button in your Telegram bot.' }, { status: 403 });

  if (req.method === 'GET' && url.pathname === '/api/summary') return Response.json(await summary(env, url.searchParams.get('month')));
  if (req.method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  try {
    switch (url.pathname) {
      case '/api/tx': {
        const t = await getTx(env.DB, Number(body.n));
        if (!t) return Response.json({ error: 'That payment no longer exists.' }, { status: 404 });
        await applyChoice(env, t, body as Choice);
        return Response.json(await summary(env, monthOf(t.ts)));
      }
      case '/api/delete': {
        const t = await getTx(env.DB, Number(body.n));
        if (!t) return Response.json(await summary(env, String(body.month ?? '')));
        if (t.source === 'bmail') throw new BadInput('Bank payments can’t be deleted. Mark them 🚫 Ignore instead.');
        await deleteTx(env.DB, t.n);
        if (t.tg_msg) await tg(env, 'deleteMessage', { chat_id: env.CHAT_ID, message_id: t.tg_msg });
        return Response.json(await summary(env, monthOf(t.ts)));
      }
      case '/api/cash': {
        const amount = Math.round(Number(body.amount));
        if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e8) throw new BadInput('Enter an amount.');
        const tx = await record(env, {
          ext_id: `app-${crypto.randomUUID()}`,
          ts: localStamp(),
          amount,
          currency: 'EUR',
          balance: null,
          merchant: String(body.note ?? '').trim().slice(0, 80) || null,
          iban: null,
          note: null,
          method: 'cash',
          source: 'manual',
          raw: null,
        });
        if (tx) {
          const sorted = typeof body.newCategory === 'string' ? await applyChoice(env, tx, { newCategory: body.newCategory }) : typeof body.category === 'string' ? await applyChoice(env, tx, { category: body.category }) : tx;
          await notify(env, sorted); // so it's in the chat too, like everything else
        }
        return Response.json(await summary(env));
      }
      case '/api/category': {
        // ⚙ Categories: add one, rename one (built-in ones too), or delete one of yours.
        const mine = await myCategories(env.DB);
        const cats = categoriesFrom(JSON.stringify(mine));
        if (typeof body.add === 'string') {
          const made = newCategory(body.add, cats);
          if (!made) throw new BadInput('Type a name for it, e.g. 🎮 Games');
          if (!(made[0] in cats)) mine[made[0]] = made[1];
        } else if (typeof body.rename === 'string' && body.rename in cats) {
          const label = categoryLabel(String(body.label ?? ''), cats[body.rename].split(' ')[0]);
          if (!label) throw new BadInput('Type a name for it, e.g. 🎮 Games');
          mine[body.rename] = label;
        } else if (typeof body.remove === 'string' && body.remove in mine && !(body.remove in DEFAULT_CATEGORIES)) {
          delete mine[body.remove];
          await uncategorize(env.DB, body.remove);
        } else {
          throw new BadInput('Nothing to change.');
        }
        await saveMyCategories(env.DB, mine);
        return Response.json(await summary(env, String(body.month ?? '')));
      }
      case '/api/settings': {
        const values: Record<string, string | null> = {};
        if ('budget' in body) values.budget = cents(body.budget)?.toString() ?? null;
        if ('goalAmount' in body) values.goal_amount = cents(body.goalAmount)?.toString() ?? null;
        if ('savingsStart' in body) values.savings_start = cents(body.savingsStart)?.toString() ?? null;
        if ('goalName' in body) values.goal_name = String(body.goalName ?? '').trim().slice(0, 40) || null;
        for (const [key, value] of Object.entries(values)) await (value === null ? deleteSetting(env.DB, key) : setSetting(env.DB, key, value));
        return Response.json(await summary(env, String(body.month ?? '')));
      }
    }
  } catch (e) {
    if (e instanceof BadInput) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  return Response.json({ error: 'Not found' }, { status: 404 });
}
