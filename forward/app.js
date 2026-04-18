// ============================================================
// TradeHub Forward Testing Dashboard — app.js
// Reads forward_data.json and renders full interactive UI.
// ============================================================

const THEME_KEY = "tradehub-forward-theme";
const PALETTE   = ["--c0","--c1","--c2","--c3","--c4","--c5"];

// ── State ────────────────────────────────────────────────────
const state = {
  data:          null,
  filteredTrades: [],
  sortCol:       "entry_time",
  sortDir:       "desc",
  filterStrategy: "all",
  filterSymbol:   "all",
  filterDirection: "all",
  activeStrategy:  "all",
  theme:         localStorage.getItem(THEME_KEY) || "dark",
};

// Store for forward trades list — populated in renderTradeTable, used by modal event delegation
let _forwardTrades = [];

// Apply theme immediately to avoid flash
document.documentElement.dataset.theme = state.theme;

// ── Formatters ───────────────────────────────────────────────
const usd  = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const pct  = v => (v == null ? "n/a" : (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "%");
const r    = v => (v == null ? "n/a" : (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "R");
const fmt2 = v => (v == null ? "n/a" : Number(v).toFixed(2));

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function pnlColor(val) {
  if (val > 0) return cssVar("--good");
  if (val < 0) return cssVar("--danger");
  return cssVar("--ink-muted");
}

// ── Plot helper (matches monitoring site) ────────────────────
function plot(id, traces, extra = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor:  "rgba(0,0,0,0)",
    margin: { t: 8, r: 12, b: 40, l: 56 },
    hovermode: "closest",
    font: { color: cssVar("--ink-muted"), family: "Inter, Segoe UI, Arial, sans-serif", size: 12 },
    xaxis: { gridcolor: cssVar("--plot-grid"), linecolor: cssVar("--plot-grid"), tickfont: { color: cssVar("--ink-muted") } },
    yaxis: { gridcolor: cssVar("--plot-grid"), zerolinecolor: cssVar("--plot-grid"), tickfont: { color: cssVar("--ink-muted") } },
    legend: { orientation: "h", x: 0, y: 1.18, font: { color: cssVar("--ink-muted"), size: 11 } },
    ...extra,
  };
  Plotly.react(el, traces, layout, { responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d","select2d","autoScale2d","toImage"] });
}

// ── Boot ─────────────────────────────────────────────────────
// Append a cache-buster so the browser always fetches the latest JSON
// rather than serving a cached version.
fetch("forward_data.json?v=" + Date.now())
  .then(r => r.json())
  .then(data => {
    state.data = data;
    state.filteredTrades = data.trades ?? [];
    boot();
  })
  .catch(err => {
    document.getElementById("hero").innerHTML =
      `<div class="empty-state" style="width:100%">Failed to load forward data: ${esc(String(err))}<br>
       <small>Make sure forward_data.json is in the same directory.</small></div>`;
  });

// ── Theme toggle ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, state.theme);
    document.documentElement.dataset.theme = state.theme;
    if (state.data) renderCharts();
  });
});

window.addEventListener("resize", debounce(() => { if (state.data) renderCharts(); }, 120));

// ── Root boot ─────────────────────────────────────────────────
function boot() {
  renderHero();
  renderHeaderStatus();
  renderStrategyFilter();
  renderCharts();
  renderSymbolGrid();
  renderFilters();
  renderTradeTable();
  renderDeployments();
  renderFooter();
}

function renderCharts() {
  renderEquityChart();
  renderDailyChart();
  renderSymbolCharts();
}

// ── Header status ─────────────────────────────────────────────
function renderHeaderStatus() {
  const el = document.getElementById("header-status");
  if (!el) return;
  const { mode, generated_at } = state.data;
  const isLive  = mode === "live";
  const color   = isLive ? cssVar("--good") : cssVar("--warn");
  const label   = isLive ? "LIVE" : "DEMO";
  const ts      = generated_at ? new Date(generated_at).toUTCString().replace("GMT","UTC").slice(0,-4) : "";
  el.innerHTML  = `
    <span style="width:7px;height:7px;border-radius:50%;background:${color};display:inline-block;"></span>
    <span style="color:${color};font-weight:600">${esc(label)}</span>
    <span style="opacity:.6">· updated ${esc(ts)}</span>`;
}

