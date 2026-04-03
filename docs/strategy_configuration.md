# Strategy Configuration Reference — komjathy.yaml

Complete parameter reference for `config/strategies/komjathy.yaml`.

## Top-Level Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `tp_ratio` | 1.0 | Take profit as multiple of SL distance (1.0 = 1:1 R:R) |
| `min_depth_atr` | 2.5 | Minimum formation depth as ATR multiple. Below 2.5: ~17% WR |
| `head_and_shoulders` | false | Enable H&S pattern detection (disabled: 0W/3L in testing) |
| `confirm_bars` | 3 | Bars of price confirmation above/below breakout level before entry |
| `news_filter_minutes` | 60 | Block entries within ±N minutes of high-impact news events |
| `trade_sessions_utc` | [[7, 21]] | Allowed entry hours in UTC. Asian (00-07) = ~50% WR |
| `risk_pct` | 0.01 | Account risk per trade (1% of balance) |
| `max_lots` | 100.0 | Hard cap on position size in lots |
| `leverage` | 30 | Leverage for margin calculation |

## Channel Parameters

```yaml
channel:
  min_total_touches: 8     # Minimum touchpoints on local channel lines
                           # Below 8: ~50% WR. Range 8-12 optimal.
  # Other channel scan params are in the scanner defaults
```

## Global Trend Channel Parameters

```yaml
global_trend_timeframes: [M5, M10, M15, M60]  # TFs to scan for macro trend channels
global_min_tf_agreement: 2     # Minimum TFs agreeing on same trend direction
global_max_opposing_tfs: -1    # -1 = disabled. Veto if >N TFs show opposing channel.
                               # Testing showed this hurts (blocked 66% WR trades)
global_channel:
  min_total_touches: 10        # Minimum touchpoints on global channel
```

## SuperTrend Overlay (Visual Only)

```yaml
supertrend:
  enabled: true
  period: 22
  multiplier: 3.0
  source: median    # 'median' or 'hlcc4'
  use_wicks: true
```

SuperTrend is rendered on trade charts as a visual overlay only.
**Not used as an entry filter** — testing showed ST filter removes winning reversals
because reversal patterns are inherently counter-trend.

## Pattern Parameters

```yaml
patterns:
  double_top: true
  double_bottom: true
  head_and_shoulders: false     # 0W/3L in challenge set, disabled
  inv_head_and_shoulders: true
```

## Proportion Filter

```yaml
max_fm_vs_local_ratio: 1.5   # Reject if formation depth > 1.5× local channel width
                              # Safety net for proportionally oversized formations
```

## Key Lessons from Experiments

### What Works
- **Session filter [7-21]**: +6pp WR, +$810 net vs no filter
- **min_depth_atr ≥ 2.5**: Patterns with dar<2.5 show 17% WR
- **Local touches ≥ 8**: Fewer touches = lower quality channels = lower WR
- **M60 in global TF list**: Adds consensus quality without removing many trades
- **confirm_bars = 3**: Sweet spot between false entries and missed moves

### What Doesn't Work
- **TP ratio 1.5**: WR drops 11.5pp — M1 patterns don't extend to 1.5× height
- **99/1% channel percentile**: Wider channels → fewer depth-qualified formations → 50% WR
- **ST flip exit**: Premature exits convert TP hits to losses (38.6% WR)
- **ST entry filter**: Removes winning reversals (strategy trades counter-trend by design)
- **M60 opposing TF veto**: Blocked 66% WR trades, net −$476

## Instrument Specs (FxPro CFD)

| Symbol | Contract | Pip Size | Pip Value | Spread Pips |
|--------|----------|----------|-----------|-------------|
| EURUSD, GBPUSD, etc | 100,000 | 0.0001 | $10.0 | 1.0–2.0 |
| USDJPY, EURJPY, etc | 100,000 | 0.01 | $6.7 | 1.0–2.0 |
| #USNDAQ100 | 1 | 0.01 | $0.01 | 120 |
| #US30 | 1 | 0.01 | $0.01 | 370 |
| BITCOIN | 1 | 0.01 | $0.01 | 5000 |

P&L formula: `pips × pip_value × lots` where `pips = price_move / pip_size`
Position sizing: `lots = risk_dollars / (sl_pips × pip_value)`
