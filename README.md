# Money

A personal finance tracker for one Tatra banka account. Card and Google Pay payments arrive in Telegram about a minute after you pay. You sort them with one tap, and a dashboard inside Telegram shows your daily allowance, pace, savings goal and where the money went. It runs entirely on free tiers: Cloudflare Workers + D1, Telegram, and Google Apps Script.

```
Tatra banka b-mail (e-mail) ──► Gmail ──► Apps Script, every minute (free)
                                 │   moves b-mails out of the inbox into the label "b-mail"
                                 ▼  POST /ingest
                    Cloudflare Worker + D1 database (free)
                     ├─ reads the b-mail, skips duplicates, reuses your past choices
                     ├─ Telegram message per payment, with buttons to sort it
                     ├─ every morning: "safe to spend today"; on the 1st: month wrap-up
                     └─ dashboard: a Telegram Mini App you can pin to your home screen
```

### The dashboard

The dashboard treats money as water. Scrolling down is diving deeper:

- **Today:** your allowance is a pool.
  - The number floats on the water and gets lighter as the day's money runs out, while the water turns from aqua to amber to coral.
  - Today's payments hang in the sky above, because that money has left the pool. Drag one into a category to sort it, or tap it to edit.
  - Touch the water to make ripples; in Telegram 8.0+ it sloshes when you tilt the phone.
- **The month:** one glass per day, filled with that day's spending by category. ✦ marks days with nothing spent, and a dripping glass was a big day. 📋 opens the month in review (below), and the caps of a challenge you took show here as they fill.
- **Where it went:** what came in, what was spent and what was saved, then spending by category and what you've kept from passed-on money so far.
- **Savings jar:** gold liquid with the goal date at your current pace, plus "leaks": what you marked 👎.
- **Every drop:** the full list, with filters.

One typeface (Geist) is used throughout.

Preview it with example data: `npm run preview`, then open `preview/out/index.html`.

## What counts as what

| Kind | Meaning | Counted as |
|---|---|---|
| 💸 Spend | normal spending (Google Pay, card, cash) | expense, by category |
| 💰 Income | salary, gifts | income |
| 🔁 Passed on | money you only pass on: podmoga jobs (300 € in, three people paid 50 € each), or a parent's money for a bill you pay | never income or spending. What you keep (+150 €) is a **running total** of everything in minus everything out, so a payout next month is no "loss" |
| 🤝 Loan | borrowing, or paying someone back | neither income nor spending; it changes what you owe (see below) |
| 🏦 Savings | moves to/from your savings account | "saved", never spending |
| 💵 Cash | cash out of an ATM, or cash paid in | nothing: what you spend from it counts when you type it in |
| 🚫 Ignore | moves between your own accounts | nothing |

Savings don't ask you anything: round-ups and other bank movements that are 🏦 Savings are stored as approved, without a chat message, and show up in the savings jar.

**Categories:** 🚕 Taxi · 🛴 Scooter · 🛒 Food · 🚬 Cigarettes · 🅿️ Parking · 🍺 Bar · 🚌 Bus · 🛍 Shopping · 💊 Health · 🏠 Home & bills · 📦 Other. If nothing fits, tap ➕ (Telegram) or ＋ New (dashboard) and type what it is, e.g. "🎮 Games". It becomes a category of its own, stored in the database (`categories` setting). In the chat every category is just its emoji, in one grid; only one whose emoji another category shares also shows its name.

You choose a kind or category once, in the chat or the dashboard. After that, payments to the same shop, IBAN or person are sorted the same way automatically. Bolt is told apart by its code: "BOLT.EU/O/…" and "BOLT.EU/P/…" are learned separately, so cabs and scooters don't get mixed up as long as Bolt bills them under different codes. Once a payment is sorted, its chat message collapses to a single "change" button. ATM withdrawals come with 💵 Cash suggested.

**Rules.** For people you pay for different things, a rule in the database's `rules` setting beats that memory. For example, `[{"match":["cafe hub"],"multipleOf":150,"max":900,"category":"eat"}]` sorts payments to "Cafe Hub" into 🍺 Bar when they are a multiple of 1.50 € and at most 9 €. Any other payment to them is left for you to sort. A rule can set a kind instead of a category, and `"quiet": true` stores what it sorts as approved, without a chat message. For example, `{"match":["pension fund"],"kind":"ignore","quiet":true}` handles an automatic pension payment you never want to be asked about. Rules live in the database, not in this public repo, because they contain names.

A rule with `passOnFrom` pairs someone else's money with the bill it pays, for example a parent who pays for your therapy: `{"match":["dr novak"],"passOnFrom":["parent's name"],"multipleOf":3500,"max":14000,"category":"health"}`. Every payment to the therapist is 🔁 Passed on, and so is money from the parent that fits the amounts (35 € a session, up to four); other money from them is sorted as usual. 35 € in and 35 € out leaves 0. A session you pay yourself lowers the running total, and the month in review says how much came from your own pocket. While you owe the parent money (a loan, see below), a session their money doesn't cover counts as 🤝 paying them back instead, until the loan is paid off.

**Month in review.** 📋 in the month view (and, early in a month, the button on the first screen) opens a review of that month:
- **Where to cut:** your biggest cuttable categories, each with what you could keep a month and how (taxi rides vs your scooter price, nights out, one purchase of cigarettes fewer a week, subscriptions charged twice, whatever you marked 👎).
- **To have money to spare:** what you took in and spent, and the income you'd need to keep 20 % at that spending, with and without the cuts.
- **Worth knowing:** where most income came from, nights out, the biggest day, days without spending, possible double charges, regrets, bills paid with passed-on money.
- **Next month's challenge:** a budget and a cap per category that add up to the cuts. "Take the challenge" sets them; every payment in a capped category then says how close you are, and the morning message shows all caps.
On the 1st, the bot sends the review's summary with a button that opens it.