// ── Hero ──────────────────────────────────────────────────────
function renderHero() {
  const el = document.getElementById("hero");
  if (!el) return;
  const d          = state.data;
  const isFiltered = state.activeStrategy !== "all";
  const s          = isFiltered ? (d.stats.by_strategy?.[state.activeStrategy] ?? d.stats) : d.stats;
  const mode       = d.mode;

  const chip = mode === "live"
    ? `<span class="meta-chip chip-live"><span class="chip-dot"></span>Live account</span>`
    : `<span class="meta-chip chip-dummy"><span class="chip-dot"></span>Demo / Synthetic</span>`;

  // Period: prefer deployed_at (exact deployment date) over period.start (was 90d back)
  const deployedAt = d.deployed_at ? d.deployed_at.slice(0, 10) : (d.period?.start ?? null);
  const periodEnd  = d.period?.end ?? null;
  let period;
  const hasTrades = (d.stats?.total_trades ?? 0) > 0;
  if (deployedAt && periodEnd && deployedAt === periodEnd && !hasTrades) {
    period = `Deployed ${deployedAt} (no closed trades yet)`;
  } else if (deployedAt && periodEnd) {
    period = `${deployedAt} \u2192 ${periodEnd}`;
  } else {
    period = deployedAt ? `Deployed ${deployedAt}` : "n/a";
  }

  const eyebrow  = isFiltered
    ? `Forward testing \u2014 ${state.activeStrategy}`
    : "Forward testing \u2014 all strategies";
  const headline = isFiltered
    ? `<em>${s.total_trades ?? 0}</em> trades \u00b7 ${esc(state.activeStrategy)}`
    : `<em>${s.total_trades}</em> trades forward deployed`;

  const pnlVal = s.total_pnl_usd ?? s.total_pnl ?? 0;
  const kpis = [
    { label: "Total trades",   value: s.total_trades ?? 0,            color: "" },
    { label: "Win rate",       value: fmt2(s.win_rate_pct) + "%",     color: (s.win_rate_pct ?? 0) >= 50 ? cssVar("--good") : cssVar("--warn") },
    { label: "Net PnL",        value: usd.format(pnlVal),             color: pnlColor(pnlVal) },
    { label: "Return",         value: pct(s.return_pct),              color: pnlColor(s.return_pct) },
    { label: "Profit factor",  value: fmt2(s.profit_factor),          color: (s.profit_factor ?? 0) >= 1.5 ? cssVar("--good") : cssVar("--warn") },
    { label: "Max drawdown",   value: fmt2(s.max_drawdown_pct) + "%", color: (s.max_drawdown_pct ?? 0) > 15 ? cssVar("--danger") : "" },
    { label: "Total R",        value: r(s.total_r),                   color: pnlColor(s.total_r) },
  ];

  const equityDisplay = isFiltered
    ? (s.initial_equity ?? d.stats?.initial_equity ?? 0)
    : (s.initial_equity ?? 0);

  el.innerHTML = `
    <div class="hero-text">
      <p class="eyebrow">${esc(eyebrow)}</p>
      <h1 class="hero-title">${headline}</h1>
      <div class="hero-meta">
        ${chip}
        <span>${esc(period)}</span>
        <span>$${esc(equityDisplay.toLocaleString())} starting equity</span>
      </div>
    </div>
    <div class="hero-kpis">
      ${kpis.map(k => `
        <div class="kpi-card">
          <span class="kpi-label">${esc(k.label)}</span>
          <span class="kpi-value" style="${k.color ? "color:" + k.color : ""}">${esc(String(k.value))}</span>
        </div>`).join("")}
    </div>`;
}

