-- BetMaxx schema. All amounts are integer US cents; timestamps are epoch milliseconds.
-- RLS is enabled with NO policies on purpose: only the server (service_role key) can read or write.
-- Never expose the service_role key to the browser.

create table if not exists public.users (
  id text primary key,
  username text not null,
  salt text not null,
  hash text not null,
  balance bigint not null default 0 check (balance >= 0),
  deposited bigint not null default 0,
  wagered bigint not null default 0,
  created_at bigint not null,
  state jsonb not null default '{}'::jsonb   -- in-progress games (mines, hilo, blackjack, crash)
);

create table if not exists public.deposits (
  id text primary key,
  user_id text not null references public.users(id),
  coin text not null,
  usd bigint not null,
  status text not null,                       -- pending (waiting for payment) | detected (seen, waiting for confirmations) | confirmed | expired
  credited bigint not null default 0,         -- cents actually credited to the player
  address text,                               -- your wallet the player was told to send to
  txid text,                                  -- the on-chain payment that was matched (txid:output)
  units text,                                 -- exact amount expected, in the coin's smallest unit
  amount text,                                -- same amount as shown to the player (e.g. 50.37)
  expires bigint,                             -- the quoted amount is reserved until then
  confirmations int not null default 0,
  note text,
  created_at bigint not null,
  confirmed_at bigint
);
create index if not exists deposits_user_idx on public.deposits(user_id);

-- Payments that arrived at your wallets but matched no open deposit request (wrong amount, expired request, etc.).
create table if not exists public.unmatched_deposits (
  key text primary key,                       -- txid:output
  coin text not null,
  units text not null,
  amount text,
  seen_at bigint not null,
  status text not null default 'open',        -- open | resolved
  note text,
  resolved_user text,
  resolved_usd bigint
);

create table if not exists public.withdrawals (
  id text primary key,
  user_id text not null references public.users(id),
  coin text not null,
  address text not null,
  usd bigint not null,
  status text not null check (status in ('pending','sent','rejected')),
  txid text,
  note text,
  created_at bigint not null,
  decided_at bigint
);
create index if not exists withdrawals_status_idx on public.withdrawals(status);

create table if not exists public.sessions (
  token_hash text primary key,
  user_id text not null references public.users(id) on delete cascade,
  created_at bigint not null
);

create table if not exists public.bets (
  id text primary key,
  username text not null,
  game text not null,
  stake bigint not null,
  payout bigint not null,
  at bigint not null
);
create index if not exists bets_at_idx on public.bets(at desc);

-- Per-request support tables (the app is serverless, so rate limits and scan throttling live in Postgres)
create table if not exists public.rate_limits (
  key text not null,
  win bigint not null,
  n int not null default 0,
  at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  primary key (key, win)
);
create table if not exists public.kv (
  key text primary key,
  val bigint not null
);
-- two open deposit requests can never share the same exact amount
create unique index if not exists deposits_coin_units_uniq on public.deposits(coin, units) where units is not null;

alter table public.rate_limits enable row level security;
alter table public.kv enable row level security;
alter table public.users enable row level security;
alter table public.deposits enable row level security;
alter table public.withdrawals enable row level security;
alter table public.sessions enable row level security;
alter table public.bets enable row level security;
alter table public.unmatched_deposits enable row level security;

-- Convenience view for the payout team (open it in the Supabase Table Editor / SQL Editor).
create or replace view public.pending_withdrawals with (security_invoker = true) as
select w.id, u.username, w.coin, w.address,
       w.usd / 100.0 as usd,
       to_timestamp(w.created_at / 1000.0) as requested_at,
       u.deposited / 100.0 as total_deposited,
       u.wagered / 100.0 as total_wagered
from public.withdrawals w join public.users u on u.id = w.user_id
where w.status = 'pending'
order by w.created_at;
