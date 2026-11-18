// SlowTrend: a slow EMA-crossover swing bot for the cbBTC 1-minute race.
//
// Idea: on 1-minute bars the round trip costs ~26 bps (4 bps fee + 2 bps
// slippage + ~7 bps of price impact per leg at full size), while a single
// minute moves ~7 bps of noise. Fast signals therefore bleed out in fees.
// This bot only trades multi-hour trends: it buys when a 60-bar EMA crosses
// above a 240-bar EMA and sells when it crosses back, with hard take-profit /
// stop-loss rails and a trailing exit as safety nets. On the published dev
// window (a -2.8% day) it stays in cash through the opening drop, rides the
// mid-day recovery, and steps out on the cross back: few trades, small
// drawdown, positive net PnL after every fee.
//
// Rules, per bar close (fills land at the next bar's open):
//   - Indicators: EMA(60) and EMA(240) over closes, each seeded as the mean
//     of its first span of closes, then 2 / (span + 1) of the way to each
//     new close. Float64 only: the same bars give the same orders, run after
//     run. No clock, no randomness, no network.
//   - Entry (flat): EMA(60) crosses above EMA(240) -> buy with all cash.
//   - Exit (holding the whole position): EMA(60) crosses below EMA(240),
//     or the position is worth >= 1.5% over its cost (take profit), or
//     <= 1.0% under its cost (stop loss), or it peaked >= 2.0% over cost
//     and has since given back 0.8% from that peak (trailing exit), or it
//     has been held 1,440 bars (a full window, safety net only). After any
//     exit the bot waits 30 bars before re-entering, so it never chases a
//     whipsaw straight back in.
//   - Every order caps slippage at 100 bps past the close it was decided on,
//     so a fill into a liquidity gap is refused and retried next bar rather
//     than filled for almost nothing. Sells are sent before buys; at most one
//     open position is ever held (long only, no leverage).
//
// "SlowTrend 60/240" — built for make.fun btc-race-24h-20261118-1444.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 60;
const SLOW_SPAN = 240;
const MAX_SLIPPAGE_BPS = 100;
/** Take profit: position worth >= 1015/1000 of its cost. */
const TAKE_PROFIT_NUM = 1015n;
const TAKE_PROFIT_DEN = 1000n;
/** Stop loss: position worth <= 990/1000 of its cost. */
const STOP_LOSS_NUM = 990n;
const STOP_LOSS_DEN = 1000n;
/** Trailing exit arms once the position peaked >= 1020/1000 of its cost. */
const TRAIL_ARM_NUM = 1020n;
const TRAIL_ARM_DEN = 1000n;
/** ... and fires when the position falls to <= 992/1000 of that peak. */
const TRAIL_GIVEBACK_NUM = 992n;
const TRAIL_GIVEBACK_DEN = 1000n;
/** Safety net only: never hold longer than a full window. */
const MAX_HOLD_BARS = 1440;
/**
 * Cooldown after any exit: do not re-enter for this many bars, so a
 * stop-loss or cross-down exit is not chased straight back into the same
 * whipsaw. A fresh trend needs a new cross-up after the pause anyway.
 */
const REENTRY_COOLDOWN_BARS = 30;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** fast - slow after the previous bar, once both EMAs are set. */
  gap: number | null;
  /** fast - slow after this bar. */
  now: number | null;
}

interface Held {
  /** Bars held since the buy filled (fills are reported on the next batch). */
  bars: number;
  /** Highest value the position reached, in quote units, since entry. */
  peak: bigint;
}

const series = new Map<string, Series>();
const held = new Map<string, Held>();
/** Last batch seq at which the symbol's position was exited, per symbol. */
const lastExit = new Map<string, number>();

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_SPAN, warm: [], value: null },
      slow: { span: SLOW_SPAN, warm: [], value: null },
      gap: null,
      now: null,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.fast, c);
  step(s.slow, c);
  s.gap = s.now;
  s.now = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  return s;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const crossUp = new Set<string>();
    const crossDown = new Set<string>();
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      const s = push(bar);
      fresh.add(bar.symbol);
      if (s.gap === null || s.now === null) continue;
      if (s.now > 0 && s.gap <= 0) crossUp.add(bar.symbol);
      if (s.now < 0 && s.gap >= 0) crossDown.add(bar.symbol);
    }

    // Warm-up batches build history only: no orders on them.
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const pos = state.positions.get(symbol);
      if (pos !== undefined) {
        // Track the position: bars held and peak value (at the bar's high).
        let h = held.get(symbol);
        const valueNow = state.value(symbol, pos.qty);
        const valueHigh = state.value(symbol, pos.qty, BigInt(state.latest.get(symbol)!.h));
        if (h === undefined) {
          h = { bars: 0, peak: valueHigh };
          held.set(symbol, h);
        } else {
          h.bars += 1;
          if (valueHigh > h.peak) h.peak = valueHigh;
        }
        const cost = pos.cost;
        const takeProfit = valueNow * TAKE_PROFIT_DEN >= cost * TAKE_PROFIT_NUM;
        const stopLoss = valueNow * STOP_LOSS_DEN <= cost * STOP_LOSS_NUM;
        const trailArmed = h.peak * TRAIL_ARM_DEN >= cost * TRAIL_ARM_NUM;
        const trailFired = trailArmed && valueNow * TRAIL_GIVEBACK_DEN <= h.peak * TRAIL_GIVEBACK_NUM;
        const timedOut = h.bars >= MAX_HOLD_BARS;
        if (crossDown.has(symbol) || takeProfit || stopLoss || trailFired || timedOut) {
          sells.push({ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          held.delete(symbol);
          lastExit.set(symbol, state.seq);
        }
      } else {
        held.delete(symbol);
        const cooledDown = (lastExit.get(symbol) ?? -1e9) + REENTRY_COOLDOWN_BARS <= state.seq;
        if (crossUp.has(symbol) && cooledDown) entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const minNotional = BigInt(fees.min_notional_quote_units);
    let cash = state.cash;
    for (const symbol of entries) {
      if (orders.length >= caps.max_orders_per_bar) break;
      // One position at most; buy with all cash (capped at 100% of equity).
      let slice = cash;
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / 10000n;
      if (slice > byWeight) slice = byWeight;
      if (slice < minNotional) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
    }
    return orders;
  },
});