// ── Equity curve ──────────────────────────────────────────────
function renderEquityChart() {
  const d = state.data;

  if (state.activeStrategy === "all") {
    // Aggregate line + per-strategy dotted overlays
    const curve = d.equity_curve ?? [];
    const accentColor = cssVar("--c0");
    const traces = [{
      type: "scatter", mode: "lines",
      x: curve.map(p => p.time), y: curve.map(p => p.equity),
      line: { color: accentColor, width: 2.5 },
      fill: "tozeroy", fillcolor: accentColor + "18",
      hovertemplate: "<b>%{x}</b><br>Equity: %{y:$,.2f}<extra></extra>",
      name: "All strategies",
    }];

    const byStrat = d.stats?.by_strategy ?? {};
    Object.keys(byStrat).sort().forEach((name, i) => {
      const stratTrades = (d.trades ?? [])
        .filter(t => t.strategy === name)
        .sort((a, b) => a.exit_time < b.exit_time ? -1 : 1);
      if (!stratTrades.length) return;
      let eq = byStrat[name].initial_equity ?? d.stats.initial_equity ?? 10000;
      const pts = [{ x: stratTrades[0].entry_time, y: eq }];
      for (const t of stratTrades) {
        eq = Math.round((eq + (t.pnl_usd ?? 0)) * 100) / 100;
        pts.push({ x: t.exit_time, y: eq });
      }
      const col = cssVar(PALETTE[i % PALETTE.length]);
      traces.push({
        type: "scatter", mode: "lines",
        x: pts.map(p => p.x), y: pts.map(p => p.y),
        line: { color: col, width: 1.5, dash: "dot" },
        name,
        hovertemplate: `<b>${esc(name)}</b><br>%{x}<br>%{y:$,.2f}<extra></extra>`,
      });
    });

    plot("equity-chart", traces, { yaxis: { title: "Equity (USD)", tickprefix: "$" } });
  } else {
    // Single filtered strategy — compute equity from trades
    const name      = state.activeStrategy;
    const byStrat   = d.stats?.by_strategy ?? {};
    const stratIdx  = Object.keys(byStrat).sort().indexOf(name);
    const col       = cssVar(PALETTE[Math.max(0, stratIdx) % PALETTE.length]);
    const stratTrades = (d.trades ?? [])
      .filter(t => t.strategy === name)
      .sort((a, b) => a.exit_time < b.exit_time ? -1 : 1);

    let eq = byStrat[name]?.initial_equity ?? d.stats.initial_equity ?? 10000;
    const pts = stratTrades.length ? [{ x: stratTrades[0].entry_time, y: eq }] : [];
    for (const t of stratTrades) {
      eq = Math.round((eq + (t.pnl_usd ?? 0)) * 100) / 100;
      pts.push({ x: t.exit_time, y: eq });
    }

    const traces = pts.length ? [{
      type: "scatter", mode: "lines",
      x: pts.map(p => p.x), y: pts.map(p => p.y),
      line: { color: col, width: 2.5 },
      fill: "tozeroy", fillcolor: col + "18",
      hovertemplate: "<b>%{x}</b><br>%{y:$,.2f}<extra></extra>",
      name,
    }] : [];

    plot("equity-chart", traces, { yaxis: { title: "Equity (USD)", tickprefix: "$" } });
  }
}

// ── Daily PnL bar chart ───────────────────────────────────────
function renderDailyChart() {
  const d = state.data;
  let daily;
  if (state.activeStrategy === "all") {
    daily = d.stats?.daily_pnl ?? {};
  } else {
    daily = {};
    for (const t of (d.trades ?? []).filter(t => t.strategy === state.activeStrategy)) {
      const day = t.exit_time?.slice(0, 10);
      if (day) daily[day] = (daily[day] ?? 0) + (t.pnl_usd ?? 0);
    }
  }
  const days  = Object.keys(daily).sort();
  const vals  = days.map(d => daily[d]);
  const colors = vals.map(v => v >= 0 ? cssVar("--good") : cssVar("--danger"));
  const traces = [{
    type: "bar",
    x: days, y: vals,
    marker: { color: colors, opacity: 0.85 },
    hovertemplate: "<b>%{x}</b><br>P&L: %{y:+$,.2f}<extra></extra>",
    name: "Daily P&L",
  }];
  plot("daily-chart", traces, {
    yaxis: { title: "P&L (USD)", tickprefix: "$" },
    bargap: 0.25,
  });
}

