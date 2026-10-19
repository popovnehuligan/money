import { CATEGORIES, KINDS, isKind } from './classify.ts';
import { deleteTx, getBudget, getTx, setSetting, updateTx, type Env, type Tx } from './db.ts';
import { notify, record } from './ingest.ts';
import { footerFor, morningText, wrapText } from './reports.ts';
import { edit, eur, send, tg, txKeyboard, txText } from './telegram.ts';
import { addMonths, daysInMonth, localStamp, monthOf } from './time.ts';

interface Chat {
  id: number;
}
export interface Update {
  message?: { message_id: number; chat: Chat; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: Chat } };
}

const HELP = `💶 <b>Money bot</b>
Card payments from b-mail appear here by themselves. Tap to sort them:
• a category and 👍/👎 for spending
• 🔁 Podmoga for job money you only pass on (only the net counts)
• 🏦 Savings for moves to your savings account
I remember your choice for the same shop or account next time.

Cash: just type <code>4.50 kava</code> (spent) or <code>+20 gift</code> (received).

/today: today's allowance
/month: this month so far (/month last for the previous one)
/budget 600: monthly spending budget
/gaps off: stop asking about unexplained balance changes
The 📊 menu button opens the dashboard.`;

const CASH = /^([+-]?)\s*(\d+(?:[.,]\d{1,2})?)\s*€?\s*(.*)$/s;

export async function handleUpdate(env: Env, u: Update): Promise<void> {
  if (u.callback_query) return onButton(env, u.callback_query);
  const m = u.message;
  if (!m?.text) return;
  if (!env.CHAT_ID) {
    // First run: tell the owner which id to put into the CHAT_ID secret.
    await tg(env, 'sendMessage', { chat_id: m.chat.id, text: `Your chat id is ${m.chat.id}. Save it as the CHAT_ID secret and redeploy.` });
    return;
  }
  if (String(m.chat.id) !== env.CHAT_ID) return;

  const text = m.text.trim();
  const [cmd, arg] = text.split(/\s+/);
  switch (cmd.split('@')[0]) {
    case '/start':
    case '/help':
      await send(env, HELP);
      return;
    case '/today':
      await send(env, await morningText(env));
      return;
    case '/month': {
      const month = monthOf(localStamp());
      await send(env, await wrapText(env, arg === 'last' ? addMonths(month, -1) : month));
      return;
    }
    case '/budget': {
      const euros = Number(arg?.replace(',', '.'));
      if (!(euros > 0)) {
        const budget = await getBudget(env.DB);
        await send(env, budget === null ? 'No budget yet. Set one: /budget 600' : `Budget: ${eur(budget)} a month. Change it: /budget 650`);
        return;
      }
      const cents = Math.round(euros * 100);
      await setSetting(env.DB, 'budget', String(cents));
      await send(env, `Budget set: ${eur(cents)} a month, about ${eur(Math.floor(cents / daysInMonth(monthOf(localStamp()))))} a day. Unspent money rolls over to the next days.`);
      return;
    }
    case '/gaps':
      await setSetting(env.DB, 'gaps', arg === 'off' ? 'off' : 'on');
      await send(env, arg === 'off' ? 'OK, I won’t flag unexplained balance changes.' : 'OK, I’ll flag unexplained balance changes.');
      return;
  }

  const cash = text.match(CASH);
  if (!cash) {
    await send(env, `I didn't get that. Type an amount like <code>4.50 kava</code>, or /help.`);
    return;
  }
  const cents = Math.round(Number(cash[2].replace(',', '.')) * 100);
  const tx = await record(env, {
    ext_id: `cash-${m.message_id}`, // Telegram may resend an update; this keeps it single
    ts: localStamp(),
    amount: cash[1] === '+' ? cents : -cents,
    currency: 'EUR',
    balance: null,
    merchant: cash[3].trim() || null,
    iban: null,
    note: null,
    method: 'cash',
    source: 'manual',
    raw: null,
  });
  if (tx) await notify(env, tx);
}

async function onButton(env: Env, q: NonNullable<Update['callback_query']>): Promise<void> {
  const answer = (text = '') => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text });
  if (!q.message || String(q.message.chat.id) !== env.CHAT_ID) return;
  const [action, value, n] = (q.data ?? '').split(':');
  const t = await getTx(env.DB, Number(n));
  if (!t) {
    await answer('This entry no longer exists.');
    return;
  }

  if (action === 'd') {
    await deleteTx(env.DB, t.n);
    await tg(env, 'deleteMessage', { chat_id: env.CHAT_ID, message_id: q.message.message_id });
    await answer('Deleted');
    return;
  }

  let patch: Partial<Tx>;
  let toast = '';
  const who = t.merchant ?? 'this'; // toasts are plain text, no escaping
  if (action === 'c' && value in CATEGORIES) {
    patch = { kind: 'spend', category: value, confirmed: 1 };
    toast = `${CATEGORIES[value]}. Next time ${who} goes there automatically.`;
  } else if (action === 'k' && isKind(value)) {
    patch = { kind: value, confirmed: 1 };
    toast = value === 'podmoga' ? 'Podmoga: only the net of in minus out counts.' : `${KINDS[value]}. I’ll remember this for ${who}.`;
  } else if (action === 'w') {
    const worth = Number(value);
    patch = { worth: t.worth === worth ? null : worth };
  } else {
    await answer();
    return;
  }

  await updateTx(env.DB, t.n, patch);
  const updated = { ...t, ...patch };
  await edit(env, q.message.message_id, txText(updated, await footerFor(env, updated)), txKeyboard(updated));
  await answer(toast);
}
