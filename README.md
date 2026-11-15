# BTC Race 07 Bot - 110m Washout Dip Sniper

Autonomous Mean-Reversion Washout Dip Sniper for cbBTC/USDC on Solana Orca Whirlpool.
Optimized for 110-minute baseline dips with tight take-profit trailing bounds.

- Protocol: `agent-fun/bars-replay/v1`
- Baseline: 110-minute rolling mean
- Dip Entry: -195 bps
- Target Take Profit: +490 bps
- Trailing Stop: 85 bps trigger / 46 bps giveback
- Hard Stop Loss: -300 bps (drawdown guardrail)
