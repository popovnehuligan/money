import { BadInput, applyChoice } from './actions.ts';
import { CATEGORIES, KINDS } from './classify.ts';
import { deleteTx, getBudget, getSetting, getTx, setSetting, type Env } from './db.ts';
import { notify, record } from './ingest.ts';
import { footerFor, morningText, wrapText } from './reports.ts';
import { edit, eur, send, tg, txKeyboard, txText, type Keyboard } from './telegram.ts';
import { addMonths, daysInMonth, localStamp, monthOf } from './time.ts';

interface Chat {
  id: number;
}
export interface Update {
  message?: { message_id: number; chat: Chat; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: Chat } };
}

const HELP = `💶 <b>How it works</b>
Card and Google Pay payments appear here about a minute after you pay. Tap to sort them:
• a category and 👍/👎 for spending
• 🔁 Podmoga for job money you only pass on (only the net counts)
• 🏦 Savings for moves to your savings account
I remember your choice for the same shop or account next time.

Cash: type <code>4.50 kava</code> (spent) or <code>+20 gift</code> (received), or use + in the dashboard.

/today  today's allowance
/month  this month so far (/month last for the previous one)
/budget 600  monthly spending budget
/gaps off  stop asking about unexplained balance changes`;

const CASH = /^([+-]?)\s*(\d+(?:[.,]\d{1,2})?)\s*€?\s*(.*)$/s;

export async function dashboardButton(env: Env): Promise<Keyboard | undefined> {
  const base = await getSetting(env.DB, 'base_url');
  return base ? [[{ text: '📊 Open dashboard', web_app: { url: `${base}/app` } }]] : undefined;
}

/** First /start after setup makes that chat the owner; the bot ignores everyone else from then on. */
async function welcome(env: Env): Promise<void> {
  const base = await getSetting(env.DB, 'base_url');
  const forwarder = base ? `${base}/forwarder.gs?key=${env.INGEST_SECRET}` : null;
  await send(
    env,
    `👋 <b>You're in.</b> This bot now talks only to you.

<b>One last step: send your b-mails here</b>
1. On a computer, open this link and copy everything:
${forwarder ?? '(run the Deploy workflow first, then send /start again)'}
2. Go to <a href="https://script.google.com/home/projects/create">script.google.com</a> signed in to the Gmail that gets your b-mails, paste it over the sample code and save.
3. Pick <b>install</b> in the function menu, press Run and allow access.

From then on b-mails skip your inbox (they go to the label <i>b-mail</i>) and each payment shows up here.`,
    await dashboardButton(env),
  );
  await send(env, HELP);
}

export async function handleUpdate(env: Env, u: Update): Promise<void> {
  if (u.callback_query) return onButton(env, u.callback_query);
  const m = u.message;
  if (!m?.text) return;
  const text = m.text.trim();

  if (!env.CHAT_ID) {
    if (!text.startsWith('/start')) return;
    await setSetting(env.DB, 'owner_chat', String(m.chat.id));
    await welcome({ ...env, CHAT_ID: String(m.chat.id) });
    return;
  }
  if (String(m.chat.id) !== env.CHAT_ID) {
    await tg(env, 'sendMessage', { chat_id: m.chat.id, text: 'This is a private bot.' });
    return;
  }

  const [cmd, arg] = text.split(/\s+/);
  switch (cmd.split('@')[0]) {
    case '/start':
      await welcome(env);
      return;
    case '/help':
      await send(env, HELP, await dashboardButton(env));
      return;
    case '/today':
      await send(env, await morningText(env), await dashboardButton(env));
      return;
    case '/month': {
      const month = monthOf(localStamp());
      await send(env, await wrapText(env, arg === 'last' ? addMonths(month, -1) : month), await dashboardButton(env));
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
  const who = t.merchant ?? 'this'; // toasts are plain text, no escaping

  try {
    if (action === 'd') {
      await deleteTx(env.DB, t.n);
      await tg(env, 'deleteMessage', { chat_id: env.CHAT_ID, message_id: q.message.message_id });
      await answer('Deleted');
    } else if (action === 'e') {
      await edit(env, q.message.message_id, txText(t, await footerFor(env, t)), txKeyboard(t, true));
      await answer();
    } else if (action === 'c') {
      await applyChoice(env, { ...t, tg_msg: q.message.message_id }, { category: value });
      await answer(`${CATEGORIES[value]}. Next time ${who} goes there automatically.`);
    } else if (action === 'k') {
      await applyChoice(env, { ...t, tg_msg: q.message.message_id }, { kind: value });
      await answer(value === 'podmoga' ? 'Podmoga: only the net of in minus out counts.' : `${KINDS[value as keyof typeof KINDS]}. I’ll remember this for ${who}.`);
    } else if (action === 'w') {
      const worth = Number(value);
      await applyChoice(env, { ...t, tg_msg: q.message.message_id }, { worth: t.worth === worth ? null : worth });
      await answer();
    } else {
      await answer();
    }
  } catch (e) {
    if (!(e instanceof BadInput)) throw e;
    await answer(e.message);
  }
}
