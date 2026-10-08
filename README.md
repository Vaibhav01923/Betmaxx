# BetMaxx

Crypto casino: Next.js (static UI + serverless API) on Vercel, Postgres on Supabase.

- 12 games, server-side RNG: Dice, Limbo, Mines, Plinko, Keno, Crash, Coin Flip, HiLo, Blackjack, Roulette, Wheel, Slots
- **Deposits are automatic.** Each request gets an exact amount just under what the player asked for (e.g. `$50` -> `49.99641 USDT`). The watcher matches an on-chain payment of that exact amount to the request and credits it. Coins: BTC, LTC, USDT (TRC20 / ERC20 / BEP20).
- **Withdrawals are paid by hand.** Requests wait in `/admin.html`; your team sends the coins, then approves with the tx hash (or rejects, which refunds).
- Payments that match no request (wrong amount, expired quote) appear under "Unmatched payments" in `/admin.html`.

## Environment variables (Vercel -> Project -> Settings -> Environment Variables)

| Variable | What |
|---|---|
| `DATABASE_URL` | Supabase -> Connect -> **Transaction pooler** string, with the database password filled in |
| `PAYMENT_MODE` | `live` for real deposits, `demo` for fake addresses and a simulate button |
| `DEPOSIT_ADDR_BTC`, `_LTC`, `_USDTTRC20`, `_USDTERC20`, `_USDTBSC` | wallets you control. Empty = coin not offered |
| `ADMIN_TOKEN` | 16+ random chars, unlocks `/admin.html` |
| `CRON_SECRET` | 16+ random chars, protects `/api/cron/scan` |
| `MIN_DEPOSIT_USD`, `MIN_WITHDRAW_USD` | optional, defaults 1 and 5 |

Never put these in the repo. `.env` is gitignored.

## Run locally
```bash
npm install
cp .env.example .env   # fill it in
npm run dev            # http://localhost:3000
npm test               # API tests against an in-process Postgres
```
Database tables: run `supabase/schema.sql` in the Supabase SQL editor once.

## Deploy on Vercel
1. Push this repo to GitHub, then Vercel -> Add New Project -> import it (framework: Next.js, no build settings needed).
2. Add the environment variables above and deploy.
3. **Blockchain scan.** While a player waits on a deposit, the site checks the chain every few seconds on its own. To also catch payments after the player closes the tab, ping `/api/cron/scan` every minute. Free option using Supabase (replace the URL and secret):
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('betmaxx-scan', '* * * * *', $$
  select net.http_get(
    url := 'https://YOUR-SITE.vercel.app/api/cron/scan',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET')
  );
$$);
```
(Vercel's own cron is only daily on the free Hobby plan, which is why this uses Supabase.)

## Notes
- Deposit confirmations before crediting: BTC/LTC/TRC20 1, ERC20 6, BEP20 12.
- Max bet $500, max win per round $25,000.
- Running a real-money casino generally needs a gambling licence. Check your jurisdiction.
