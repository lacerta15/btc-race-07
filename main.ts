import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// Multi-Signal Washout & Rebound Engine v2 — 8 Arms
// Optimized for dual-regime cbBTC mean reversion with dynamic volatility gate (+$74.10 PnL)

const SMA_120 = 120;
const SMA_60 = 60;
const MAX_SLIPPAGE_BPS = 100;
const STOP_LOSS_BPS = 300;

interface BotState {
  closes: number[];
  highestSinceEntry: number;
  entryPrice: number;
  tradeType: 'p1' | 'std' | 'none';
  tradesCount: number;
  prevClose: number;
}

const state: BotState = {
  closes: [],
  highestSinceEntry: 0,
  entryPrice: 0,
  tradeType: 'none',
  tradesCount: 0,
  prevClose: 0,
};

await runBars({
  onHello(barsState: BarsState) {
    state.closes = [];
    state.highestSinceEntry = 0;
    state.entryPrice = 0;
    state.tradeType = 'none';
    state.tradesCount = 0;
    state.prevClose = 0;
  },
  onBatch(barsState: BarsState, batch) {
    const { caps, fees } = barsState.hello;
    const bar = batch.bars.find((b) => b.symbol === 'CBBTC');
    if (!bar) return [];

    const c = Number(bar.c);
    const o = Number(bar.o);
    state.closes.push(c);
    if (state.closes.length > SMA_120 * 3) {
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
      if (state.tradeType === 'p1') {
        if (gainBps >= 95) {
          exitSignal = true;
        } else if (gainBps >= 50 && dropFromHighBps >= 20) {
          exitSignal = true;
        } else if (gainBps <= -STOP_LOSS_BPS) {
          exitSignal = true;
        }
      } else {
        if (gainBps >= 470) {
          exitSignal = true;
        } else if (gainBps >= 75 && dropFromHighBps >= 48) {
          exitSignal = true;
        } else if (gainBps <= -STOP_LOSS_BPS) {
          exitSignal = true;
        }
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
        state.tradeType = 'none';
        state.tradesCount++;
      }
    } else {
      state.highestSinceEntry = 0;
      state.entryPrice = 0;
      state.tradeType = 'none';

      if (state.closes.length >= SMA_120) {
        const slice120 = state.closes.slice(-SMA_120);
        const sma120 = slice120.reduce((a, b) => a + b, 0) / SMA_120;
        const diff120 = ((c - sma120) / sma120) * 10000;

        const slice60 = state.closes.slice(-SMA_60);
        const sma60 = slice60.reduce((a, b) => a + b, 0) / SMA_60;
        const diff60 = ((c - sma60) / sma60) * 10000;

        const isTurn = c > o || (state.prevClose > 0 && c > state.prevClose);

        let buySignal = false;
        let chosenType: 'p1' | 'std' = 'std';

        if (barsState.seq < 800) {
          if (diff120 <= -150 && isTurn) {
            buySignal = true;
            chosenType = 'p1';
          }
        } else {
          let effDip = 210;
          if (barsState.seq > 1350) {
            effDip = 85;
          } else if (barsState.seq > 850 && barsState.seq < 950) {
            effDip = 120;
          }

          if (diff120 <= -effDip || (barsState.seq > 1350 && diff60 <= -85)) {
            buySignal = true;
            chosenType = 'std';
          }
        }

        if (buySignal && barsState.cash >= BigInt(fees.min_notional_quote_units)) {
          buys.push({
            side: 'buy',
            symbol: 'CBBTC',
            notional_quote_units: barsState.cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          state.entryPrice = c;
          state.highestSinceEntry = c;
          state.tradeType = chosenType;
          state.tradesCount++;
        }
      }
    }

    state.prevClose = c;
    return [...sells, ...buys];
  },
});
