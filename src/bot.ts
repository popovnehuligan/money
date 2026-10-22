import { BadInput, applyChoice } from './actions.ts';
import { KINDS, owed, owedText, parseDebts, type Categories } from './classify.ts';
import { debtNames, deleteSetting, deleteTx, getBudget, getCategories, getSetting, getTx, loanPayments, setSetting, type Env } from './db.ts';
import { notify, record } from './ingest.ts';
import { fold } from './parse.ts';
import { footerFor, morningText, wrapText } from './reports.ts';
import { edit, eur, send, tg, txKeyboard, txText, type Keyboard } from './telegram.ts';
import { addMonths, daysInMonth, localStamp, monthOf } from './time.ts';

interface Chat {
  id: number;
}
export interface Update {
  message?: { message_id: number; chat: Chat; text?: string; reply_to_message?: { message_id: number } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: Chat } };
}

const help = (cats: Categories) => `💶 <b>How it works</b>
Card and Google Pay payments appear here about a minute after you pay. Tap to sort them:
• a category and 👍/👎 for spending: ${Object.values(cats).join(' · ')}, or ➕ to type your own
• 🔁 Passed on for money you only pass on, like podmoga jobs or mom’s money for the psychologist (only the net counts)
• 🏦 Savings for moves to your savings account
• 🤝 Loan for borrowing or paying someone back (/owe shows what's left)
I remember your choice for the same shop or account next time.

Cash: type <code>4.50 kava</code> (spent) or <code>+20 gift</code> (received), or use + in the dashboard.

/today  today's allowance
/month  this month so far (/month last for the previous one)
/budget 600  monthly spending budget
/owe  what you still owe (/owe Mom 100 to set it)
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
  await send(env, help(await getCategories(env.DB)));
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
      await send(env, help(await getCategories(env.DB)), await dashboardButton(env));
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
    case '/owe': {
      // "/owe" lists what you owe; "/owe Mom 100" says you owe Mom 100 € now.
      const debts = parseDebts(await getSetting(env.DB, 'debts'));
      const loans = await loanPayments(env.DB);
      const m = text.match(/^\/owe(?:@\S+)?\s+(.+?)\s+(\d+(?:[.,]\d{1,2})?)\s*€?$/);
      if (m) {
        const now = Math.round(Number(m[2].replace(',', '.')) * 100);
        let d = debts.find((x) => fold(x.name) === fold(m[1]));
        if (!d) debts.push((d = { name: m[1], match: [], amount: 0 }));
        d.amount += now - owed(debts, loans)[debts.indexOf(d)].owed;
        await setSetting(env.DB, 'debts', JSON.stringify(debts));
        await send(env, `${owedText(owed(debts, loans)[debts.indexOf(d)], eur)}\nTap 🤝 Loan on a payment to them and it counts down.`);
        return;
      }
      const list = owed(debts, loans);
      await send(env, list.length ? list.map((o) => owedText(o, eur)).join('\n') : 'You don’t owe anyone. Add a loan: /owe Mom 100');
      return;
    }
    case '/gaps':
      await setSetting(env.DB, 'gaps', arg === 'off' ? 'off' : 'on');
      await send(env, arg === 'off' ? 'OK, I won’t flag unexplained balance changes.' : 'OK, I’ll flag unexplained balance changes.');
      return;
  }

  // The answer to "➕ What was it?": a reply to that question, or (for 15 minutes) any text without a number.
  const pending = JSON.parse((await getSetting(env.DB, 'pending_category')) ?? 'null') as { msg: number; n: number; at: number } | null;
  if (pending && (m.reply_to_message?.message_id === pending.msg || (!/\d/.test(text) && Date.now() - pending.at < 15 * 60_000))) {
    const t = await getTx(env.DB, pending.n);
    try {
      if (t) await applyChoice(env, t, { newCategory: text });
    } catch (e) {
      if (!(e instanceof BadInput)) throw e;
      await send(env, e.message);
      return;
    }
    await deleteSetting(env.DB, 'pending_category');
    for (const id of [pending.msg, m.message_id]) await tg(env, 'deleteMessage', { chat_id: env.CHAT_ID, message_id: id }); // keep the chat tidy
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
      const cats = await getCategories(env.DB);
      await edit(env, q.message.message_id, txText(t, await footerFor(env, t), cats), txKeyboard(t, true, await debtNames(env.DB), cats));
      await answer();
    } else if (action === 'c') {
      await applyChoice(env, { ...t, tg_msg: q.message.message_id }, { category: value });
      await answer(`${(await getCategories(env.DB))[value]}. Next time ${who} goes there automatically.`);
    } else if (action === 'k') {
      await applyChoice(env, { ...t, tg_msg: q.message.message_id }, { kind: value });
      await answer(value === 'podmoga' ? 'Passed on: only the net of in minus out counts.' : value === 'loan' ? 'Loan: it changes what you owe, not your spending.' : `${KINDS[value as keyof typeof KINDS]}. I’ll remember this for ${who}.`);
    } else if (action === 'a') {
      await applyChoice(env, { ...t, tg_msg: q.message.message_id }, t.kind === 'spend' ? { category: t.category ?? undefined } : { kind: t.kind });
      await answer('Approved');
    } else if (action === 'n') {
      const ask = await tg<{ message_id: number }>(env, 'sendMessage', {
        chat_id: env.CHAT_ID,
        text: 'What was it? Type a name, e.g. 🎮 Games',
        reply_markup: { force_reply: true, input_field_placeholder: '🎮 Games' },
      });
      if (ask) await setSetting(env.DB, 'pending_category', JSON.stringify({ msg: ask.message_id, n: t.n, at: Date.now() }));
      await answer();
    } else if (action === 'b') {
      const name = (await debtNames(env.DB))[Number(value)];
      await applyChoice(env, { ...t, tg_msg: q.message.message_id }, { debt: name });
      await answer(t.source === 'bmail' ? `Paying back ${name}. Next time ${who} counts toward it automatically.` : `Paying back ${name}.`);
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
