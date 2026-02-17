# Forward Testing Deployment Guide

This document explains how to deploy and run TradeHub's forward tester
against a MetaTrader 5 demo account.

---

## Prerequisites

1. **MetaTrader 5 Terminal** installed and running on Windows.
2. **Demo account** credentials from your broker (e.g., FxPro, IC Markets).
3. **Python 3.11+** with TradeHub installed (`pip install -e .` or `poetry install`).
4. **MetaTrader5 Python package** (`pip install MetaTrader5`).

---

## Step-by-step Setup

### 1. Create a Demo Account

Sign up with a broker that supports MT5 — e.g., [FxPro](https://www.fxpro.com/), 
[IC Markets](https://www.icmarkets.com/).  Note your:

- **Login** (numeric account ID)
- **Password**
- **Server** (e.g., `FxPro-MT5 Demo`)

### 2. Configure the Deployment

Edit `config/forward_test.yaml` (copy from `config/forward_test.example.yaml`):

```yaml
deployments:
  - account:
      login: YOUR_ACCOUNT_ID          # e.g., 590990731
      password: "YOUR_PASSWORD"        # e.g., "abc123"
      server: "YOUR_BROKER_SERVER"     # e.g., "FxPro-MT5 Demo"
      initial_balance: 10000
      label: "Strategy Candidate #1"

    # Point to an optimizer output or define inline:
    strategy_config: "reports/optimize/YYYYMMDD_HHMMSS/rank1_config.yaml"

    instruments:
      - EURUSD
      - GBPUSD
      - USDJPY
    scan_interval_seconds: 60
    risk_per_trade_pct: 0.01
    max_concurrent_trades: 2
```

> **IMPORTANT**: Never commit real passwords. The `.gitignore` excludes
> `config/forward_test.yaml`.  Use the `.example.yaml` template for
> version control.

### 3. Start the MT5 Terminal

The MetaTrader5 Python package communicates with the terminal process.
Ensure `terminal64.exe` is running before starting the forward tester.

### 4. Run the Forward Tester (Console Mode)

```powershell
python -m tradehub forward --config config/forward_test.yaml
```

This will:
1. Connect to each demo account listed in the YAML.
2. Continuously fetch M1/M5 data every `scan_interval_seconds`.
3. Detect patterns and place trades automatically.
4. Log all activity to `logs/tradehub_service.log`.

Press **Ctrl+C** to stop gracefully.

### 5. Run as a Windows Service (Optional)

To keep the forward tester running 24/7:

```powershell
pip install pywin32

python -m tradehub service install    # Install the service
python -m tradehub service start      # Start
python -m tradehub service stop       # Stop
python -m tradehub service remove     # Uninstall
```

The service uses `config/forward_test.yaml` by default.

---

## Multiple Strategy Candidates

To compare strategies in forward testing, use **separate demo accounts**
(one per strategy).  Add additional deployments to `forward_test.yaml`:

```yaml
deployments:
  - account:
      login: 590990731
      ...
    strategy_config: "reports/optimize/20260215/rank1_config.yaml"
    instruments: [EURUSD, GBPUSD]

  - account:
      login: 590990732        # different account!
      ...
    strategy_config: "reports/optimize/20260215/rank2_config.yaml"
    instruments: [EURUSD, GBPUSD]
```

Each deployment runs in its own thread.

---

## Monitoring

While running in console mode, the tester prints status every 30 seconds:

```
Account 590990731: balance=$10,045.23  trades=5  running=True
```

All trades are logged to `logs/tradehub_service.log`.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `MT5 init failed` | Ensure MT5 terminal is running |
| `MT5 login failed` | Check credentials and server name |
| `MetaTrader5 not installed` | `pip install MetaTrader5` |
| `pywin32 is required` | `pip install pywin32` (for service mode only) |
| No trades placed | Check trend/pattern settings, ensure market is open |
| `Duplicate demo account logins` | Each strategy needs its own account |

---

## Security Notes

- **Never commit** `config/forward_test.yaml` with real credentials.
- The `.gitignore` already excludes it.
- Use `config/forward_test.example.yaml` as a template.
- For CI/CD, pass credentials via environment variables or secrets managers.