// ── Strategy filter pills ─────────────────────────────────────
function renderStrategyFilter() {
  const el = document.getElementById("strategy-filter");
  if (!el) return;
  const byStrat = state.data.stats?.by_strategy ?? {};
  // Use traded strategies first; fall back to deployed_strategies list from payload
  const tradedStrats = Object.keys(byStrat).sort();
  const allKnown = state.data.deployed_strategies ?? [];
  const merged = [...new Set([...tradedStrats, ...allKnown])].sort();
  if (!merged.length) { el.innerHTML = ""; return; }

  const pills = ["all", ...merged];
  el.innerHTML = `
    <div class="strat-filter-inner">
      <span class="filter-label">Strategy</span>
      <div class="strat-pills">
        ${pills.map(s => {
          const cnt = byStrat[s]?.total_trades;
          const badge = (s !== "all" && cnt !== undefined)
            ? ` <span class="pill-count">${cnt}</span>` : "";
          return `
          <button class="strat-pill ${s === state.activeStrategy ? "active" : ""}"
                  data-strat="${esc(s)}">
            ${s === "all" ? "All strategies" : esc(s)}${badge}
          </button>`;
        }).join("")}
      </div>
    </div>`;

  el.querySelectorAll(".strat-pill").forEach(btn =>
    btn.addEventListener("click", () => applyStrategyFilter(btn.dataset.strat)));
}

function applyStrategyFilter(name) {
  state.activeStrategy = name;
  // Sync trade-table strategy dropdown
  const fStrat = document.getElementById("f-strat");
  if (fStrat) {
    fStrat.value = name;
    state.filterStrategy = name;
    applyFilters();
  }
  renderHero();
  renderStrategyFilter();   // update active pill
  renderCharts();
  renderSymbolGrid();
}

function statCard(label, value, color) {
  return `<div class="stat-card">
    <span class="eyebrow">${esc(label)}</span>
    <span class="stat-val" style="${color ? "color:" + color : ""}">${esc(String(value))}</span>
  </div>`;
}

// ── Symbol helpers ────────────────────────────────────────────
function _getBySymbol() {
  const d = state.data;
  if (state.activeStrategy === "all") return d.stats?.by_symbol ?? {};
  // Compute from filtered trades for this strategy
  const bySym = {};
  for (const t of (d.trades ?? []).filter(t => t.strategy === state.activeStrategy)) {
    const sym = t.symbol;
    if (!bySym[sym]) bySym[sym] = { trades: 0, wins: 0, total_pnl: 0, total_r: 0 };
    bySym[sym].trades++;
    if ((t.pnl_usd ?? 0) > 0) bySym[sym].wins++;
    bySym[sym].total_pnl += t.pnl_usd ?? 0;
    bySym[sym].total_r   += t.pnl_r   ?? 0;
  }
  for (const b of Object.values(bySym)) {
    b.win_rate  = b.trades > 0 ? Math.round(b.wins  / b.trades * 100) : 0;
    b.total_pnl = Math.round(b.total_pnl * 100) / 100;
    b.total_r   = Math.round(b.total_r   * 100) / 100;
  }
  return bySym;
}

// ── Symbol charts & grid ──────────────────────────────────────
function renderSymbolCharts() {
  const bySym = _getBySymbol();
  const syms  = Object.keys(bySym).filter(s => bySym[s].total_pnl).sort((a,b) => bySym[b].total_pnl - bySym[a].total_pnl);
  if (!syms.length) return;

  const pnls   = syms.map(s => bySym[s].total_pnl);
  const counts = syms.map(s => bySym[s].trades);

  plot("sym-pnl-chart", [{
    type: "bar",
    x: syms, y: pnls,
    marker: { color: pnls.map(v => v >= 0 ? cssVar("--good") : cssVar("--danger")), opacity: 0.85 },
    hovertemplate: "<b>%{x}</b><br>P&L: %{y:+$,.2f}<extra></extra>",
    name: "P&L",
  }], { yaxis: { tickprefix: "$" } });

  plot("sym-count-chart", [{
    type: "bar",
    x: syms, y: counts,
    marker: { color: cssVar("--c1"), opacity: 0.8 },
    hovertemplate: "<b>%{x}</b><br>Trades: %{y}<extra></extra>",
    name: "Trades",
  }]);
}

