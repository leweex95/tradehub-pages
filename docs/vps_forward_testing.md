# VPS Forward Testing

Deploy the **Komjathy Trend Reversal** strategy on a VPS for 24/7 forward
testing. Two routes exist depending on whether you use MT5 (Windows-only broker
client) or Alpaca (pure REST/WebSocket, runs on Linux without any GUI).

---

## MT5 vs Alpaca

| | MT5 | Alpaca |
|---|---|---|
| OS | **Windows required** (or Wine on Linux) | **Linux-native** — REST + WebSocket |
| Account type | Broker demo/live (forex, CFD, indices) | Paper / Live (US equities + crypto) |
| Symbols | Forex, indices, metals, crypto (broker-dependent) | US stocks, ETFs, crypto |
| Setup complexity | Higher (MT5 terminal must be running) | Lower (API key only) |
| Cost | Broker-provided (often free demo) | Free paper accounts |

**Choose MT5** when you need forex / CFD instruments (EURUSD, GBPUSD, XAUUSD, indices).  
**Choose Alpaca** when you want a zero-friction Linux deployment on US equities or crypto.

The Docker setup in `docker/` supports both — MT5 still needs the terminal on a
Windows host (or wine), while Alpaca works out-of-the-box on any Linux VPS.

---

## Architecture

```
VPS
├── Option A: Windows VPS
│   ├── MetaTrader 5 Terminal (native)
│   │   └── Demo account — Komjathy Trend Reversal
│   └── TradeHub forward tester (Python)
│       ├── Monitors M5 data via MT5 Python API
│       ├── Generates Komjathy signals
│       └── Places / manages trades automatically
│
└── Option B: Linux VPS
    ├── Docker container — tradehub-forward
    │   ├── Alpaca broker adapter (REST + WebSocket)
    │   └── Komjathy strategy (config/strategies/komjathy.yaml)
    └── No MT5 terminal needed (Alpaca is pure HTTP)
```

---

## Option A: Windows VPS (MT5 — Forex / CFD)

MT5 runs natively on Windows. Use this when you need forex, precious metals,
or index CFDs from your broker.

### Recommended Providers

| Provider | Plan | RAM | Cost/mo | Notes |
|----------|------|-----|---------|-------|
| Contabo VPS S | Windows | 8 GB | ~€9 | Cheapest Windows option |
| Hetzner CX22 | Windows | 4 GB | ~€9 | Great reliability, EU |
| ForexVPS.net | Pre-installed MT5 | 2 GB | ~$25 | Zero setup if MT5 is the goal |
| Vultr Cloud | Windows | 2 GB | ~$24 | More regions |

**Minimum specs:** 2 vCPU, 2 GB RAM, 20 GB SSD is enough for TradeHub.
Use 4 GB RAM if you plan to run the monitoring suite alongside forward testing.

### Setup Steps

1. Provision a Windows Server VPS (2019/2022) and RDP in.
2. Install MT5 from your broker (FxPro, IC Markets, etc.) and log in to a demo account.
3. Install Python 3.11+ and clone TradeHub:
   ```powershell
   git clone <repo> C:\tradehub
   cd C:\tradehub
   pip install -e .
   pip install MetaTrader5
   ```
4. Configure `config/forward/forward_test.yaml`:
   ```yaml
   deployments:
     - account:
         login: YOUR_DEMO_ACCOUNT_ID
         password: "your-password"
         server: "Broker-MT5 Demo"
       strategy_config: "config/strategies/komjathy.yaml"
       instruments:
         - EURUSD
         - GBPUSD
         - USDJPY
         - AUDUSD
         - USDCAD
         - USDCHF
         - EURGBP
         - EURJPY
         - GBPJPY
         - XAUUSD
         - "#USNDAQ100"
         - "#US30"
       scan_interval_seconds: 60
       risk_per_trade_pct: 0.01
       max_concurrent_trades: 3
   ```
5. Start the forward tester:
   ```powershell
   python -m tradehub forward --config config/forward/forward_test.yaml
   ```
6. (Optional) Install as a Windows Service for auto-restart on reboot:
   ```powershell
   pip install pywin32
   python -m tradehub service install
   python -m tradehub service start
   ```

---

## Option B: Linux VPS + Docker (Alpaca — US Equities / Crypto)

