# Working on this repo

Personal finance tracker: Tatra banka b-mails → Gmail Apps Script → Cloudflare Worker + D1 → Telegram bot and Mini App dashboard. See README.md for the design and the money model.

## Do it yourself, then deploy

The owner wants you to do everything you can without asking, including deploying after every change. That permission is standing: never ask before pushing to `main` or deploying. The owner has said so explicitly ("stop asking my confirmation for deploys"). `.claude/settings.json` allows the deploy pushes; run each push as its own command so the rule matches.

If `main` has commits you didn't make (another session works on this repo too, e.g. `nation/`), merge them, review what they change, run the tests and deploy. Don't stop to ask.

After each change:

1. `npm ci` (if `node_modules` is missing), then `npm test` and `npm run typecheck`. For dashboard changes, also `npm run preview` and check `preview/out/index.html` with Playwright at 390×844 and 360×640.
2. Commit and push to your working branch.
3. Push the same commit to `main`: `git push origin HEAD:main`. If `main` has moved, merge it first and never force-push. Pushing to `main` runs `.github/workflows/deploy.yml`, which tests, migrates D1, deploys the Worker, uploads secrets and reconnects the bot.
4. Wait for that Deploy run to finish. The repo is public, so `curl -sS 'https://api.github.com/repos/popovnehuligan/money/actions/runs?per_page=1&event=push'` works, and so do the GitHub MCP `actions_*` tools. If it's red, read the logs, fix, and go back to step 1. Don't stop at a red deploy.
5. Check the live Worker:
   - `/app` returns 200;
   - `POST /tg` without the secret header returns 403;
   - `/api/summary` without initData returns 403.

Then report what changed and what you verified. Keep to-do lists for the owner short: only things that physically need them (see below).

## Live setup

- Worker: https://money.popovnehuligan.workers.dev, with a daily cron at 06:00 UTC.
- Bot: @liquid_assets_bot.
- D1 database: `money`. `wrangler.toml` keeps the `__D1_DATABASE_ID__` placeholder, and CI fills it in. Never commit the real id.
- GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_TOKEN`. They exist, but sessions can't read them, so deploys go through CI.
- Webhook secret and ingest key: derived from the bot token (`src/auth.ts`). Changing the token changes the Gmail script's key.

## Importing a bank statement (the owner's instructions)

The October 2026 statement will fill in what happened before b-mails started (2026-10-20 14:28):
- Import only movements before the first b-mail. Everything later is already stored; the b-mail balances reconcile to the cent.
- The owner approves every imported payment. Store each one unconfirmed with your suggested kind and category (rules and learned names first), then send it to Telegram so it shows ✅ with your suggestion. Never mark imported payments as confirmed yourself.
- Afterwards, resend the October wrap-up (the 1 November one only covered 20–31 October).

## Only the owner can

- Send `/start` to the bot. The first chat to do it becomes the owner.
- Install the Gmail Apps Script, from the link the bot sends.
- Turn on b-mail e-mails in the Tatra banka app.

## Rules

- The repo is public. Never commit tokens, real b-mails, IBANs, names or transaction data. Redact b-mail samples before they go into `test/parse.test.ts`.
- Keep tokens out of files. Pass them only as environment variables in a single command.
- Session proxy quirks:
  - The GitHub Actions secrets API is blocked.
  - URLs carrying `?key=` are refused, so send the key as `authorization: Bearer <key>` instead.