function renderSymbolGrid() {
  const grid   = document.getElementById("sym-grid");
  if (!grid) return;
  const bySym  = _getBySymbol();
  const syms   = Object.keys(bySym).sort((a, b) => (bySym[b].total_pnl ?? 0) - (bySym[a].total_pnl ?? 0));

  grid.innerHTML = syms.map(sym => {
    const s   = bySym[sym];
    const col = pnlColor(s.total_pnl);
    return `<div class="sym-card">
      <span class="sym-name">${esc(sym)}</span>
      <span class="sym-stat">${esc(s.trades)} trades · ${esc(fmt2(s.win_rate))}% WR</span>
      <span class="sym-pnl" style="color:${col}">${usd.format(s.total_pnl)}</span>
      <span class="sym-stat">${r(s.total_r)}</span>
    </div>`;
  }).join("");
}

// ── Trade filters ─────────────────────────────────────────────
function renderFilters() {
  const el   = document.getElementById("trade-filters");
  if (!el) return;
  const trades   = state.data.trades ?? [];
  const strats   = [...new Set(trades.map(t => t.strategy))].sort();
  const symbols  = [...new Set(trades.map(t => t.symbol))].sort();

  el.innerHTML = `
    <div class="filter-group">
      <label>Strategy</label>
      <select id="f-strat">
        <option value="all">All strategies</option>
        ${strats.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
      </select>
    </div>
    <div class="filter-group">
      <label>Symbol</label>
      <select id="f-sym">
        <option value="all">All symbols</option>
        ${symbols.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
      </select>
    </div>
    <div class="filter-group">
      <label>Direction</label>
      <select id="f-dir">
        <option value="all">Buy &amp; sell</option>
        <option value="buy">Buy only</option>
        <option value="sell">Sell only</option>
      </select>
    </div>
    <span class="filter-count" id="trade-count"></span>`;

  // Seed strategy dropdown from the global activeStrategy pill
  const fStrat = document.getElementById("f-strat");
  if (fStrat && state.activeStrategy !== "all") {
    fStrat.value = state.activeStrategy;
    state.filterStrategy = state.activeStrategy;
  }

  fStrat.addEventListener("change", e => {
    state.filterStrategy  = e.target.value;
    // Keep strategy pill in sync when dropdown changes independently
    state.activeStrategy  = e.target.value;
    renderStrategyFilter();
    renderHero();
    renderCharts();
    renderSymbolGrid();
    applyFilters();
  });
  document.getElementById("f-sym").addEventListener("change",   e => { state.filterSymbol    = e.target.value; applyFilters(); });
  document.getElementById("f-dir").addEventListener("change",   e => { state.filterDirection = e.target.value; applyFilters(); });

  applyFilters();
}

function applyFilters() {
  const all = state.data.trades ?? [];
  state.filteredTrades = all.filter(t =>
    (state.filterStrategy  === "all" || t.strategy  === state.filterStrategy) &&
    (state.filterSymbol    === "all" || t.symbol    === state.filterSymbol)   &&
    (state.filterDirection === "all" || t.direction === state.filterDirection)
  );
  renderTradeTable();
  const cnt = document.getElementById("trade-count");
  if (cnt) cnt.textContent = `${state.filteredTrades.length} of ${all.length} trades`;
}

// ── Trade table ───────────────────────────────────────────────
const COL_DEFS = [
  { key: "id",           label: "#",        fmt: v => v },
  { key: "symbol",       label: "Symbol",   fmt: v => `<strong>${esc(v)}</strong>` },
  { key: "strategy",     label: "Strategy", fmt: v => esc(v) },
  { key: "direction",    label: "Dir",      fmt: v => `<span class="badge badge-${esc(v)}">${esc(v).toUpperCase()}</span>` },
  { key: "entry_time",   label: "Entry",    fmt: v => esc(v?.replace("T"," ")) },
  { key: "exit_time",    label: "Exit",     fmt: v => esc(v?.replace("T"," ")) },
  { key: "entry_price",  label: "Entry px", fmt: v => fmt2(v) },
  { key: "exit_price",   label: "Exit px",  fmt: v => fmt2(v) },
  { key: "lots",         label: "Lots",     fmt: v => v },
  { key: "pnl_usd",      label: "P&L (USD)", fmt: v => `<span class="${v >= 0 ? "td-win" : "td-loss"}">${usd.format(v)}</span>` },
  { key: "pnl_r",        label: "R",        fmt: v => `<span class="${v >= 0 ? "td-win" : "td-loss"}">${r(v)}</span>` },
  { key: "exit_reason",  label: "Exit",     fmt: v => `<span class="badge badge-${esc(v)}">${esc(v)}</span>` },
];

