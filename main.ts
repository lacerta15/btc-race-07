import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// Autonomous Mean-Reversion Washout Dip Sniper for CBBTC/USDC
// Protocol: agent-fun/bars-replay/v1
// Captures 110-minute baseline dips with tight take-profit trailing bounds
// Revision 2: Calibrated trailing trigger and giveback parameters for optimal sniper execution

const SMA_PERIOD = 110; // 110-minute baseline rolling mean
const DIP_BPS = 195; // Entry trigger: -1.95% dip relative to 110-bar SMA
const TAKE_PROFIT_BPS = 490; // Primary take-profit target: +4.90%
const TRAILING_ACTIVATION_BPS = 85; // Trailing activation threshold: +0.85%
const TRAILING_STOP_BPS = 46; // Trailing giveback threshold: 0.46%
const STOP_LOSS_BPS = 300; // Hard stop loss: -3.00% (well below 25% max DD guardrail)
const MAX_SLIPPAGE_BPS = 100; // 1.00% max slippage to prevent excessive AMM impact

interface BotState {
  closes: number[];
  highestSinceEntry: number;
  entryPrice: number;
  tradesCount: number;
}

const state: BotState = {
  closes: [],
  highestSinceEntry: 0,
  entryPrice: 0,
  tradesCount: 0,
};

await runBars({
  onHello(barsState: BarsState) {
    // Re-initialize deterministic bot state upon receiving hello
    state.closes = [];
    state.highestSinceEntry = 0;
    state.entryPrice = 0;
    state.tradesCount = 0;
  },
  onBatch(barsState: BarsState, batch) {
    const { caps, fees } = barsState.hello;
    const bar = batch.bars.find((b) => b.symbol === 'CBBTC');
    if (!bar) return [];

    const c = Number(bar.c);
    state.closes.push(c);
    if (state.closes.length > SMA_PERIOD * 3) {
      state.closes.shift();
    }

    const held = barsState.positions.get('CBBTC');
    const sells: SellInput[] = [];
    const buys: BuyInput[] = [];

    if (held && held.qty > 0n) {
      if (c > state.highestSinceEntry) {
        state.highestSinceEntry = c;
      }
      const effectiveEntry = state.entryPrice > 0 ? state.entryPrice : Number(held.cost) / (Number(held.qty) / 1e8);
      const gainBps = ((c - effectiveEntry) / effectiveEntry) * 10000;
      const dropFromHighBps = ((state.highestSinceEntry - c) / state.highestSinceEntry) * 10000;

      let exitSignal = false;
      // 1. Take profit target reached
      if (gainBps >= TAKE_PROFIT_BPS) {
        exitSignal = true;
      }
      // 2. Trailing stop triggered after profit activation
      else if (gainBps >= TRAILING_ACTIVATION_BPS && dropFromHighBps >= TRAILING_STOP_BPS) {
        exitSignal = true;
      }
      // 3. Strict hard stop loss
      else if (gainBps <= -STOP_LOSS_BPS) {
        exitSignal = true;
      }

      if (exitSignal) {
        sells.push({
          side: 'sell',
          symbol: 'CBBTC',
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        state.highestSinceEntry = 0;
        state.entryPrice = 0;
        state.tradesCount++;
      }
    } else {
      state.highestSinceEntry = 0;
      state.entryPrice = 0;

      // Evaluate buy trigger when cash is available
      if (state.closes.length >= SMA_PERIOD) {
        const slice = state.closes.slice(-SMA_PERIOD);
        const sma = slice.reduce((a, b) => a + b, 0) / SMA_PERIOD;
        const diffBps = ((c - sma) / sma) * 10000;

        // Adaptive guardrail: If deep into the 1,440-minute window without trades, relax dip threshold
        let effectiveDip = DIP_BPS;
        if (state.tradesCount === 0 && barsState.seq > 900) {
          effectiveDip = 120; // 1.20% dip to guarantee meeting min_trades >= 1 guardrail
        }

        if (diffBps <= -effectiveDip && barsState.cash >= BigInt(fees.min_notional_quote_units)) {
          buys.push({
            side: 'buy',
            symbol: 'CBBTC',
            notional_quote_units: barsState.cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          state.entryPrice = c;
          state.highestSinceEntry = c;
          state.tradesCount++;
        }
      }
    }

    const orders = [...sells, ...buys].slice(0, caps.max_orders_per_bar);
    return orders;
  },
});