No MT5 terminal needed. Alpaca's Python SDK connects directly over REST and
WebSocket. This is the simplest fully-automated Linux deployment.

### Why Alpaca works on Linux

The `MetaTrader5` Python package requires Windows (or Wine). Alpaca uses a
standard REST API (`alpaca-trade-api` or `alpaca-py`) — no local client, no
GUI. You only need API keys stored in `config/credentials/brokers/alpaca.yaml`.

### Recommended Providers

| Provider | Plan | RAM | Cost/mo | Notes |
|----------|------|-----|---------|-------|
| Hetzner CX22 | Linux (Ubuntu) | 4 GB | ~€4 | Cheapest reliable option |
| DigitalOcean Droplet | Linux | 2 GB | ~$6 | Best docs for beginners |
| Vultr Cloud Compute | Linux | 2 GB | ~$6 | More regions, similar pricing |

**Minimum specs:** 2 vCPU, 2 GB RAM, 20 GB SSD.

### Setup Steps

```bash
# 1. SSH into VPS and install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Clone the repo
git clone <repo> ~/tradehub && cd ~/tradehub

# 3. Add Alpaca credentials
mkdir -p config/credentials/brokers
cat > config/credentials/brokers/alpaca.yaml <<EOF
paper:
  api_key: "YOUR_PAPER_KEY"
  api_secret: "YOUR_PAPER_SECRET"
  base_url: "https://paper-api.alpaca.markets"
EOF

# 4. Configure the deployment
cp config/forward_test.example.yaml config/forward/forward_test.yaml
# Edit config/forward/forward_test.yaml:
#   strategy_config: config/strategies/komjathy.yaml
#   broker: alpaca
#   account: paper

# 5. Build and start
docker compose -f docker/docker-compose.forward.yml up -d

# 6. Check logs
docker compose -f docker/docker-compose.forward.yml logs -f
```

### Keeping the Container Up

`docker-compose.forward.yml` already has `restart: unless-stopped`. The
container auto-restarts after reboots or crashes. To also start Docker on
boot:

```bash
sudo systemctl enable docker
```

### Handling Unreliable Connections

If the VPS loses connectivity mid-session, the forward engine should
reconnect automatically (the Alpaca WebSocket client retries on disconnect).
For extra resilience, use a wrapper that re-launches the container if it
exits unexpectedly:

```bash
# via systemd (preferred on modern Ubuntu/Debian)
sudo nano /etc/systemd/system/tradehub-forward.service
# Paste:
#   [Unit]
#   Description=TradeHub Forward Tester
#   After=docker.service
#   Requires=docker.service
#
#   [Service]
#   Restart=always
#   RestartSec=10
#   ExecStart=docker compose -f /home/<user>/tradehub/docker/docker-compose.forward.yml up
#   ExecStop=docker compose -f /home/<user>/tradehub/docker/docker-compose.forward.yml down
#
#   [Install]
#   WantedBy=multi-user.target

sudo systemctl daemon-reload
sudo systemctl enable --now tradehub-forward
```

---

## Symbol Selection

Based on backtest results for Komjathy Trend Reversal:

| Basket | Symbols |
|--------|---------|
| Core (forex) | EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF |
| Extended (forex) | + EURGBP, EURJPY, GBPJPY |
| Metals / Indices | XAUUSD, #USNDAQ100, #US30 |

JPY pairs historically had lower win rates in early development but are
included in the current `daily_regression.yaml` basket (9 symbols) —
monitor their contribution over the first 4 weeks.

---

## Monitoring Checklist (First 2 Weeks)

- [ ] Forward tester process is running (service status / docker ps)
- [ ] No error lines in `logs/tradehub_service.log`
- [ ] Trades being placed (MT5 Trade tab / Alpaca dashboard)
- [ ] Account balance tracking expectations
- [ ] MT5 terminal connected (Windows only — green icon in system tray)

---

## Risk Management

- Start at **1% risk per trade** ($100 on a $10K demo account).
- Run on demo for a **minimum 4 weeks** before considering live.
- If R/day falls below +0.3 for 2 consecutive weeks, pause and review.
- Never increase risk during active drawdown.

---

## Scaling to Live

After 4+ weeks of positive forward-test results:

1. Open a live micro account ($500–$1,000).
2. Use 0.5% risk per trade initially.
3. Scale to 1% after 2 weeks of consistent live profit.