function renderTradeTable() {
  const wrap = document.getElementById("trade-table-wrap");
  if (!wrap) return;
  const trades = [...state.filteredTrades].sort((a, b) => {
    const av = a[state.sortCol] ?? "";
    const bv = b[state.sortCol] ?? "";
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
    return state.sortDir === "asc" ? cmp : -cmp;
  });

  if (!trades.length) {
    wrap.innerHTML = `<p class="empty-state">No trades match the current filters.</p>`;
    return;
  }

  // Store sorted list so event delegation can look up by index
  _forwardTrades = trades;

  const headerCells = COL_DEFS.map(c => {
    const cls = c.key === state.sortCol ? `sort-${state.sortDir}` : "";
    return `<th class="${cls}" data-col="${esc(c.key)}">${c.label}</th>`;
  }).join("");

  const rows = trades.map((t, i) =>
    `<tr class="trade-row" data-tidx="${i}">${COL_DEFS.map(c => `<td>${c.fmt(t[c.key])}</td>`).join("")}</tr>`
  ).join("");

  wrap.innerHTML = `
    <table>
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  wrap.querySelectorAll("th[data-col]").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortCol = col;
        state.sortDir = "desc";
      }
      renderTradeTable();
    });
  });
}

// ── Footer ────────────────────────────────────────────────────
function renderFooter() {
  const el = document.getElementById("footer");
  if (!el) return;
  const ts = state.data.generated_at
    ? new Date(state.data.generated_at).toUTCString().replace("GMT","UTC").slice(0,-4)
    : "n/a";
  el.innerHTML = `
    Generated ${esc(ts)} — <a href="../index.html">← TradeHub home</a>
    · <a href="../reports/monitoring/latest/index.html">Monitoring dashboard</a>`;
}

// ── Deployments section ───────────────────────────────────────
function renderDeployments() {
  const section = document.getElementById("deployments-section");
  const grid    = document.getElementById("deployments-grid");
  if (!section || !grid) return;

  const deps = state.data?.deployments ?? [];
  if (!deps.length) { section.style.display = "none"; return; }

  section.style.display = "";

  const fmtDate = iso => {
    if (!iso) return "unknown";
    try { return new Date(iso).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }); }
    catch { return String(iso).slice(0, 10); }
  };

  grid.innerHTML = deps.map(d => {
    const brokerLabel = d.broker === "mt5" ? "MetaTrader 5" : d.broker === "alpaca" ? "Alpaca" : esc(d.broker || "—");
    const typeLabel   = d.account_type === "demo" ? "Demo / Paper" : d.account_type === "live" ? "Live" : esc(d.account_type || "—");
    const typeColor   = d.account_type === "live" ? "var(--good)" : "var(--warn)";
    const broker      = (d.broker || "").toLowerCase();
    const instruments = (d.instruments ?? []).map(i => `<span class="dep-instrument">${esc(i)}</span>`).join("");
    const statusClass = d.status === "running" ? "dep-status-running" : d.status === "stale" ? "dep-status-stale" : "dep-status-unknown";
    const statusLabel = d.status === "running" ? "● Running" : d.status === "stale" ? "⚠ Stale" : "○ Unknown";

    return `
      <div class="dep-card dep-${broker}">
        <div class="dep-label">${esc(d.label || d.strategy || "—")}</div>
        <div class="dep-meta">
          <div class="dep-meta-row"><span class="dep-meta-key">Broker</span><span class="dep-meta-val">${brokerLabel}</span></div>
          <div class="dep-meta-row"><span class="dep-meta-key">Account</span><span class="dep-meta-val" style="font-family:monospace">${esc(d.account_id || "—")}</span></div>
          <div class="dep-meta-row"><span class="dep-meta-key">Type</span><span class="dep-meta-val" style="color:${typeColor};font-weight:600">${typeLabel}</span></div>
          ${d.server ? `<div class="dep-meta-row"><span class="dep-meta-key">Server</span><span class="dep-meta-val" style="font-size:.8rem">${esc(d.server)}</span></div>` : ""}
          <div class="dep-meta-row"><span class="dep-meta-key">Deployed</span><span class="dep-meta-val">${fmtDate(d.deployed_at)}</span></div>
        </div>
        ${instruments ? `<div class="dep-instruments">${instruments}</div>` : ""}
        <div class="dep-status ${statusClass}">${statusLabel}</div>
        ${d.vnc_url ? `<a href="${esc(d.vnc_url)}" target="_blank" rel="noopener noreferrer" class="dep-live-link">&#9654; View live terminal</a>` : ""}
      </div>`;
  }).join("");
}

// ── Trade Modal ───────────────────────────────────────────────
function openTradeModal(trade) {
  const modal = document.getElementById("trade-modal");
  if (!modal) return;

  const sym  = trade.symbol || trade.instrument || "—";
  const dir  = String(trade.direction || "").toLowerCase();
  const entX = String(trade.entry_time || "");
  const extX = String(trade.exit_time  || "");
  const entY = Number(trade.entry_price || trade.entry_px || 0);
  const extY = Number(trade.exit_price  || trade.exit_px  || 0);
  const sl   = Number(trade.sl || trade.stop_loss || 0);
  const tp   = Number(trade.tp || trade.take_profit || 0);
  const pnl  = Number(trade.pnl_usd || trade.pnl_net || 0);
  const isWin = pnl > 0;
  const exitReason = trade.exit_reason || "—";
  const lots = trade.lots ?? "—";
  const pnlR = trade.pnl_r != null ? `${pnl >= 0 ? "+" : ""}${Number(trade.pnl_r).toFixed(2)}R` : null;

  const pxFmt   = v => { const n = Number(v); return n < 10 ? n.toFixed(5) : n.toFixed(2); };
  const dirCol  = dir === "buy" ? cssVar("--good") : cssVar("--warn");
  const pnlCol  = isWin ? cssVar("--good") : cssVar("--danger");

  document.getElementById("modal-title").textContent = `${sym} — ${dir.toUpperCase()} trade`;

  const chipsEl = document.getElementById("modal-chips");
  chipsEl.innerHTML = [
    `<span class="modal-chip chip-${dir}">${dir.toUpperCase()}</span>`,
    `<span class="modal-chip chip-neutral">${esc(sym)}</span>`,
    `<span class="modal-chip chip-${isWin ? "win" : "loss"}">${pnl >= 0 ? "+" : ""}${usd.format(pnl)}</span>`,
    pnlR ? `<span class="modal-chip chip-neutral">${esc(pnlR)}</span>` : "",
    `<span class="modal-chip chip-${exitReason === "tp" ? "tp" : exitReason === "sl" ? "sl" : "neutral"}">${esc(exitReason)} exit</span>`,
  ].filter(Boolean).join("");

  const allY = [entY, extY, sl, tp].filter(v => v > 0);
  const yMin = Math.min(...allY) * 0.9997;
  const yMax = Math.max(...allY) * 1.0003;

  const traces = [
    { type: "scatter", mode: "lines",
      x: [entX, extX], y: [entY, extY],
      line: { color: pnlCol, width: 2.5, dash: "dot" },
      showlegend: false, hoverinfo: "skip" },
    { type: "scatter", mode: "markers+text",
      x: [entX], y: [entY],
      marker: { symbol: dir === "buy" ? "triangle-up" : "triangle-down", size: 16, color: dirCol },
      text: ["Entry"], textposition: "top center",
      textfont: { color: dirCol, size: 11 },
      showlegend: false,
      hovertemplate: `<b>Entry</b><br>Price: ${pxFmt(entY)}<br>Time: ${esc(entX.replace("T"," ").slice(0,19))}<extra></extra>` },
    { type: "scatter", mode: "markers+text",
      x: [extX], y: [extY],
      marker: { symbol: "x", size: 14, color: pnlCol, line: { width: 2 } },
      text: ["Exit"], textposition: "top center",
      textfont: { color: pnlCol, size: 11 },
      showlegend: false,
      hovertemplate: `<b>Exit</b><br>Price: ${pxFmt(extY)}<br>Time: ${esc(extX.replace("T"," ").slice(0,19))}<extra></extra>` },
  ];

  const shapes = [], annotations = [];
  if (sl > 0) {
    shapes.push({ type: "line", x0: entX, x1: extX, y0: sl, y1: sl,
      line: { color: "rgba(255,123,97,0.65)", width: 1.5, dash: "dash" } });
    annotations.push({ x: extX, y: sl, text: `SL ${pxFmt(sl)}`, showarrow: false,
      xanchor: "right", font: { size: 10, color: "rgba(255,123,97,0.85)" }, bgcolor: "rgba(0,0,0,0)" });
  }
  if (tp > 0) {
    shapes.push({ type: "line", x0: entX, x1: extX, y0: tp, y1: tp,
      line: { color: "rgba(111,217,143,0.65)", width: 1.5, dash: "dash" } });
    annotations.push({ x: extX, y: tp, text: `TP ${pxFmt(tp)}`, showarrow: false,
      xanchor: "right", font: { size: 10, color: "rgba(111,217,143,0.85)" }, bgcolor: "rgba(0,0,0,0)" });
  }

  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    margin: { t: 16, r: 90, b: 52, l: 70 },
    hovermode: "closest",
    font: { color: cssVar("--ink-muted"), size: 12, family: "Inter, Segoe UI, sans-serif" },
    xaxis: { type: "date", tickformat: "%Y-%m-%d %H:%M", tickangle: -25,
      gridcolor: cssVar("--plot-grid"), linecolor: cssVar("--plot-grid"),
      tickfont: { color: cssVar("--ink-muted"), size: 10 } },
    yaxis: { tickformat: entY < 10 ? ".5f" : ".2f",
      gridcolor: cssVar("--plot-grid"), zerolinecolor: cssVar("--plot-grid"),
      tickfont: { color: cssVar("--ink-muted"), size: 10 },
      range: [yMin, yMax] },
    shapes, annotations,
  };

  const el = document.getElementById("modal-chart");
  Plotly.react(el, traces, layout, { responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d","select2d","autoScale2d","toImage"] });

  const statsEl = document.getElementById("modal-stats");
  const msc = (label, val, color) =>
    `<div class="modal-stat-card">
       <span class="modal-stat-label">${esc(label)}</span>
       <span class="modal-stat-value" style="${color ? "color:"+color : ""}">${esc(String(val))}</span>
     </div>`;
  statsEl.innerHTML = [
    msc("Entry price", pxFmt(entY), ""),
    msc("Exit price",  pxFmt(extY), ""),
    sl > 0 ? msc("Stop loss",   pxFmt(sl), "var(--danger)") : "",
    tp > 0 ? msc("Take profit", pxFmt(tp), "var(--good)")   : "",
    msc("P&L", (pnl >= 0 ? "+" : "") + usd.format(pnl), pnlCol),
    pnlR ? msc("R multiple", pnlR, pnlCol) : "",
    lots !== "—" ? msc("Lots", lots, "") : "",
    msc("Entry time", String(entX || "—").replace("T"," ").slice(0,19), ""),
    msc("Exit time",  String(extX || "—").replace("T"," ").slice(0,19), ""),
    msc("Exit reason", exitReason, ""),
    trade.strategy ? msc("Strategy", trade.strategy, "") : "",
  ].filter(Boolean).join("");

  modal.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeTradeModal() {
  const modal = document.getElementById("trade-modal");
  if (modal) { modal.classList.remove("open"); document.body.style.overflow = ""; }
}

// Wire modal close button + backdrop click + Escape key
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("modal-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeTradeModal);
  const overlay = document.getElementById("trade-modal");
  if (overlay) overlay.addEventListener("click", e => { if (e.target === overlay) closeTradeModal(); });
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeTradeModal(); });

// Event delegation for clickable trade rows
document.addEventListener("click", e => {
  const row = e.target.closest(".trade-row");
  if (!row) return;
  const tidx = parseInt(row.dataset.tidx, 10);
  if (!isNaN(tidx) && _forwardTrades[tidx]) openTradeModal(_forwardTrades[tidx]);
});
