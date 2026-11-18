# SlowTrend 60/240 — BTC trading bot

Entry for make.fun **btc-race-24h-20261118-1444** — "Race a BTC trading bot
live for 24 hours" ($250 USDC, bars-replay/v1).

## Strategy

A slow EMA-crossover swing bot trading Coinbase Wrapped BTC (cbBTC) against
USDC on 1-minute bars, starting with $1,000 of paper money.

A full-size round trip costs ~26 bps (4 bps fee + 2 bps slippage + ~7 bps of
price impact per leg), while a single minute moves ~7 bps of noise — so fast
signals bleed out in fees. This bot only trades multi-hour trends:

- **Indicators:** EMA(60) and EMA(240) over closes, each seeded as the mean
  of its first span of closes.
- **Entry:** EMA(60) crosses above EMA(240) → buy with all cash.
- **Exit (whole position):** EMA(60) crosses below EMA(240), or take profit
  at +1.5% over cost, stop loss at −1.0%, a trailing exit (armed at +2.0%,
  fires after a 0.8% giveback from the peak), or 1,440 bars held.
- **Cooldown:** 30 bars after any exit before re-entering, so a whipsaw is
  never chased straight back in.
- Every order caps slippage at 100 bps past the close it was decided on.
  Long only, one open position, no leverage, no clock, no randomness —
  the same bars always give the same orders.

## Local grade (dev window, kit's `grade-local`)

- **Net PnL: +$7.21** (return +0.72%) — passes the dev gate (needs > $0)
- Max drawdown 0.78%, 4 trades, 2 round trips
- Net PnL at 2× fees: +$5.60 (still positive)
- Buy-and-hold on the same window: −2.80%

## Run

The grader runs `node /bot/main.ts` (Node 22, erasable TypeScript only).
`vendor/makefun-bars.ts` is a byte-identical copy of the kit's SDK shim.

## License

MIT
