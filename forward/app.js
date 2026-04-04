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
  activeStratTab: null,
  theme:         localStorage.getItem(THEME_KEY) || "dark",
};

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
fetch("forward_data.json")
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
  renderCharts();
  renderStratTabs();
  renderSymbolGrid();
  renderFilters();
  renderTradeTable();
  renderFooter();
}

function renderCharts() {
  renderEquityChart();
  renderDailyChart();
  renderSymbolCharts();
  // Redraw active strategy pane charts
  if (state.activeStratTab) renderStratPane(state.activeStratTab);
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
  const el   = document.getElementById("hero");
  if (!el) return;
  const d    = state.data;
  const s    = d.stats;
  const mode = d.mode;

  const chip  = mode === "live"
    ? `<span class="meta-chip chip-live"><span class="chip-dot"></span>Live account</span>`
    : `<span class="meta-chip chip-dummy"><span class="chip-dot"></span>Demo / Synthetic</span>`;
  const period = `${d.period?.start ?? "n/a"} → ${d.period?.end ?? "n/a"}`;

  const kpis = [
    { label: "Total trades",   value: s.total_trades,            color: "" },
    { label: "Win rate",       value: fmt2(s.win_rate_pct) + "%", color: s.win_rate_pct >= 50 ? cssVar("--good") : cssVar("--warn") },
    { label: "Net PnL",        value: usd.format(s.total_pnl_usd), color: pnlColor(s.total_pnl_usd) },
    { label: "Return",         value: pct(s.return_pct),          color: pnlColor(s.return_pct) },
    { label: "Profit factor",  value: fmt2(s.profit_factor),      color: s.profit_factor >= 1.5 ? cssVar("--good") : cssVar("--warn") },
    { label: "Max drawdown",   value: fmt2(s.max_drawdown_pct) + "%", color: s.max_drawdown_pct > 15 ? cssVar("--danger") : "" },
    { label: "Total R",        value: r(s.total_r),               color: pnlColor(s.total_r) },
  ];

  el.innerHTML = `
    <div class="hero-text">
      <p class="eyebrow">Forward testing — all strategies</p>
      <h1 class="hero-title"><em>${s.total_trades}</em> trades forward deployed</h1>
      <div class="hero-meta">
        ${chip}
        <span>${esc(period)}</span>
        <span>$${esc(s.initial_equity?.toLocaleString())} starting equity</span>
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
  const curve = state.data.equity_curve ?? [];
  const xs = curve.map(p => p.time);
  const ys = curve.map(p => p.equity);
  const accentColor = cssVar("--c0");
  const traces = [{
    type: "scatter",
    mode: "lines",
    x: xs, y: ys,
    line: { color: accentColor, width: 2.5 },
    fill: "tozeroy",
    fillcolor: accentColor + "18",
    hovertemplate: "<b>%{x}</b><br>Equity: %{y:$,.2f}<extra></extra>",
    name: "Equity",
  }];
  plot("equity-chart", traces, {
    yaxis: { title: "Equity (USD)", tickprefix: "$" },
  });
}

// ── Daily PnL bar chart ───────────────────────────────────────
function renderDailyChart() {
  const daily = state.data.stats?.daily_pnl ?? {};
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

// ── Strategy tabs ─────────────────────────────────────────────
function renderStratTabs() {
  const byStrat = state.data.stats?.by_strategy ?? {};
  const strats  = Object.keys(byStrat).sort();
  if (!strats.length) return;

  state.activeStratTab = strats[0];

  const bar   = document.getElementById("strat-tabs");
  const panes = document.getElementById("strat-panes");
  if (!bar || !panes) return;

  bar.innerHTML = strats.map(s => `
    <button class="tab-btn ${s === state.activeStratTab ? "active" : ""}"
            role="tab" data-strat="${esc(s)}">${esc(s)}</button>`).join("");

  panes.innerHTML = strats.map(s => `
    <div class="tab-pane ${s === state.activeStratTab ? "active" : ""}"
         id="strat-pane-${esc(s)}"></div>`).join("");

  bar.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = btn.dataset.strat;
      state.activeStratTab = s;
      bar.querySelectorAll(".tab-btn").forEach(b =>
        b.classList.toggle("active", b === btn));
      panes.querySelectorAll(".tab-pane").forEach(p =>
        p.classList.toggle("active", p.id === `strat-pane-${s}`));
      renderStratPane(s);
    });
  });

  renderStratPane(state.activeStratTab);
}

function renderStratPane(name) {
  const pane = document.getElementById(`strat-pane-${name}`);
  if (!pane) return;

  const byStrat = state.data.stats?.by_strategy ?? {};
  const s       = byStrat[name];
  if (!s) { pane.innerHTML = `<p class="empty-state">No data for ${esc(name)}</p>`; return; }

  const trades  = (state.data.trades ?? []).filter(t => t.strategy === name);
  const daily   = {};
  for (const t of trades) {
    const day = t.exit_time?.slice(0, 10);
    if (day) daily[day] = (daily[day] ?? 0) + t.pnl_usd;
  }

  pane.innerHTML = `
    <div class="stat-row">
      ${statCard("Trades",       s.total_trades ?? trades.length, "")}
      ${statCard("Win rate",     fmt2(s.win_rate_pct ?? s.win_rate) + "%",  s.win_rate_pct >= 50 ? "var(--good)" : "var(--warn)")}
      ${statCard("Net PnL",      usd.format(s.total_pnl ?? s.total_pnl_usd ?? 0), pnlColor(s.total_pnl ?? 0))}
      ${statCard("Total R",      r(s.total_r ?? 0), pnlColor(s.total_r ?? 0))}
      ${statCard("Profit factor", fmt2(s.profit_factor), (s.profit_factor ?? 1) >= 1.5 ? "var(--good)" : "var(--warn)")  }
      ${statCard("Max drawdown", fmt2(s.max_drawdown_pct ?? 0) + "%", "")}
    </div>
    <div class="chart-pair" style="padding:0">
      <article class="chart-card">
        <div class="chart-card-head"><div><p class="eyebrow">Growth</p><h3>Equity curve</h3></div></div>
        <div class="plot" id="strat-equity-${esc(name)}"></div>
      </article>
      <article class="chart-card">
        <div class="chart-card-head"><div><p class="eyebrow">Daily</p><h3>P&amp;L bars</h3></div></div>
        <div class="plot" id="strat-daily-${esc(name)}"></div>
      </article>
    </div>`;

  // Equity curve for this strategy
  let eq = (s.initial_equity ?? state.data.initial_equity ?? 10000);
  const eqCurve = [{ x: trades[0]?.entry_time, y: eq }];
  for (const t of trades.sort((a,b) => a.exit_time < b.exit_time ? -1 : 1)) {
    eq = Math.round((eq + t.pnl_usd) * 100) / 100;
    eqCurve.push({ x: t.exit_time, y: eq });
  }
  const stratColor = cssVar(PALETTE[Object.keys(state.data.stats?.by_strategy ?? {}).sort().indexOf(name) % PALETTE.length]);
  plot(`strat-equity-${name}`, [{
    type: "scatter", mode: "lines",
    x: eqCurve.map(p => p.x), y: eqCurve.map(p => p.y),
    line: { color: stratColor, width: 2.5 },
    fill: "tozeroy", fillcolor: stratColor + "18",
    hovertemplate: "<b>%{x}</b><br>%{y:$,.2f}<extra></extra>",
  }], { yaxis: { tickprefix: "$" } });

  // Daily PnL for this strategy
  const days = Object.keys(daily).sort();
  const pnls = days.map(d => daily[d]);
  plot(`strat-daily-${name}`, [{
    type: "bar",
    x: days, y: pnls,
    marker: { color: pnls.map(v => v >= 0 ? cssVar("--good") : cssVar("--danger")), opacity: 0.85 },
    hovertemplate: "<b>%{x}</b><br>%{y:+$,.2f}<extra></extra>",
  }], { yaxis: { tickprefix: "$" }, bargap: 0.3 });
}

function statCard(label, value, color) {
  return `<div class="stat-card">
    <span class="eyebrow">${esc(label)}</span>
    <span class="stat-val" style="${color ? "color:"+color : ""}">${esc(String(value))}</span>
  </div>`;
}

// ── Symbol charts & grid ──────────────────────────────────────
function renderSymbolCharts() {
  const bySym = state.data.stats?.by_symbol ?? {};
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
  const bySym  = state.data.stats?.by_symbol ?? {};
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

  document.getElementById("f-strat").addEventListener("change", e => { state.filterStrategy  = e.target.value; applyFilters(); });
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

  const headerCells = COL_DEFS.map(c => {
    const cls = c.key === state.sortCol ? `sort-${state.sortDir}` : "";
    return `<th class="${cls}" data-col="${esc(c.key)}">${c.label}</th>`;
  }).join("");

  const rows = trades.map(t =>
    `<tr>${COL_DEFS.map(c => `<td>${c.fmt(t[c.key])}</td>`).join("")}</tr>`
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