**Missing movements.** b-mail doesn't report everything; Tatra banka says it skips transactions generated by its core system, such as fees and interest. When a b-mail includes your balance and the balance moved more than the payment explains, the bot adds an **"Unexplained balance change"** entry. Mark a −100 € gap as 🏦 Savings once, and the next −100 € gap is recognised as savings automatically. Turn this off with `/gaps off`.

**Loans.** Tell the bot what you owe with `/owe Mom 100`. The savings jar section then shows a "Paying back" bar, and each payment marked 🤝 Loan counts it down: "Mom: 60 € to go · 40 € of 100 € paid back". Once the database knows the lender's name as the bank shows it (the `match` list in the `debts` setting), payments to them are marked 🤝 Loan automatically until the loan is paid off. With more than one loan, a 🤝 Loan payment asks which one ("Mom or Ben?"). Picking one for a bank payment teaches that loan the counterparty's bank name, so the next payment to them sorts itself.

**Daily allowance.** Set a monthly budget in the dashboard (the ⚙ button) or with `/budget 600`. Each morning you get *(budget − spent so far) ÷ days left*, so a cheap day makes the following days bigger. Add a savings goal and the jar shows when you'll reach it at your current pace.

## ⚠️ Before relying on it

The b-mail parser (`src/parse.ts`) was written **without a real b-mail to look at**. A b-mail it can't read isn't lost: it is stored and shown in Telegram as "couldn't read". To fix it, take 3–5 real b-mails (a card payment, an incoming transfer and an outgoing transfer), redact the names and IBANs, and add them to `test/parse.test.ts`. Then adjust the parser until they pass.

This repository is **public**. It contains no personal data: transactions live only in your Cloudflare D1 database, and the bot token lives in GitHub/Cloudflare secrets. Never commit real b-mails without redacting them.

## Setup (about 15 minutes)

Only the first three steps need you; the deploy does the rest.

1. **Telegram**: talk to [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
2. **Cloudflare** (free account):
   - Open *Workers & Pages* once, so your `workers.dev` subdomain gets created.
   - My Profile → API Tokens → *Create token* using the "Edit Cloudflare Workers" template, then add the permission *Account → D1 → Edit*.
   - Copy your Account ID from the Workers overview page.
3. **GitHub** → this repo → Settings → Secrets and variables → Actions → add three secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `TELEGRAM_TOKEN`

   Then go to Actions → **Deploy** → *Run workflow* (it also runs on every push to `main`). The workflow then does the rest:
   - creates the database and its tables;
   - deploys the Worker;
   - connects the bot and its dashboard button;
   - prints your bot's link in the run summary.
4. **Telegram again**: open your bot and send `/start`. The first chat to do so becomes the owner; the bot ignores everyone else after that. It replies with a personal link to the Gmail script, already filled in with your Worker address and key.
5. **Gmail**: on a computer, open that link and copy everything.
   - Go to [script.google.com](https://script.google.com/home/projects/create) **while signed in to the Gmail that receives your b-mails**, paste it over the sample code and save.
   - Choose `install` in the function menu, press Run and allow access.
   - It forwards new e-mails from Tatra banka every minute. The ones read as payments move out of your inbox into the label **b-mail**, so they never clutter your normal view; anything else from the bank (statements, notices) stays in the inbox. In the background it also imports the last 180 days without pinging you.
   - If nothing arrives, check the sender of a real b-mail against `QUERY` at the top of the script.
6. **Tatra banka**: in the app go to Nastavenia → b-mail and turn on **e-mail** notifications to that Gmail for card payments, incoming payments and outgoing payments, with no minimum amount. As far as I could find, e-mail and push are free and SMS costs extra.

Optional secrets: `OWN_IBANS` (your own IBANs, comma-separated, so they're never taken as the other party) and `CHAT_ID` (pins the owner instead of using `/start`).

## Daily use

- Pay as usual. The Telegram message arrives about a minute later; tap a category, plus 👍/👎 if you like.
- Use the dashboard to:
  - sort several payments in a row (the "to sort" card);
  - fix any payment by tapping it. **✏️ Rename** gives it your own name (the bank's stays visible underneath), and entries you added yourself can also change amount and time;
  - add cash with the **Cash** button;
  - set your budget and savings goal with ⚙. Under **Categories**, rename a category by typing over it (start with an emoji to change its icon), add one, or delete one of yours.
- The chat and the dashboard stay in sync. A change in one shows in the other: cash added in the dashboard gets its chat message, and the dashboard picks up chat changes when you return to it and every 30 seconds.
- In the chat, `4.50 kava` adds cash and `+20 gift` adds money you received. Commands: `/today`, `/month`, `/month last`, `/budget 600`, `/owe` (or `/owe Mom 100`), `/gaps off`.

## Free-tier limits

- Workers: 100k requests/day.
- D1: 5 GB of storage.
- Apps Script: 20k URL fetches/day.

One person's payments use a tiny fraction of each.

## Development

```sh
npm install
npm test                      # parser, statistics, keyboards, dashboard model, Mini App auth
npm run typecheck
npm run preview               # dashboard with example data → preview/out/index.html
npm run db:local && npx wrangler dev   # local Worker with a local D1 (TELEGRAM_TOKEN in .dev.vars)
```
