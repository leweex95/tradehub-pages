// =============================================================================
// TradeHub Monitoring Dashboard — app.js
// =============================================================================

const THEME_KEY = "tradehub-monitoring-theme";
const PALETTE = ["--c0","--c1","--c2","--c3","--c4","--c5"];

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  history: null,
  activeTab: null,
  theme: localStorage.getItem(THEME_KEY) || "dark",
  // null/empty Set = show all strategies; populated Set = show only those nickname keys
  stratFilterSet: new Set(),
  globalSym: null,                            // global symbol filter
  globalDateFilter: { from: null, to: null }, // global date filter
};

// Store for benchmark trades (keyed by benchmarkId_runIdx) — used by modal
const _benchmarkTrades = {};

// Per-chart candle state for +100 extend buttons: { candles, entryIdx, fullBars, fullEntryIdx, visibleBefore, visibleAfter }
const _chartState = {};
// Per-symbol M5 OHLC cache for lazy candle loading (pages version strips them from main JSON)
const _ohlcCache = {};

// CI GitHub integration — PAT and repo stored in localStorage
const GH_CI_PAT_KEY  = "tradehub-ci-pat";
const GH_CI_REPO_KEY = "tradehub-ci-repo";
const GH_CI_WORKFLOW = "run-monitoring.yml";
const _ci = { polling: null, triggeredAt: null };

// Apply theme immediately — HTML already has data-theme="dark" as safe fallback
document.documentElement.dataset.theme = state.theme;

// ── Helpers ───────────────────────────────────────────────────────────────────
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function esc(v) {
  return String(v ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function fmt(v, d = 2) {
  if (v == null || isNaN(v)) return "n/a";
  return Number(v).toFixed(d);
}
function fmtS(v, d = 2) {
  if (v == null || isNaN(v)) return "n/a";
  return (v >= 0 ? "+" : "") + Number(v).toFixed(d);
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── Data helpers ──────────────────────────────────────────────────────────────
function getRawRuns() { return state.history?.runs ?? []; }

/** Returns runs deduped by date — keeps only the latest run_id per calendar day. */
function getDeduplicatedRuns() {
  const byDate = new Map();
  for (const run of getRawRuns()) {
    const d = run.date;
    if (!byDate.has(d) || run.run_id > byDate.get(d).run_id) byDate.set(d, run);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function getLatestRun() {
  const r = getDeduplicatedRuns();
  return r[r.length - 1] ?? null;
}

function getPreviousRun() {
  const r = getDeduplicatedRuns();
  return r[r.length - 2] ?? null;
}

/**
 * True if the result_fingerprint for benchmarkId changed between the two most
 * recent deduplicated runs (consecutive comparison, not vs original baseline).
 */
function hasConsecutiveFingerprintChange(benchmarkId) {
  const latest = getLatestRun(), prev = getPreviousRun();
  if (!latest || !prev) return false;
  const lb = (latest.benchmarks ?? []).find(b => b.id === benchmarkId);
  const pb = (prev.benchmarks   ?? []).find(b => b.id === benchmarkId);
  if (!lb || !pb) return false;
  const lf = lb.summary?.result_fingerprint, pf = pb.summary?.result_fingerprint;
  return !!(lf && pf && lf !== pf);
}

/**
 * True if net_pnl_dollars shifted by more than `tol` (relative) between the
 * two most recent deduplicated runs.
 */
function hasConsecutivePnlDrift(benchmarkId, tol = 0.05) {
  const latest = getLatestRun(), prev = getPreviousRun();
  if (!latest || !prev) return false;
  const lb = (latest.benchmarks ?? []).find(b => b.id === benchmarkId);
  const pb = (prev.benchmarks   ?? []).find(b => b.id === benchmarkId);
  if (!lb || !pb) return false;
  const lp = lb.summary?.net_pnl_dollars ?? 0, pp = pb.summary?.net_pnl_dollars ?? 0;
  if (pp === 0) return lp !== 0;
  return Math.abs((lp - pp) / Math.abs(pp)) > tol;
}

/** True if there is any consecutive-run alert for benchmark b. */
function benchmarkHasAlert(b) {
  // Fingerprint change where inputs were the same = true code regression
  const hasTrueRegressionFingerprint = hasConsecutiveFingerprintChange(b.id) &&
    !b.status?.input_changed_since_last_real_run;
  return hasTrueRegressionFingerprint || hasConsecutivePnlDrift(b.id);
}

/** Computes trading KPIs from an array of trade records. Returns null if no trades. */
function computeTradingKPIs(trades) {
  if (!trades.length) return null;
  const pnls   = trades.map(t => t.pnl_net ?? 0);
  const wins   = trades.filter(t => (t.pnl_net ?? 0) > 0);
  const losses = trades.filter(t => (t.pnl_net ?? 0) <= 0);
  const grossWin  = wins.reduce((a, t) => a + (t.pnl_net ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + (t.pnl_net ?? 0), 0));
  const avgWin  = wins.length  ? grossWin  / wins.length  : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const best  = Math.max(...pnls);
  const worst = Math.min(...pnls);
  const barsArr = trades.map(t => Number(t.bars_held ?? 0)).filter(v => v > 0);
  const avgBars = barsArr.length ? barsArr.reduce((a, v) => a + v, 0) / barsArr.length : 0;
  const tpCount = trades.filter(t => t.exit_reason === "tp").length;
  const slCount = trades.filter(t => t.exit_reason === "sl").length;
  // Max drawdown from equity curve sorted ascending by entry_time
  const sortedForDD = [...trades].sort((a, b) => String(a.entry_time).localeCompare(String(b.entry_time)));
  let peak = 0, maxDD = 0, cum = 0;
  for (const t of sortedForDD) {
    cum += t.pnl_net ?? 0;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  return {
    winRate:      wins.length / trades.length,
    grossWin, grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgWin, avgLoss, best, worst, maxDD, avgBars,
    tpCount, slCount,
    tpRate: tpCount / trades.length,
    slRate:  slCount / trades.length,
  };
}

// Groups benchmarks by their base nickname (strip trailing _YYYY_MM or _YYYY etc.)
function strategyNicknameOf(benchmark) {
  const id = benchmark?.id ?? "";
  // strip _2025_01 style suffix
  return id.replace(/_\d{4}(_\d{2})?$/, "") || benchmark?.nickname || id;
}

function groupBenchmarksByStrategy(benchmarks) {
  const map = new Map();
  for (const b of benchmarks) {
    const key = strategyNicknameOf(b);
    if (!map.has(key)) map.set(key, { nickname: key, public_name: b.public_name?.replace(/\s+\d{4}.*$/, "") || key, benchmarks: [] });
    map.get(key).benchmarks.push(b);
  }
  return [...map.values()];
}

// ── Plot helper ───────────────────────────────────────────────────────────────
function plot(id, traces, extra = {}, config = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    margin: { t: 10, r: 12, b: 42, l: 56 },
    hovermode: "closest",
    font: { color: cssVar("--ink-muted"), family: "Inter, Segoe UI, Arial, sans-serif", size: 12 },
    xaxis: { gridcolor: cssVar("--plot-grid"), linecolor: cssVar("--plot-grid"), tickfont: { color: cssVar("--ink-muted") } },
    yaxis: { gridcolor: cssVar("--plot-grid"), zerolinecolor: cssVar("--plot-grid"), tickfont: { color: cssVar("--ink-muted") } },
    legend: { orientation: "h", x: 0, y: 1.18, font: { color: cssVar("--ink-muted"), size: 11 } },
    ...extra,
  };
  Plotly.react(el, traces, layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d","select2d","autoScale2d"], ...config });
}

// ── Fetch & boot ──────────────────────────────────────────────────────────────
// ── Data loading (initial + refresh) ─────────────────────────────────────────
function loadDashboardData({ showSpinner = false } = {}) {
  const refreshBtn = document.getElementById("refresh-btn");
  if (showSpinner && refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing\u2026";
    refreshBtn.classList.add("refreshing");
  }
  // Cache-bust so the browser always fetches the latest JSON
  return fetch("monitoring-history.json?v=" + Date.now())
    .then(r => r.json())
    .then(monData => {
      state.history = monData;
      const stratGroups = groupBenchmarksByStrategy(getLatestRun()?.benchmarks ?? []);
      if (!state.activeTab) state.activeTab = stratGroups[0]?.nickname ?? null;
      boot(stratGroups);
    })
    .catch(err => {
      if (!showSpinner) {
        document.body.innerHTML = `<main class="page"><div class="panel" style="padding:32px"><p class="empty-state">Failed to load dashboard data: ${esc(String(err))}</p></div></main>`;
      }
    })
    .finally(() => {
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "\u21bb Refresh data";
        refreshBtn.classList.remove("refreshing");
      }
    });
}

loadDashboardData();

// ── Theme toggle & refresh button ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_KEY, state.theme);
      document.documentElement.dataset.theme = state.theme;
      renderCharts();   // redraw Plotly after palette change
    });
  }
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadDashboardData({ showSpinner: true }));
  }
});

window.addEventListener("resize", debounce(renderCharts, 120));

// ── Root boot ─────────────────────────────────────────────────────────────────
function boot(stratGroups) {
  renderHero();
  renderHeaderStatus();
  renderGlobalFilterBar(stratGroups);
  renderAggCharts(stratGroups);
  renderAggLegend(stratGroups);
  renderTabs(stratGroups);
  renderFooter();
}

function renderCharts() {
  const stratGroups = groupBenchmarksByStrategy(getLatestRun()?.benchmarks ?? []);
  renderGlobalFilterBar(stratGroups);
  renderAggCharts(stratGroups);
  // also redraw any open pane charts
  if (state.activeTab) renderTabPane(state.activeTab, stratGroups);
}

// ── Hero ──────────────────────────────────────────────────────────────────────
function renderHero() {
  const eyebrow = document.getElementById("hero-eyebrow");
  const lede    = document.getElementById("hero-lede");
  const suite   = state.history?.suite ?? {};
  if (eyebrow) eyebrow.textContent = suite.public_title || "TradeHub Monitoring";
  if (lede)    lede.textContent    = suite.description  || "";

  const kpis = document.getElementById("hero-kpis");
  if (!kpis) return;
  const latestRun = getLatestRun();
  const meta = state.history?.history_meta ?? {};
  const allBenchmarks = latestRun?.benchmarks ?? [];
  const totalAlerts = allBenchmarks.filter(b => benchmarkHasAlert(b)).length;

  kpis.innerHTML = [
    { label: "Latest run",        value: latestRun?.date ?? "n/a",              sub: latestRun?.repo?.short_commit ?? "" },
    { label: "Daily points",      value: meta.real_run_count ?? 0,               sub: "real runs tracked" },
    { label: "Active benchmarks", value: allBenchmarks.length,                   sub: "this suite" },
    { label: "Alerts",            value: totalAlerts || "✓",                     sub: totalAlerts ? "regressions detected" : "all passing", accent: totalAlerts > 0 },
  ].map(k => `
    <div class="kpi-card">
      <span class="kpi-label">${esc(k.label)}</span>
      <span class="kpi-value" style="${k.accent ? "color:var(--danger)" : ""}">${esc(String(k.value))}</span>
      <span class="kpi-label">${esc(k.sub)}</span>
    </div>
  `).join("");
}

// ── Header status pill ────────────────────────────────────────────────────────
function renderHeaderStatus() {
  const el = document.getElementById("header-status");
  if (!el) return;
  const latestRun = getLatestRun();
  const allBenchmarks = latestRun?.benchmarks ?? [];
  const hasAlerts = allBenchmarks.some(b => benchmarkHasAlert(b));
  const overall = hasAlerts ? "alert" : (latestRun ? "pass" : "unknown");
  const colors = { pass: "var(--good)", alert: "var(--danger)", unknown: "var(--ink-muted)" };
  const color = colors[overall] ?? colors.unknown;
  el.innerHTML = `
    <span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span>
    <span>${esc(overall === "pass" ? "All passing" : overall === "alert" ? "Regression detected" : "Unknown")}</span>
  `;
}

// ── Unified global filter bar (strategy + symbol + date) ─────────────────────
function renderGlobalFilterBar(stratGroups) {
  const el = document.getElementById("strat-filter");
  if (!el) return;

  // Collect all symbols from the latest run across all benchmarks
  const latestRun = getLatestRun();
  const allSymbols = new Set();
  for (const b of (latestRun?.benchmarks ?? []))
    for (const s of (b.symbols ?? [])) allSymbols.add(s.symbol);
  const sortedSymbols = [...allSymbols].sort();

  // Latest trade date for date preset anchoring
  let latestTradeDate = "";
  for (const b of (latestRun?.benchmarks ?? []))
    for (const s of (b.symbols ?? []))
      for (const t of (s.trades ?? [])) {
        const d = String(t.entry_time || "").slice(0, 10);
        if (d > latestTradeDate) latestTradeDate = d;
      }
  function presetDate(monthsBack) {
    if (!latestTradeDate) return "";
    const d = new Date(latestTradeDate);
    d.setMonth(d.getMonth() - monthsBack);
    return d.toISOString().slice(0, 10);
  }

  const df = state.globalDateFilter;
  const activePreset =
    (!df.from && !df.to)                   ? "all"
    : (df.from === presetDate(1)  && !df.to) ? "1m"
    : (df.from === presetDate(3)  && !df.to) ? "3m"
    : (df.from === presetDate(6)  && !df.to) ? "6m"
    : (df.from === presetDate(12) && !df.to) ? "1y"
    : "custom";

  // Strategy buttons
  const active = state.stratFilterSet;
  const allStratActive = active.size === 0;
  const stratBtns = [
    `<button class="filter-btn${allStratActive ? " active" : ""}" data-strat="">All</button>`,
    ...stratGroups.map(g => {
      const on = active.has(g.nickname);
      return `<button class="filter-btn${on ? " active" : ""}" data-strat="${esc(g.nickname)}">${esc(g.public_name)}</button>`;
    }),
  ].join("");

  // Symbol buttons (only if multiple symbols exist)
  const symSection = sortedSymbols.length > 1 ? `
    <div class="gfb-divider"></div>
    <div class="gfb-section">
      <span class="filter-label">Symbol:</span>
      <div class="filter-btns">
        <button class="filter-chip${state.globalSym === null ? " active" : ""}" data-sym="">All</button>
        ${sortedSymbols.map(sym =>
          `<button class="filter-chip${state.globalSym === sym ? " active" : ""}" data-sym="${esc(sym)}">${esc(sym)}</button>`
        ).join("")}
      </div>
    </div>` : "";

  el.innerHTML = `
    <div class="gfb-section">
      <span class="filter-label">Strategy:</span>
      <div class="filter-btns">${stratBtns}</div>
    </div>
    ${symSection}
    <div class="gfb-divider"></div>
    <div class="gfb-section">
      <span class="filter-label">Date:</span>
      <div class="filter-btns">
        <button class="filter-btn${activePreset === "all" ? " active" : ""}" data-preset="all">All</button>
        <button class="filter-btn${activePreset === "1m"  ? " active" : ""}" data-preset="1m">1M</button>
        <button class="filter-btn${activePreset === "3m"  ? " active" : ""}" data-preset="3m">3M</button>
        <button class="filter-btn${activePreset === "6m"  ? " active" : ""}" data-preset="6m">6M</button>
        <button class="filter-btn${activePreset === "1y"  ? " active" : ""}" data-preset="1y">1Y</button>
      </div>
      <div class="date-custom-inputs">
        <input type="date" class="date-input" id="gfb-from" value="${df.from || ""}" max="${df.to || latestTradeDate}">
        <span style="color:var(--ink-muted)">—</span>
        <input type="date" class="date-input" id="gfb-to" value="${df.to || ""}" min="${df.from || ""}">
        ${(df.from || df.to) ? `<button class="filter-btn" id="gfb-clear" title="Clear date filter">✕</button>` : ""}
      </div>
    </div>`;

  // Wire strategy buttons
  el.querySelectorAll(".filter-btn[data-strat]").forEach(btn => {
    btn.addEventListener("click", () => {
      const nick = btn.dataset.strat;
      if (!nick) {
        state.stratFilterSet = new Set();
      } else if (state.stratFilterSet.has(nick)) {
        state.stratFilterSet.delete(nick);
      } else {
        state.stratFilterSet.add(nick);
      }
      renderGlobalFilterBar(stratGroups);
      renderAggCharts(stratGroups);
      renderAggLegend(stratGroups);
      applyStratFilterToTabs(stratGroups);
    });
  });

  // Wire symbol buttons
  el.querySelectorAll(".filter-chip[data-sym]").forEach(chip => {
    chip.addEventListener("click", () => {
      state.globalSym = chip.dataset.sym || null;
      renderGlobalFilterBar(stratGroups);
      renderAggEquityCurve(stratGroups);
      if (state.activeTab) renderTabPane(state.activeTab, stratGroups);
    });
  });

  // Wire date preset buttons
  el.querySelectorAll(".filter-btn[data-preset]").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = btn.dataset.preset;
      if (p === "all")  state.globalDateFilter = { from: null, to: null };
      else if (p === "1m")  state.globalDateFilter = { from: presetDate(1),  to: null };
      else if (p === "3m")  state.globalDateFilter = { from: presetDate(3),  to: null };
      else if (p === "6m")  state.globalDateFilter = { from: presetDate(6),  to: null };
      else if (p === "1y")  state.globalDateFilter = { from: presetDate(12), to: null };
      renderGlobalFilterBar(stratGroups);
      if (state.activeTab) renderTabPane(state.activeTab, stratGroups);
    });
  });

  // Wire custom date inputs
  const fromInput = document.getElementById("gfb-from");
  const toInput   = document.getElementById("gfb-to");
  if (fromInput) fromInput.addEventListener("change", () => {
    state.globalDateFilter = { from: fromInput.value || null, to: toInput?.value || null };
    renderGlobalFilterBar(stratGroups);
    if (state.activeTab) renderTabPane(state.activeTab, stratGroups);
  });
  if (toInput) toInput.addEventListener("change", () => {
    state.globalDateFilter = { from: fromInput?.value || null, to: toInput.value || null };
    renderGlobalFilterBar(stratGroups);
    if (state.activeTab) renderTabPane(state.activeTab, stratGroups);
  });
  document.getElementById("gfb-clear")?.addEventListener("click", () => {
    state.globalDateFilter = { from: null, to: null };
    renderGlobalFilterBar(stratGroups);
    if (state.activeTab) renderTabPane(state.activeTab, stratGroups);
  });
}

// ── Apply strategy filter to tabs (hide/show tabs matching the filter) ────────
function applyStratFilterToTabs(stratGroups) {
  const active = state.stratFilterSet;
  const allActive = active.size === 0;
  document.querySelectorAll(".tab-btn").forEach(btn => {
    const visible = allActive || active.has(btn.dataset.tab);
    btn.style.display = visible ? "" : "none";
  });
  // If current active tab is now hidden, switch to first visible tab
  if (!allActive && !active.has(state.activeTab)) {
    const firstVisible = stratGroups.find(g => active.has(g.nickname));
    if (firstVisible) {
      state.activeTab = firstVisible.nickname;
      document.querySelectorAll(".tab-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.tab === firstVisible.nickname));
      document.querySelectorAll(".tab-pane").forEach(p =>
        p.classList.toggle("active", p.id === `pane-${firstVisible.nickname}`));
      renderTabPane(firstVisible.nickname, stratGroups);
    }
  }
}

// ── Aggregate charts (all strategies, all runs, deduped) ──────────────────────
function renderAggCharts(stratGroups) {
  const runs = getDeduplicatedRuns();  // ← one entry per calendar date

  if (state.stratFilterSet.size === 1) {
    // Single-strategy filtered view: per-symbol stacked bars
    const nick = [...state.stratFilterSet][0];
    const grp = stratGroups.find(g => g.nickname === nick);
    if (!grp) return;
    const symbolSet = new Set();
    for (const run of runs)
      for (const b of (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === grp.nickname))
        for (const sym of (b.symbols ?? [])) symbolSet.add(sym.symbol);
    const symbols = [...symbolSet].sort();
    const dates = runs.map(r => r.date);

    const pnlTraces = symbols.map((sym, i) => {
      const colour = cssVar(PALETTE[i % PALETTE.length]);
      const ys = runs.map(run =>
        (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === grp.nickname)
          .flatMap(b => b.symbols ?? []).filter(s => s.symbol === sym)
          .reduce((a, s) => a + (s.summary?.net_pnl_dollars ?? 0), 0));
      return { type: "bar", name: sym, x: dates, y: ys,
        marker: { color: colour, opacity: 0.85 },
        hovertemplate: `<b>${esc(sym)}</b><br>%{x}: %{y:$,.2f}<extra></extra>` };
    });
    // Fix: use full `dates` array for all traces so categories share the same
    // chronological order regardless of which runs have data for each symbol.
    const rtTraces = symbols.map((sym, i) => {
      const colour = cssVar(PALETTE[i % PALETTE.length]);
      const ys = runs.map(run => {
        const v = (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === grp.nickname)
          .flatMap(b => b.symbols ?? []).filter(s => s.symbol === sym)
          .reduce((a, s) => a + (s.summary?.elapsed_sec ?? 0), 0);
        return v > 0 ? v : null;  // null = gap; avoids out-of-order categories
      });
      return { type: "scatter", mode: "lines+markers", name: sym, x: dates, y: ys,
        line: { color: colour, width: 2 }, marker: { color: colour, size: 5 },
        hovertemplate: `<b>${esc(sym)}</b><br>%{x}: %{y:.2f}s<extra></extra>` };
    });

    plot("agg-pnl-chart", pnlTraces, { barmode: "stack", xaxis: { type: "category" }, yaxis: { title: "USD" } });
    plot("agg-runtime-chart", rtTraces, { xaxis: { type: "category" }, yaxis: { title: "Seconds" } });
    document.getElementById("agg-pnl-note").textContent = `Per-symbol net PnL for ${grp.public_name} — one bar per run date.`;
    document.getElementById("agg-runtime-note").textContent = `Per-symbol runtime breakdown for ${grp.public_name}.`;
    return;
  }

  // Unfiltered / multi-select view: one trace per visible strategy.
  // When stratFilterSet has entries (2+), only show selected ones.
  const visibleGroups = state.stratFilterSet.size > 0
    ? stratGroups.filter(g => state.stratFilterSet.has(g.nickname))
    : stratGroups;
  // Fix: use full `dates` array for all traces so every trace shares the same
  // category list in chronological order, preventing earlier dates from being
  // appended at the end when a strategy first appears in a later run.
  const dates = runs.map(r => r.date);
  const rtTraces = visibleGroups.map((grp, i) => {
    const colour = cssVar(PALETTE[i % PALETTE.length]);
    const ys = runs.map(run => {
      const sum = (run.benchmarks ?? [])
        .filter(b => strategyNicknameOf(b) === grp.nickname)
        .reduce((acc, b) => acc + (b.summary?.elapsed_sec ?? 0), 0);
      return sum > 0 ? sum : null;  // null = gap in line; keeps x-axis ordered
    });
    return { type: "scatter", mode: "lines+markers", name: grp.public_name, x: dates, y: ys,
      line: { color: colour, width: 2.5 }, marker: { color: colour, size: 6 },
      hovertemplate: `<b>${esc(grp.public_name)}</b><br>%{x}: %{y:.2f}s<extra></extra>` };
  });
  plot("agg-runtime-chart", rtTraces, { xaxis: { type: "category" }, yaxis: { title: "Total seconds" } });
  document.getElementById("agg-runtime-note").textContent = "Sum of all benchmark runtimes per run date across each strategy.";

  const pnlTraces = visibleGroups.map((grp, i) => {
    const colour = cssVar(PALETTE[i % PALETTE.length]);
    const xs = [], ys = [];
    for (const run of runs) {
      const sum = (run.benchmarks ?? [])
        .filter(b => strategyNicknameOf(b) === grp.nickname)
        .reduce((acc, b) => acc + (b.summary?.net_pnl_dollars ?? 0), 0);
      xs.push(run.date); ys.push(sum);
    }
    return { type: "bar", name: grp.public_name, x: xs, y: ys,
      marker: { color: colour, opacity: 0.8 },
      hovertemplate: `<b>${esc(grp.public_name)}</b><br>%{x}: %{y:$,.2f}<extra></extra>` };
  });
  plot("agg-pnl-chart", pnlTraces, { barmode: "group", xaxis: { type: "category" }, yaxis: { title: "USD" } });
  document.getElementById("agg-pnl-note").textContent = "Aggregate net PnL across all monthly benchmarks per strategy per run.";
  renderAggEquityCurve(visibleGroups);
}

function renderAggLegend(stratGroups) {
  const el = document.getElementById("agg-legend");
  if (!el) return;
  const visibleGroups = state.stratFilterSet.size > 0
    ? stratGroups.filter(g => state.stratFilterSet.has(g.nickname))
    : stratGroups;
  el.innerHTML = visibleGroups.map((grp, i) => {
    const colour = cssVar(PALETTE[i % PALETTE.length]);
    return `<span class="legend-chip"><span class="legend-dot" style="background:${colour}"></span>${esc(grp.public_name)}</span>`;
  }).join("");
}

// ── Aggregate equity curve ─────────────────────────────────────────────────────
function renderAggEquityCurve(stratGroups) {
  const wrap = document.getElementById("agg-equity-wrap");
  if (!wrap) return;
  const latestRun = getLatestRun();
  if (!latestRun) { wrap.style.display = "none"; return; }

  const isSingleFilter = state.stratFilterSet.size === 1;
  const filterNick = isSingleFilter ? [...state.stratFilterSet][0] : null;
  const activeSym = state.globalSym;

  if (isSingleFilter) {
    // Single-strategy filtered view: equity curve for the selected strategy
    const grp = stratGroups.find(g => g.nickname === filterNick);
    if (!grp) { wrap.style.display = "none"; return; }
    const allTrades = [];
    for (const b of (latestRun.benchmarks ?? []).filter(b => strategyNicknameOf(b) === grp.nickname)) {
      for (const sym of (b.symbols ?? [])) {
        if (activeSym && sym.symbol !== activeSym) continue;
        for (const t of (sym.trades ?? [])) allTrades.push({ ...t, _sym: sym.symbol });
      }
    }
    if (!allTrades.length) { wrap.style.display = "none"; return; }
    wrap.style.display = "";
    document.getElementById("agg-equity-eyebrow").textContent = grp.public_name + " \u2014 equity curve";
    document.getElementById("agg-equity-title").textContent =
      "Cumulative P\u0026L \u2014 " + allTrades.length + " trades" + (activeSym ? " \u2014 " + activeSym : "");
    _plotAggEquity([{ trades: allTrades, label: grp.public_name,
      color: cssVar(PALETTE[0]), stratKey: "strat_" + grp.nickname }]);
  } else {
    // Unfiltered / multi-select view: one line per visible strategy (portfolio view)
    const stratLines = stratGroups.map((grp, i) => {
      const trades = [];
      for (const b of (latestRun.benchmarks ?? []).filter(b => strategyNicknameOf(b) === grp.nickname))
        for (const sym of (b.symbols ?? []))
          for (const t of (sym.trades ?? [])) trades.push({ ...t, _sym: sym.symbol });
      return { trades, label: grp.public_name, color: cssVar(PALETTE[i % PALETTE.length]), stratKey: "strat_" + grp.nickname };
    }).filter(s => s.trades.length > 0);

    if (!stratLines.length) { wrap.style.display = "none"; return; }
    const totalTrades = stratLines.reduce((a, s) => a + s.trades.length, 0);
    wrap.style.display = "";
    document.getElementById("agg-equity-eyebrow").textContent = "Portfolio equity";
    document.getElementById("agg-equity-title").textContent =
      "Cumulative P\u0026L \u2014 all strategies \u2014 " + totalTrades + " trades";
    _plotAggEquity(stratLines);
  }
}

function _plotAggEquity(stratLines) {
  const chartEl = document.getElementById("agg-equity-chart");
  if (!chartEl) return;

  const traces = stratLines.map(({ trades, label, color, stratKey }) => {
    const sortedAsc = [...trades].sort((a, b) => String(a.entry_time).localeCompare(String(b.entry_time)));
    let cum = 0;
    const xs = [], ys = [], customdata = [];
    sortedAsc.forEach((t, i) => {
      cum += t.pnl_net ?? 0;
      xs.push(String(t.entry_time || "").replace(" ", "T").slice(0, 16));
      ys.push(+cum.toFixed(2));
      customdata.push({ stratKey, tradeNumAsc: i, date: String(t.entry_time || "").slice(0, 16).replace("T", " ") });
    });
    return {
      type: "scatter", mode: "lines+markers", name: label, x: xs, y: ys, customdata,
      line: { color, width: 2 }, marker: { color, size: 5 },
      hovertemplate: `<b>${esc(label)}</b><br>%{x}<br>Cumul.: <b>%{y:$,.2f}</b><extra></extra>`,
    };
  });

  Plotly.react(chartEl, traces, {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    margin: { t: 10, r: 16, b: 44, l: 72 },
    hovermode: "closest",
    font: { color: cssVar("--ink-muted"), size: 11, family: "Inter, Segoe UI, sans-serif" },
    legend: { orientation: "h", x: 0, y: 1.15, font: { color: cssVar("--ink-muted"), size: 11 } },
    xaxis: { type: "date", title: { text: "Date", font: { size: 10, color: cssVar("--ink-muted") } },
      tickformat: "%Y-%m-%d", gridcolor: cssVar("--plot-grid"), linecolor: cssVar("--plot-grid"),
      tickfont: { size: 10, color: cssVar("--ink-muted") } },
    yaxis: { tickformat: "$,.0f", gridcolor: cssVar("--plot-grid"), zerolinecolor: cssVar("--plot-grid"),
      tickfont: { size: 10, color: cssVar("--ink-muted") } },
    shapes: [{ type: "line", x0: 0, x1: 1, xref: "paper", y0: 0, y1: 0,
      line: { color: "rgba(148,182,210,0.25)", width: 1, dash: "dot" } }],
  }, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d","select2d","autoScale2d","toImage"] });

  // Click: for single-strategy filtered view, navigate to trade row in the pane
  // Plotly elements expose .removeAllListeners(), not jQuery .off()
  chartEl.removeAllListeners?.("plotly_click");
  chartEl.on("plotly_click", data => {
    const pt = data.points?.[0];
    if (!pt) return;
    const { stratKey, tradeNumAsc } = pt.customdata;
    const stratNick = stratKey.replace(/^strat_/, "");
    // Ensure the correct tab is active
    if (state.activeTab !== stratNick) {
      state.activeTab = stratNick;
      document.querySelectorAll(".tab-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.tab === stratNick));
      document.querySelectorAll(".tab-pane").forEach(p =>
        p.classList.toggle("active", p.id === `pane-${stratNick}`));
      const sg = groupBenchmarksByStrategy(getLatestRun()?.benchmarks ?? []);
      renderTabPane(stratNick, sg);
    }
    // displayIdx in the descending-sorted trade table = N-1-tradeNumAsc
    const allTrades = _benchmarkTrades[stratKey] ?? [];
    if (allTrades.length) {
      const displayIdx = allTrades.length - 1 - tradeNumAsc;
      setTimeout(() => scrollToTradeRow(stratKey, displayIdx), 300);
    } else {
      // Pane not yet rendered: scroll to tab
      setTimeout(() => {
        const pane = document.getElementById(`pane-${stratNick}`);
        if (pane) pane.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 300);
    }
  });
}

// ── Tabs ───────────────────────────────────────────────────────────────────────
function renderTabs(stratGroups) {
  const bar = document.getElementById("tabs-bar");
  const panes = document.getElementById("tab-panes");
  if (!bar || !panes) return;

  bar.innerHTML = stratGroups.map(grp => {
    const active = grp.nickname === state.activeTab ? "active" : "";
    return `<button class="tab-btn ${active}" role="tab" data-tab="${esc(grp.nickname)}">${esc(grp.public_name)}</button>`;
  }).join("");

  panes.innerHTML = stratGroups.map(grp => {
    const active = grp.nickname === state.activeTab ? "active" : "";
    return `<div class="tab-pane ${active}" id="pane-${esc(grp.nickname)}"></div>`;
  }).join("");

  bar.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      bar.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b === btn));
      panes.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === `pane-${btn.dataset.tab}`));
      renderTabPane(state.activeTab, stratGroups);
    });
  });

  if (state.activeTab) renderTabPane(state.activeTab, stratGroups);
}

// ── Single tab pane ────────────────────────────────────────────────────────────
function renderTabPane(nickname, stratGroups) {
  const pane = document.getElementById(`pane-${nickname}`);
  if (!pane) return;
  const grp = stratGroups.find(g => g.nickname === nickname);
  if (!grp) return;

  const latestRun = getLatestRun();
  const allBenchmarks = (latestRun?.benchmarks ?? []).filter(b => strategyNicknameOf(b) === nickname);

  // Use global filters
  const activeSym = state.globalSym;
  const df = state.globalDateFilter;
  const dfFrom = df.from ? new Date(df.from) : null;
  const dfTo   = df.to   ? new Date(df.to + "T23:59:59") : null;
  function tradeInDateRange(t) {
    if (!dfFrom && !dfTo) return true;
    const dt = new Date(String(t.entry_time || "").replace("T", " "));
    if (dfFrom && dt < dfFrom) return false;
    if (dfTo   && dt > dfTo)   return false;
    return true;
  }

  const benchmarks = activeSym
    ? allBenchmarks.filter(b => (b.symbols ?? []).some(s => s.symbol === activeSym))
    : allBenchmarks;

  // Compute stats from individual trades (respects both sym and date filters)
  let totalTrades = 0, totalWins = 0, totalPnl = 0, totalElapsed = 0;
  for (const b of benchmarks) {
    for (const sym of (b.symbols ?? [])) {
      if (activeSym && sym.symbol !== activeSym) continue;
      const trades = (sym.trades ?? []).filter(tradeInDateRange);
      totalTrades += trades.length;
      totalWins   += trades.filter(t => (t.pnl_net ?? 0) > 0).length;
      totalPnl    += trades.reduce((a, t) => a + (t.pnl_net ?? 0), 0);
    }
    totalElapsed += b.summary?.elapsed_sec ?? 0;
  }
  const winRate = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;

  pane.innerHTML = `
    <div class="stat-row">
      ${statCard("Total trades", totalTrades, activeSym ? esc(activeSym) + " only" : "all symbols")}
      ${statCard("Win rate", fmt(winRate, 1) + "%", "across all months & symbols")}
      ${statCard("Net PnL", currency.format(totalPnl), "all months combined", totalPnl >= 0 ? "var(--good)" : "var(--danger)")}
      ${statCard("Runtime", fmt(totalElapsed, 1) + "s", "total across benchmarks")}
    </div>

    <div id="strategy-kpis-${esc(nickname)}"></div>

    <div id="equity-curve-${esc(nickname)}"></div>

    <div class="alerts-list" id="alerts-${esc(nickname)}"></div>

    <div id="strategy-trades-${esc(nickname)}"></div>

    <div class="month-grid-wrap">
      <p class="eyebrow">Benchmark windows</p>
      <div class="month-grid" id="months-${esc(nickname)}"></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div class="panel" style="padding:18px" id="scope-${esc(nickname)}"></div>
      <div class="panel" style="padding:18px" id="integrity-${esc(nickname)}"></div>
    </div>
  `;

  renderPaneAlerts(nickname, benchmarks);
  renderStrategyTrades(nickname, benchmarks);  // must run first — populates _benchmarkTrades
  renderStrategyKPIs(nickname, `strat_${nickname}`);
  renderEquityCurveForStrategy(nickname, `strat_${nickname}`);
  renderPaneMonths(nickname, benchmarks);
  const suiteMeta = (state.history?.benchmarks ?? []).find(b => b.id === (benchmarks[0]?.id ?? ""));
  renderPaneScope(nickname, suiteMeta ?? benchmarks[0] ?? null);
  renderPaneIntegrity(nickname, latestRun);
  renderPaneHistoryCharts(nickname, grp);
}

// ── Per-strategy consolidated trade list with inline charts ──────────────────
function renderStrategyTrades(nickname, benchmarks) {
  const el = document.getElementById(`strategy-trades-${nickname}`);
  if (!el) return;

  // Collect all trades across all benchmark windows (filtered by global sym + date filters)
  const activeSym = state.globalSym;
  const _df    = state.globalDateFilter;
  const dfFrom = _df.from ? new Date(_df.from) : null;
  const dfTo   = _df.to   ? new Date(_df.to + "T23:59:59") : null;
  const allTrades = [];
  for (const b of benchmarks) {
    for (const row of (b.symbols ?? [])) {
      if (activeSym && row.symbol !== activeSym) continue;
      for (const t of (row.trades ?? [])) {
        if (dfFrom || dfTo) {
          const dt = new Date(String(t.entry_time || "").replace("T", " "));
          if (dfFrom && dt < dfFrom) continue;
          if (dfTo   && dt > dfTo)   continue;
        }
        allTrades.push({ ...t, _sym: row.symbol });
      }
    }
  }

  if (!allTrades.length) { el.innerHTML = ""; return; }

  // Sort by entry_time descending
  allTrades.sort((a, b) => String(b.entry_time).localeCompare(String(a.entry_time)));

  const stratKey = `strat_${nickname}`;
  _benchmarkTrades[stratKey] = allTrades;

  const pxFmt = v => { const n = Number(v); return isNaN(n) || n === 0 ? "—" : n < 10 ? n.toFixed(5) : n.toFixed(2); };

  const rows = allTrades.map((t, i) => {
    const pnl = t.pnl_net ?? 0;
    const isWin = pnl > 0;
    const dir = String(t.direction || "").toLowerCase();
    const exitCls = t.exit_reason === "tp" ? "tp" : t.exit_reason === "sl" ? "sl" : "neutral";
    return `
      <tr class="trade-row strat-trade-row" data-tkey="${esc(stratKey)}" data-tidx="${i}">
        <td><strong>${esc(t._sym)}</strong></td>
        <td><span class="badge badge-${esc(dir)}">${esc(dir.toUpperCase())}</span></td>
        <td>${esc(String(t.entry_time || "").replace("T", " ").slice(0, 19))}</td>
        <td>${esc(String(t.exit_time  || "").replace("T", " ").slice(0, 19))}</td>
        <td style="font-size:.8rem">${pxFmt(t.entry_price)}</td>
        <td style="font-size:.8rem">${pxFmt(t.exit_price)}</td>
        <td style="color:${isWin ? "var(--good)" : "var(--danger)"};font-weight:600">${isWin ? "+" : ""}${Number(pnl).toFixed(2)}</td>
        <td>${esc(t.bars_held ?? "")}</td>
        <td><span class="badge badge-${exitCls}">${esc(t.exit_reason || "—")}</span></td>
      </tr>
      <tr class="strat-trade-detail-row" id="strat-detail-${esc(stratKey)}-${i}" style="display:none">
        <td colspan="9">
          <div class="strat-chart-wrap" style="display:flex;gap:8px;align-items:flex-start">
            <div id="strat-chart-${esc(stratKey)}-${i}" style="height:380px;flex:1;min-width:0"></div>
            <div class="candle-btns" style="display:flex;flex-direction:column;gap:6px;padding-top:8px">
              <button class="candle-btn candle-btn-before" title="+100 earlier candles" style="font-size:0.8rem;padding:4px 8px">↑ +100</button>
              <button class="candle-btn candle-btn-after"  title="+100 later candles"  style="font-size:0.8rem;padding:4px 8px">↓ +100</button>
            </div>
          </div>
          <div class="modal-stats" id="strat-stats-${esc(stratKey)}-${i}" style="margin-top:8px"></div>
        </td>
      </tr>`;
  }).join("");

  el.innerHTML = `
    <div class="strategy-trades-section">
      <p class="eyebrow" style="margin-bottom:8px">All ${allTrades.length} trades — click any row to expand chart</p>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Symbol</th><th>Dir</th><th>Entry</th><th>Exit</th>
            <th>Entry px</th><th>Exit px</th><th>P&amp;L</th><th>Bars</th><th>Exit reason</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  // Wire click-to-expand for each trade row
  el.querySelectorAll(".strat-trade-row").forEach(row => {
    row.addEventListener("click", () => {
      const tkey = row.dataset.tkey;
      const tidx = parseInt(row.dataset.tidx, 10);
      const detailRow = document.getElementById(`strat-detail-${tkey}-${tidx}`);
      if (!detailRow) return;
      const isOpen = detailRow.style.display !== "none";
      // Close all other open detail rows in this section
      el.querySelectorAll(".strat-trade-detail-row").forEach(r => {
        if (r !== detailRow) { r.style.display = "none"; }
      });
      el.querySelectorAll(".strat-trade-row").forEach(r => {
        if (r !== row) r.classList.remove("expanded");
      });
      if (isOpen) {
        detailRow.style.display = "none";
        row.classList.remove("expanded");
      } else {
        detailRow.style.display = "";
        row.classList.add("expanded");
        renderInlineTradeChart(tkey, tidx);
      }
    });
  });
}

// ── Strategy KPI cards ─────────────────────────────────────────────────────────
function renderStrategyKPIs(nickname, stratKey) {
  const el = document.getElementById(`strategy-kpis-${nickname}`);
  if (!el) return;
  const trades = _benchmarkTrades[stratKey] ?? [];
  if (!trades.length) { el.innerHTML = ""; return; }
  const kpis = computeTradingKPIs(trades);
  if (!kpis) { el.innerHTML = ""; return; }

  const pf = isFinite(kpis.profitFactor) ? kpis.profitFactor.toFixed(2) : "∞";
  const pfCol = kpis.profitFactor > 1.5 ? "var(--good)" : kpis.profitFactor > 1 ? "var(--warn)" : "var(--danger)";
  const wrCol = kpis.winRate > 0.5 ? "var(--good)" : kpis.winRate > 0.4 ? "var(--warn)" : "var(--danger)";
  const kc = (label, value, color = "") =>
    `<div class="kpi-mini-card">
       <span class="kpi-mini-label">${esc(label)}</span>
       <span class="kpi-mini-value" style="${color ? "color:"+color : ""}">${esc(String(value))}</span>
     </div>`;

  el.innerHTML = `
    <div class="strategy-kpis-section">
      <p class="eyebrow" style="margin-bottom:10px">Trading statistics</p>
      <div class="kpi-mini-grid">
        ${kc("Profit factor",   pf,                                      pfCol)}
        ${kc("Win rate",        fmt(kpis.winRate * 100, 1) + "%",        wrCol)}
        ${kc("Avg win",         "+" + kpis.avgWin.toFixed(2) + " USD",  "var(--good)")}
        ${kc("Avg loss",        "\u2212" + kpis.avgLoss.toFixed(2) + " USD", "var(--danger)")}
        ${kc("Best trade",      "+" + kpis.best.toFixed(2) + " USD",    "var(--good)")}
        ${kc("Worst trade",     kpis.worst.toFixed(2) + " USD",         "var(--danger)")}
        ${kc("Max drawdown",    "\u2212" + kpis.maxDD.toFixed(2) + " USD",  "var(--danger)")}
        ${kc("TP exits",        fmt(kpis.tpRate * 100, 1) + "%",        "var(--good)")}
        ${kc("SL exits",        fmt(kpis.slRate * 100, 1) + "%",        "var(--danger)")}
        ${kc("Avg hold (bars)", fmt(kpis.avgBars, 1),                   "")}
      </div>
    </div>`;
}

// ── Per-strategy equity curve ─────────────────────────────────────────────────
function renderEquityCurveForStrategy(nickname, stratKey) {
  const el = document.getElementById(`equity-curve-${nickname}`);
  if (!el) return;
  // trades are stored in descending display order (data-tidx 0 = newest trade)
  const trades = _benchmarkTrades[stratKey] ?? [];
  if (!trades.length) { el.innerHTML = ""; return; }

  // Sort ascending by entry_time for the curve; keep original display index (data-tidx) for linking
  const sorted = trades
    .map((trade, displayIdx) => ({ trade, displayIdx }))
    .sort((a, b) => String(a.trade.entry_time).localeCompare(String(b.trade.entry_time)));

  let cumPnl = 0;
  const xs = [], ys = [], customdata = [];
  for (let i = 0; i < sorted.length; i++) {
    const { trade, displayIdx } = sorted[i];
    cumPnl += trade.pnl_net ?? 0;
    xs.push(String(trade.entry_time || "").replace(" ", "T").slice(0, 16));
    ys.push(+cumPnl.toFixed(2));
    customdata.push([displayIdx, String(trade.entry_time || "").slice(0, 16).replace("T", " ")]);
  }

  const endColor   = cumPnl >= 0 ? "#6fd98f" : "#ff7b61";
  const dotColors  = ys.map((v, i) => (i === 0 || v >= ys[i - 1]) ? "#6fd98f" : "#ff7b61");

  el.innerHTML = `
    <div class="equity-curve-section">
      <p class="eyebrow" style="margin-bottom:8px">Equity curve \u2014 click a dot to jump to that trade below</p>
      <div id="eq-plot-${esc(nickname)}" style="height:200px"></div>
    </div>`;

  const chartEl = document.getElementById(`eq-plot-${nickname}`);
  if (!chartEl) return;

  const trace = {
    type: "scatter", mode: "lines+markers",
    x: xs, y: ys, customdata,
    line:   { color: endColor, width: 2 },
    marker: { color: dotColors, size: 6, line: { width: 1, color: "rgba(0,0,0,0.2)" } },
    hovertemplate: "<b>%{x}</b><br>Cumul. P&L: <b>%{y:$,.2f}</b><extra></extra>",
    showlegend: false,
  };

  Plotly.react(chartEl, [trace], {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    margin: { t: 8, r: 16, b: 44, l: 72 },
    hovermode: "closest",
    font: { color: cssVar("--ink-muted"), size: 11, family: "Inter, Segoe UI, sans-serif" },
    xaxis: { type: "date", title: { text: "Date", font: { size: 10 } }, tickformat: "%Y-%m-%d",
      gridcolor: cssVar("--plot-grid"),
      linecolor: cssVar("--plot-grid"), tickfont: { size: 9, color: cssVar("--ink-muted") } },
    yaxis: { tickformat: "$,.0f", gridcolor: cssVar("--plot-grid"), zerolinecolor: cssVar("--plot-grid"),
      tickfont: { size: 10, color: cssVar("--ink-muted") } },
    shapes: [{ type: "line", x0: 0, x1: 1, xref: "paper", y0: 0, y1: 0,
      line: { color: "rgba(148,182,210,0.3)", width: 1, dash: "dot" } }],
  }, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d","select2d","autoScale2d","toImage"] });

  chartEl.on("plotly_click", data => {
    const pt = data.points?.[0];
    if (!pt) return;
    const [displayIdx] = pt.customdata;
    scrollToTradeRow(stratKey, displayIdx);
  });
}

/** Scroll to a trade row in the strategy trade table and open its inline chart. */
function scrollToTradeRow(stratKey, displayIdx) {
  const row = document.querySelector(`.strat-trade-row[data-tkey="${stratKey}"][data-tidx="${displayIdx}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => {
    const detailRow = document.getElementById(`strat-detail-${stratKey}-${displayIdx}`);
    if (detailRow && detailRow.style.display === "none") row.click();
    row.classList.add("equity-highlight");
    setTimeout(() => row.classList.remove("equity-highlight"), 1500);
  }, 400);
}

/**
 * Fetch M5 OHLC data for a symbol from the `candles/` directory (lazy-load for pages version).
 * Returns { bars, tsToIdx } or null if unavailable.
 */
async function fetchSymbolCandles(symbol) {
  if (_ohlcCache[symbol] !== undefined) return _ohlcCache[symbol];
  try {
    const resp = await fetch(`candles/${symbol}.json`);
    if (!resp.ok) { _ohlcCache[symbol] = null; return null; }
    const data = await resp.json();
    const tsToIdx = {};
    (data.bars ?? []).forEach((bar, i) => { tsToIdx[bar[0]] = i; });
    _ohlcCache[symbol] = { bars: data.bars ?? [], tsToIdx };
    return _ohlcCache[symbol];
  } catch {
    _ohlcCache[symbol] = null;
    return null;
  }
}

/** Renders an inline Plotly trade chart inside the expandable row. */
async function renderInlineTradeChart(tkey, tidx) {
  const trade = _benchmarkTrades[tkey]?.[tidx];
  if (!trade) return;
  const chartId  = `strat-chart-${tkey}-${tidx}`;
  const statsId  = `strat-stats-${tkey}-${tidx}`;
  const chartEl  = document.getElementById(chartId);
  const statsEl  = document.getElementById(statsId);
  if (!chartEl) return;

  const sym  = trade._sym || "—";
  const dir  = String(trade.direction || "").toLowerCase();
  const entX = String(trade.entry_time || "");
  const extX = String(trade.exit_time  || "");
  const entY = Number(trade.entry_price || 0);
  const extY = Number(trade.exit_price  || 0);
  const sl   = Number(trade.stop_loss ?? 0);
  const tp   = Number(trade.take_profit ?? 0);
  const pnl  = Number(trade.pnl_net ?? 0);
  const isWin = pnl > 0;

  const pxFmt  = v => { const n = Number(v); return n < 10 ? n.toFixed(5) : n.toFixed(2); };
  const dirCol  = dir === "buy" ? cssVar("--good") : cssVar("--warn");
  const pnlCol  = isWin ? cssVar("--good") : cssVar("--danger");

  let candles    = trade.candles ?? null;
  let entryIdx   = trade.candles_entry_idx ?? 0;
  const initBefore = trade.candles_init_before ?? 60;
  const initAfter  = trade.candles_init_after  ?? 40;
  let fullBars     = null;   // full symbol bars (for lazy-load unlimited extend)
  let fullEntryIdx = null;

  // Lazy-load candles when not embedded (pages strips them to keep JSON small)
  if (!candles) {
    chartEl.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--ink-muted);font-size:0.85rem">Loading chart…</div>`;
    const symData = await fetchSymbolCandles(sym);
    if (symData && symData.bars.length) {
      const entryKey = entX.replace(" ", "T").slice(0, 16);
      let idx = symData.tsToIdx[entryKey];
      if (idx === undefined) {
        // Binary-search nearest M5 bar by timestamp string
        const bs = symData.bars;
        let lo = 0, hi = bs.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; bs[mid][0] < entryKey ? lo = mid + 1 : hi = mid; }
        idx = lo;
      }
      fullBars     = symData.bars;
      fullEntryIdx = idx;
      const i0 = Math.max(0, idx - 160);
      const i1 = Math.min(symData.bars.length - 1, idx + 140);
      candles  = symData.bars.slice(i0, i1 + 1);
      entryIdx = idx - i0;
    }
  }

  const shapes = [], annotations = [];
  const shapeX0 = candles ? candles[Math.max(0, entryIdx - initBefore)]?.[0] ?? entX : entX;
  const shapeX1 = candles ? candles[Math.min(candles.length - 1, entryIdx + initAfter)]?.[0] ?? extX : extX;

  if (sl > 0) {
    shapes.push({ type: "line", x0: shapeX0, x1: shapeX1, y0: sl, y1: sl,
      line: { color: "rgba(255,123,97,0.65)", width: 1.5, dash: "dash" } });
    annotations.push({ x: shapeX1, y: sl, text: `SL ${pxFmt(sl)}`,
      showarrow: false, xanchor: "right", font: { size: 9, color: "rgba(255,123,97,0.85)" } });
  }
  if (tp > 0) {
    shapes.push({ type: "line", x0: shapeX0, x1: shapeX1, y0: tp, y1: tp,
      line: { color: "rgba(111,217,143,0.65)", width: 1.5, dash: "dash" } });
    annotations.push({ x: shapeX1, y: tp, text: `TP ${pxFmt(tp)}`,
      showarrow: false, xanchor: "right", font: { size: 9, color: "rgba(111,217,143,0.85)" } });
  }

  let traces;
  if (candles && candles.length > 0) {
    const cdTs = candles.map(c => c[0]);
    const cdO  = candles.map(c => c[1]);
    const cdH  = candles.map(c => c[2]);
    const cdL  = candles.map(c => c[3]);
    const cdC  = candles.map(c => c[4]);
    traces = [
      { type: "candlestick", name: sym,
        x: cdTs, open: cdO, high: cdH, low: cdL, close: cdC,
        increasing: { line: { color: "rgba(111,217,143,0.9)" }, fillcolor: "rgba(111,217,143,0.5)" },
        decreasing: { line: { color: "rgba(255,123,97,0.9)"  }, fillcolor: "rgba(255,123,97,0.5)"  },
        showlegend: false,
        hovertemplate: "O:%{open}<br>H:%{high}<br>L:%{low}<br>C:%{close}<extra></extra>" },
      { type: "scatter", mode: "markers+text",
        x: [entX], y: [entY],
        marker: { symbol: dir === "buy" ? "triangle-up" : "triangle-down", size: 14, color: dirCol },
        text: ["Entry"], textposition: "top center",
        textfont: { color: dirCol, size: 10 }, showlegend: false,
        hovertemplate: `<b>Entry</b><br>${pxFmt(entY)}<br>${esc(entX.replace("T"," ").slice(0,19))}<extra></extra>` },
      { type: "scatter", mode: "markers+text",
        x: [extX], y: [extY],
        marker: { symbol: "x", size: 12, color: pnlCol, line: { width: 2 } },
        text: ["Exit"], textposition: "top center",
        textfont: { color: pnlCol, size: 10 }, showlegend: false,
        hovertemplate: `<b>Exit</b><br>${pxFmt(extY)}<br>${esc(extX.replace("T"," ").slice(0,19))}<extra></extra>` },
    ];
  } else {
    const allY = [entY, extY, sl, tp].filter(v => v > 0);
    const pad  = (Math.max(...allY) - Math.min(...allY)) * 0.15 || Math.abs(entY) * 0.001;
    traces = [
      { type: "scatter", mode: "lines",
        x: [entX, extX], y: [entY, extY],
        line: { color: pnlCol, width: 2, dash: "dot" },
        showlegend: false, hoverinfo: "skip" },
      { type: "scatter", mode: "markers+text",
        x: [entX], y: [entY],
        marker: { symbol: dir === "buy" ? "triangle-up" : "triangle-down", size: 14, color: dirCol },
        text: ["Entry"], textposition: "top center",
        textfont: { color: dirCol, size: 10 }, showlegend: false,
        hovertemplate: `<b>Entry</b><br>${pxFmt(entY)}<br>${esc(entX.replace("T"," ").slice(0,19))}<extra></extra>` },
      { type: "scatter", mode: "markers+text",
        x: [extX], y: [extY],
        marker: { symbol: "x", size: 12, color: pnlCol, line: { width: 2 } },
        text: ["Exit"], textposition: "top center",
        textfont: { color: pnlCol, size: 10 }, showlegend: false,
        hovertemplate: `<b>Exit</b><br>${pxFmt(extY)}<br>${esc(extX.replace("T"," ").slice(0,19))}<extra></extra>` },
    ];
  }

  // Initial visible x-range
  const x0init = candles ? candles[Math.max(0, entryIdx - initBefore)]?.[0] ?? entX : entX;
  const x1init = candles ? candles[Math.min(candles.length - 1, entryIdx + initAfter)]?.[0] ?? extX : extX;

  const allY2 = [entY, extY, sl, tp].filter(v => v > 0);
  const pad2  = (Math.max(...allY2) - Math.min(...allY2)) * 0.15 || Math.abs(entY) * 0.001;
  const yMin = Math.min(...allY2) - pad2;
  const yMax = Math.max(...allY2) + pad2;

  // Clear any "Loading chart…" placeholder before rendering
  chartEl.innerHTML = '';

  Plotly.react(chartEl, traces, {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    margin: { t: 12, r: 80, b: 48, l: 60 },
    hovermode: "closest",
    font: { color: cssVar("--ink-muted"), size: 11, family: "Inter, Segoe UI, sans-serif" },
    xaxis: { type: "date", tickformat: "%Y-%m-%d %H:%M", tickangle: -20,
      gridcolor: cssVar("--plot-grid"), linecolor: cssVar("--plot-grid"),
      tickfont: { color: cssVar("--ink-muted"), size: 10 },
      range: [x0init, x1init],
      rangeslider: { visible: false },
      rangebreaks: [{ bounds: ["sat", "mon"] }] },
    yaxis: { tickformat: entY < 10 ? ".5f" : ".2f",
      gridcolor: cssVar("--plot-grid"), zerolinecolor: cssVar("--plot-grid"),
      tickfont: { color: cssVar("--ink-muted"), size: 10 },
      range: candles ? undefined : [yMin, yMax] },
    shapes, annotations,
  }, { responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d","select2d","autoScale2d","toImage"] });

  // Track state for +100 buttons
  if (candles) {
    _chartState[chartId] = {
      candles, entryIdx,
      fullBars:     fullBars     ?? candles,  // full data for lazy-loaded; window for embedded
      fullEntryIdx: fullEntryIdx ?? entryIdx,
      visibleBefore: initBefore, visibleAfter: initAfter,
    };
  }

  // Wire +100 buttons (they are in the parent container, added by renderStrategyTrades)
  // The Plotly trace holds st.candles (the 301-bar window); relayout only pans within that data.
  const wrapEl = chartEl.closest(".strat-chart-wrap");
  if (wrapEl && candles) {
    wrapEl.querySelector(".candle-btn-before")?.addEventListener("click", () => {
      const st = _chartState[chartId];
      if (!st) return;
      st.visibleBefore = Math.min(st.entryIdx, st.visibleBefore + 100);
      const i0 = st.entryIdx - st.visibleBefore;
      const i1 = Math.min(st.candles.length - 1, st.entryIdx + st.visibleAfter);
      Plotly.relayout(chartEl, { "xaxis.range": [st.candles[i0][0], st.candles[i1][0]] });
    });
    wrapEl.querySelector(".candle-btn-after")?.addEventListener("click", () => {
      const st = _chartState[chartId];
      if (!st) return;
      st.visibleAfter = Math.min(st.candles.length - 1 - st.entryIdx, st.visibleAfter + 100);
      const i0 = Math.max(0, st.entryIdx - st.visibleBefore);
      const i1 = Math.min(st.candles.length - 1, st.entryIdx + st.visibleAfter);
      Plotly.relayout(chartEl, { "xaxis.range": [st.candles[i0][0], st.candles[i1][0]] });
    });
  }

  if (statsEl) {
    const msc = (label, val, color) =>
      `<div class="modal-stat-card">
         <span class="modal-stat-label">${esc(label)}</span>
         <span class="modal-stat-value" style="${color ? "color:"+color : ""}">${esc(String(val))}</span>
       </div>`;
    statsEl.innerHTML = [
      msc("Symbol",      sym, ""),
      msc("Direction",   dir.toUpperCase(), dirCol),
      msc("Entry price", pxFmt(entY), ""),
      msc("Exit price",  pxFmt(extY), ""),
      sl > 0 ? msc("SL",  pxFmt(sl),  "var(--danger)") : "",
      tp > 0 ? msc("TP",  pxFmt(tp),  "var(--good)")   : "",
      msc("P&L",         (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + " USD", pnlCol),
      msc("Bars held",   trade.bars_held ?? "—", ""),
      msc("Exit",        trade.exit_reason || "—", ""),
    ].filter(Boolean).join("");
  }
}

// ── Per-strategy history charts ───────────────────────────────────────────────
function renderPaneHistoryCharts(nickname, grp) {
  const pane = document.getElementById(`pane-${nickname}`);
  if (!pane) return;
  const activeSym = state.globalSym;
  if (!pane) return;
  let chartSection = pane.querySelector(".pane-history-charts");
  if (!chartSection) {
    chartSection = document.createElement("div");
    chartSection.className = "pane-history-charts";
    chartSection.innerHTML = `
      <p class="eyebrow" style="margin-top:24px;margin-bottom:8px">PnL &amp; runtime over time</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="panel" style="padding:12px"><div id="pane-pnl-${esc(nickname)}" style="height:200px"></div></div>
        <div class="panel" style="padding:12px"><div id="pane-rt-${esc(nickname)}" style="height:200px"></div></div>
      </div>`;
    pane.appendChild(chartSection);
  }

  const runs = getDeduplicatedRuns();
  const dates = runs.map(r => r.date);

  if (activeSym) {
    const colour = cssVar(PALETTE[0]);
    // Include all dates; use null where no data exists so category order is preserved
    const pnlYs = runs.map(run =>
      (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === nickname)
        .flatMap(b => b.symbols ?? []).filter(s => s.symbol === activeSym)
        .reduce((a, s) => a + (s.summary?.net_pnl_dollars ?? 0), 0));
    const rtYs = runs.map(run => {
      const rv = (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === nickname)
        .flatMap(b => b.symbols ?? []).filter(s => s.symbol === activeSym)
        .reduce((a, s) => a + (s.summary?.elapsed_sec ?? 0), 0);
      return rv > 0 ? rv : null;
    });
    plot(`pane-pnl-${nickname}`, [{ type:"bar", name: activeSym, x: dates, y: pnlYs,
      marker: { color: pnlYs.map(v => v >= 0 ? "rgba(111,217,143,0.85)" : "rgba(255,123,97,0.85)") } }],
      { xaxis: { type: "category" }, yaxis: { title: "USD" }, margin: { t:6, r:8, b:36, l:52 } });
    plot(`pane-rt-${nickname}`, [{ type:"scatter", mode:"lines+markers", name: activeSym, x: dates, y: rtYs,
      line: { color: colour, width: 2 }, marker: { size: 5, color: colour } }],
      { xaxis: { type: "category" }, yaxis: { title: "Seconds" }, margin: { t:6, r:8, b:36, l:52 } });
  } else {
    const symbolSet = new Set();
    for (const run of runs)
      for (const b of (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === nickname))
        for (const s of (b.symbols ?? [])) symbolSet.add(s.symbol);
    const symbols = [...symbolSet].sort();
    const pnlTraces = symbols.map((sym, i) => {
      const colour = cssVar(PALETTE[i % PALETTE.length]);
      const ys = runs.map(run =>
        (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === nickname)
          .flatMap(b => b.symbols ?? []).filter(s => s.symbol === sym)
          .reduce((a, s) => a + (s.summary?.net_pnl_dollars ?? 0), 0));
      return { type:"bar", name: sym, x: dates, y: ys, marker: { color: colour, opacity: 0.85 } };
    });
    // Fix: use full `dates` array for all rt traces to preserve category order
    const rtTraces = symbols.map((sym, i) => {
      const colour = cssVar(PALETTE[i % PALETTE.length]);
      const ys = runs.map(run => {
        const v = (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === nickname)
          .flatMap(b => b.symbols ?? []).filter(s => s.symbol === sym)
          .reduce((a, s) => a + (s.summary?.elapsed_sec ?? 0), 0);
        return v > 0 ? v : null;
      });
      return { type:"scatter", mode:"lines+markers", name: sym, x: dates, y: ys,
        line: { color: colour, width: 1.5 }, marker: { size: 4, color: colour } };
    });
    plot(`pane-pnl-${nickname}`, pnlTraces, { barmode: "stack", xaxis: { type: "category" }, yaxis: { title: "USD" }, margin: { t:6, r:8, b:36, l:52 } });
    plot(`pane-rt-${nickname}`, rtTraces, { xaxis: { type: "category" }, yaxis: { title: "Seconds" }, margin: { t:6, r:8, b:36, l:52 } });
  }
}

function statCard(label, value, meta, color = "") {
  return `<div class="stat-card">
    <span class="eyebrow">${esc(label)}</span>
    <span class="stat-val" style="${color ? "color:" + color : ""}">${esc(String(value))}</span>
    <span class="stat-meta">${esc(meta)}</span>
  </div>`;
}

// ── Per-pane: alerts (consecutive-run comparison) ─────────────────────────────
function renderPaneAlerts(nickname, benchmarks) {
  const el = document.getElementById(`alerts-${nickname}`);
  if (!el) return;
  const cards = [];
  for (const b of benchmarks) {
    const label = b.window ? `${b.window.start} → ${b.window.end}` : b.public_name;
    if (hasConsecutiveFingerprintChange(b.id)) {
      const latest = getLatestRun();
      const lb = (latest?.benchmarks ?? []).find(bm => bm.id === b.id);
      const inputChanged = lb?.status?.input_changed_since_last_real_run === true;
      if (inputChanged) {
        cards.push({ kind: "warn",
          title: `${label}: input data or config changed`,
          body: "The OHLC data or strategy config changed since the last run. The fingerprint difference is expected — re-run to establish a new baseline." });
      } else {
        cards.push({ kind: "alert",
          title: `${label}: result fingerprint changed vs previous run`,
          body: "Same input data, different trade outputs. This is a code regression — the strategy produced different results despite identical inputs." });
      }
    }
    if (hasConsecutivePnlDrift(b.id)) {
      cards.push({ kind: "warn",
        title: `${label}: PnL drift vs previous run`,
        body: "Net PnL shifted by more than 5% compared to the preceding run. Review recent changes for unintended impact." });
    }
    if (b.status?.speed === "alert") {
      cards.push({ kind: "warn",
        title: `${label}: runtime anomaly`,
        body: "Latest runtime exceeds the tracked upper runtime band." });
    }
  }
  if (!cards.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = cards.map(c => `
    <article class="alert-card ${c.kind}">
      <h3>${esc(c.title)}</h3>
      <p>${esc(c.body)}</p>
    </article>
  `).join("");
}

// ── Per-pane: month grid ───────────────────────────────────────────────────────
function renderPaneMonths(nickname, benchmarks) {
  const el = document.getElementById(`months-${nickname}`);
  if (!el) return;

  const maxAbsPnl = Math.max(1, ...benchmarks.map(b => Math.abs(b.summary?.net_pnl_dollars ?? 0)));

  el.innerHTML = benchmarks.map((b, idx) => {
    const pnl = b.summary?.net_pnl_dollars ?? 0;
    const pct = Math.min(100, Math.abs(pnl) / maxAbsPnl * 100);
    const barColor = pnl >= 0 ? "var(--good)" : "var(--danger)";
    // Use consecutive-run comparison for the ⚠ changed badge
    const fingerprintChanged = hasConsecutiveFingerprintChange(b.id);
    const inputChanged = b.status?.input_changed_since_last_real_run === true;
    const hasTrueRegression = fingerprintChanged && !inputChanged;
    const hasAlert = hasTrueRegression || hasConsecutivePnlDrift(b.id);
    const alertBadge = hasTrueRegression
      ? `<span class="pill alert" style="margin-left:8px;font-size:.7rem">⚠ changed</span>`
      : (fingerprintChanged && inputChanged)
        ? `<span class="pill warn" style="margin-left:8px;font-size:.7rem">⚠ data</span>`
        : "";
    const label = b.window
      ? (b.window.start.slice(0, 7) === b.window.end.slice(0, 7)
          ? b.window.start.slice(0, 7)
          : `${b.window.start.slice(0, 7)} \u2192 ${b.window.end.slice(0, 7)}`)
      : b.public_name;

    return `
      <div class="month-card" id="mc-${esc(nickname)}-${idx}" data-idx="${idx}" data-nick="${esc(nickname)}">
        <span class="month-label">${esc(label)}${alertBadge}</span>
        <div class="month-bars"><div class="month-bars-fill" style="width:${pct}%;background:${barColor}"></div></div>
        <span class="month-pnl" style="color:${barColor}">${currency.format(pnl)}</span>
      </div>
      <div class="month-detail" id="md-${esc(nickname)}-${idx}">
        ${buildSymbolTable(b)}
        ${buildTradesSection(b)}
      </div>
    `;
  }).join("");

  el.querySelectorAll(".month-card").forEach(card => {
    card.addEventListener("click", () => {
      const idx = card.dataset.idx;
      const detail = document.getElementById(`md-${nickname}-${idx}`);
      detail.classList.toggle("open");
      card.classList.toggle("expanded");
    });
  });
}

function buildSymbolTable(benchmark) {
  const rows = benchmark.symbols ?? [];
  const prev = getPreviousRun();
  const prevBench = prev ? (prev.benchmarks ?? []).find(b => b.id === benchmark.id) : null;
  if (!rows.length) return `<p class="empty-state" style="padding:12px">No per-symbol data.</p>`;
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Symbol</th><th>Trades</th><th>Win rate</th><th>Net PnL</th><th>Runtime</th><th>vs Prev Run</th><th>Fingerprint</th>
    </tr></thead>
    <tbody>${rows.map(row => {
      const s = row.summary ?? {};
      const prevRow = prevBench ? (prevBench.symbols ?? []).find(pr => pr.symbol === row.symbol) : null;
      const prevPnl = prevRow?.summary?.net_pnl_dollars ?? null;
      const curPnl = s.net_pnl_dollars ?? 0;
      let vsLabel = "n/a", vsPill = "pass";
      if (prevPnl !== null) {
        const delta = curPnl - prevPnl;
        vsLabel = (delta >= 0 ? "+" : "") + currency.format(delta);
        vsPill = Math.abs(delta) > Math.abs(prevPnl || 1) * 0.05 ? "alert" : "pass";
      }
      return `<tr>
        <td><strong>${esc(row.symbol)}</strong></td>
        <td>${s.trade_count ?? 0}</td>
        <td>${fmt(s.win_rate_pct, 1)}%</td>
        <td style="color:${curPnl >= 0 ? "var(--good)" : "var(--danger)"}">${currency.format(curPnl)}</td>
        <td>${fmt(s.elapsed_sec, 2)}s</td>
        <td><span class="pill ${vsPill}">${esc(vsLabel)}</span></td>
        <td style="font-family:monospace;font-size:0.8rem;color:var(--ink-muted)">${esc((s.result_fingerprint ?? "").slice(0,10))}</td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

// ── Per-pane: scope card ───────────────────────────────────────────────────────
function renderPaneScope(nickname, benchmark) {
  const el = document.getElementById(`scope-${nickname}`);
  if (!el || !benchmark) return;
  const sym = benchmark.symbol_scope?.symbols ?? [];
  el.innerHTML = `
    <p class="eyebrow">Benchmark scope</p>
    <h3>${esc(benchmark.public_name ?? nickname)}</h3>
    <div class="scope-stack" style="margin-top:12px">
      ${scopeLine("Config", benchmark.config_path_hint ?? "n/a")}
      ${scopeLine("Primary TF", benchmark.timeframes?.primary ?? "n/a")}
      ${scopeLine("Upper TF", benchmark.timeframes?.upper ?? "n/a")}
      <div class="scope-line" style="flex-direction:column;gap:8px">
        <span class="scope-label">Symbol basket</span>
        <div class="scope-list-value">${sym.map(s => `<span class="chip">${esc(s)}</span>`).join("")}</div>
      </div>
    </div>
  `;
}

// ── Per-pane: integrity card ───────────────────────────────────────────────────
function renderPaneIntegrity(nickname, run) {
  const el = document.getElementById(`integrity-${nickname}`);
  if (!el) return;
  const ref = state.history?.reference ?? {};
  el.innerHTML = `
    <p class="eyebrow">Reproducibility</p>
    <h3>Sanitized traceability</h3>
    <div class="scope-stack" style="margin-top:12px">
      ${scopeLine("Repo commit", run?.repo?.short_commit ?? "unknown")}
      ${scopeLine("Branch", run?.repo?.branch ?? "unknown")}
      ${scopeLine("Baseline source", ref.baseline_source ?? "n/a")}
      ${scopeLine("Baseline commit", ref.baseline_commit ?? "not tagged")}
      ${scopeLine("PnL tolerance", fmt(ref.pnl_tolerance, 2))}
    </div>
    <p style="font-size:.82rem;color:var(--ink-muted);margin-top:12px">
      Exact parameters stay private. The dashboard only exposes hashes, fixed window/symbol scope, and aggregate outcomes.
    </p>
  `;
}

function scopeLine(label, value) {
  return `<div class="scope-line"><span class="scope-label">${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

// ── Footer ────────────────────────────────────────────────────────────────────
function renderFooter() {
  const el = document.getElementById("footer-copy");
  if (!el) return;
  const r = getLatestRun();
  const ref = state.history?.reference ?? {};
  el.textContent = `Generated ${state.history?.generated_at ?? "n/a"} · commit ${r?.repo?.short_commit ?? "unknown"} · baseline ${ref.baseline_commit ?? "not tagged"} · public output contains hashes and aggregates only`;
}

// ── Trades section inside month detail ───────────────────────────────────────
function buildTradesSection(benchmark) {
  const allTrades = [];
  for (const row of (benchmark.symbols ?? [])) {
    for (const t of (row.trades ?? [])) {
      allTrades.push({ ...t, _sym: row.symbol });
    }
  }
  if (!allTrades.length) return "";

  const key = benchmark.id;
  _benchmarkTrades[key] = allTrades;

  const pxFmt = v => {
    const n = Number(v);
    if (isNaN(n) || n === 0) return "—";
    return n < 10 ? n.toFixed(5) : n.toFixed(2);
  };

  const rows = allTrades.map((t, i) => {
    const pnl = t.pnl_net ?? 0;
    const isWin = pnl > 0;
    const exitClass = t.exit_reason === "tp" ? "tp" : t.exit_reason === "sl" ? "sl" : "neutral";
    return `<tr class="trade-row" data-tkey="${esc(key)}" data-tidx="${i}">
      <td><strong>${esc(t._sym)}</strong></td>
      <td><span class="badge badge-${esc(t.direction || '')}">${esc((t.direction || '').toUpperCase())}</span></td>
      <td>${esc(String(t.entry_time || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${esc(String(t.exit_time  || '').replace('T', ' ').slice(0, 19))}</td>
      <td style="font-size:.8rem">${pxFmt(t.entry_price)}</td>
      <td style="font-size:.8rem">${pxFmt(t.exit_price)}</td>
      <td style="color:${isWin ? 'var(--good)' : 'var(--danger)'}; font-weight:600">${isWin ? '+' : ''}${Number(pnl).toFixed(2)}</td>
      <td>${esc(t.bars_held ?? '')}</td>
      <td><span class="badge badge-${exitClass}">${esc(t.exit_reason || '—')}</span></td>
    </tr>`;
  }).join("");

  return `
    <div class="trades-section">
      <details>
        <summary class="trades-summary">&#9654; ${allTrades.length} individual trades — click to expand (click row to visualize)</summary>
        <div class="table-wrap" style="margin-top:8px">
          <table>
            <thead><tr>
              <th>Symbol</th><th>Dir</th><th>Entry time</th><th>Exit time</th>
              <th>Entry px</th><th>Exit px</th><th>P&amp;L</th><th>Bars</th><th>Exit</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </details>
    </div>`;
}

// ── Trade Modal ───────────────────────────────────────────────────────────────
function openTradeModal(trade) {
  const modal = document.getElementById("trade-modal");
  if (!modal) return;

  const sym  = trade._sym || "—";
  const dir  = String(trade.direction || "").toLowerCase();
  const entX = String(trade.entry_time || "");
  const extX = String(trade.exit_time  || "");
  const entY = Number(trade.entry_price || 0);
  const extY = Number(trade.exit_price  || 0);
  const sl   = Number(trade.stop_loss ?? 0);
  const tp   = Number(trade.take_profit ?? 0);
  const pnl  = Number(trade.pnl_net ?? 0);
  const isWin = pnl > 0;
  const exitReason = trade.exit_reason || "—";
  const bars = trade.bars_held ?? "—";
  const lots = trade.lots ?? "—";

  const pxFmt  = v => { const n = Number(v); return n < 10 ? n.toFixed(5) : n.toFixed(2); };
  const dirCol  = dir === "buy" ? cssVar("--good") : cssVar("--warn");
  const pnlCol  = isWin ? cssVar("--good") : cssVar("--danger");

  document.getElementById("modal-title").textContent = `${sym} — ${dir.toUpperCase()} trade`;

  const chipsEl = document.getElementById("modal-chips");
  chipsEl.innerHTML = [
    `<span class="modal-chip chip-${dir}">${dir.toUpperCase()}</span>`,
    `<span class="modal-chip chip-neutral">${esc(sym)}</span>`,
    `<span class="modal-chip chip-${isWin ? 'win' : 'loss'}">${isWin ? '+' : ''}${pnl.toFixed(2)} USD</span>`,
    `<span class="modal-chip chip-${exitReason === 'tp' ? 'tp' : exitReason === 'sl' ? 'sl' : 'neutral'}">${esc(exitReason)} exit</span>`,
  ].join("");

  const candles    = trade.candles ?? null;
  const entryIdx   = trade.candles_entry_idx ?? 0;
  const initBefore = trade.candles_init_before ?? 60;
  const initAfter  = trade.candles_init_after  ?? 40;

  const shapes = [], annotations = [];
  const shapeX0 = candles ? candles[Math.max(0, entryIdx - initBefore)]?.[0] ?? entX : entX;
  const shapeX1 = candles ? candles[Math.min(candles.length - 1, entryIdx + initAfter)]?.[0] ?? extX : extX;
  if (sl > 0) {
    shapes.push({ type: "line", x0: shapeX0, x1: shapeX1, y0: sl, y1: sl,
      line: { color: "rgba(255,123,97,0.65)", width: 1.5, dash: "dash" } });
    annotations.push({ x: shapeX1, y: sl, text: `SL ${pxFmt(sl)}`,
      showarrow: false, xanchor: "right", font: { size: 10, color: "rgba(255,123,97,0.85)" },
      bgcolor: "rgba(0,0,0,0)" });
  }
  if (tp > 0) {
    shapes.push({ type: "line", x0: shapeX0, x1: shapeX1, y0: tp, y1: tp,
      line: { color: "rgba(111,217,143,0.65)", width: 1.5, dash: "dash" } });
    annotations.push({ x: shapeX1, y: tp, text: `TP ${pxFmt(tp)}`,
      showarrow: false, xanchor: "right", font: { size: 10, color: "rgba(111,217,143,0.85)" },
      bgcolor: "rgba(0,0,0,0)" });
  }

  let traces;
  const x0init = candles ? candles[Math.max(0, entryIdx - initBefore)]?.[0] ?? entX : entX;
  const x1init = candles ? candles[Math.min(candles.length - 1, entryIdx + initAfter)]?.[0] ?? extX : extX;

  if (candles && candles.length > 0) {
    const cdTs = candles.map(c => c[0]);
    const cdO  = candles.map(c => c[1]);
    const cdH  = candles.map(c => c[2]);
    const cdL  = candles.map(c => c[3]);
    const cdC  = candles.map(c => c[4]);
    traces = [
      { type: "candlestick", name: sym,
        x: cdTs, open: cdO, high: cdH, low: cdL, close: cdC,
        increasing: { line: { color: "rgba(111,217,143,0.9)" }, fillcolor: "rgba(111,217,143,0.5)" },
        decreasing: { line: { color: "rgba(255,123,97,0.9)"  }, fillcolor: "rgba(255,123,97,0.5)"  },
        showlegend: false,
        hovertemplate: "O:%{open}<br>H:%{high}<br>L:%{low}<br>C:%{close}<extra></extra>" },
      { type: "scatter", mode: "markers+text",
        x: [entX], y: [entY],
        marker: { symbol: dir === "buy" ? "triangle-up" : "triangle-down", size: 16, color: dirCol },
        text: ["Entry"], textposition: "top center",
        textfont: { color: dirCol, size: 11 }, showlegend: false,
        hovertemplate: `<b>Entry</b><br>Price: ${pxFmt(entY)}<br>Time: ${esc(entX.replace("T"," ").slice(0,19))}<extra></extra>` },
      { type: "scatter", mode: "markers+text",
        x: [extX], y: [extY],
        marker: { symbol: "x", size: 14, color: pnlCol, line: { width: 2 } },
        text: ["Exit"], textposition: "top center",
        textfont: { color: pnlCol, size: 11 }, showlegend: false,
        hovertemplate: `<b>Exit</b><br>Price: ${pxFmt(extY)}<br>Time: ${esc(extX.replace("T"," ").slice(0,19))}<extra></extra>` },
    ];
  } else {
    const allY = [entY, extY, sl, tp].filter(v => v > 0);
    const yMin = Math.min(...allY) * (dir === "buy" ? 0.9997 : 1.0003);
    const yMax = Math.max(...allY) * (dir === "buy" ? 1.0003 : 0.9997);
    traces = [
      { type: "scatter", mode: "lines",
        x: [entX, extX], y: [entY, extY],
        line: { color: pnlCol, width: 2.5, dash: "dot" },
        showlegend: false, hoverinfo: "skip" },
      { type: "scatter", mode: "markers+text",
        x: [entX], y: [entY],
        marker: { symbol: dir === "buy" ? "triangle-up" : "triangle-down", size: 16, color: dirCol },
        text: ["Entry"], textposition: "top center",
        textfont: { color: dirCol, size: 11 }, showlegend: false,
        hovertemplate: `<b>Entry</b><br>Price: ${pxFmt(entY)}<br>Time: ${esc(entX.replace("T"," ").slice(0,19))}<extra></extra>` },
      { type: "scatter", mode: "markers+text",
        x: [extX], y: [extY],
        marker: { symbol: "x", size: 14, color: pnlCol, line: { width: 2 } },
        text: ["Exit"], textposition: "top center",
        textfont: { color: pnlCol, size: 11 }, showlegend: false,
        hovertemplate: `<b>Exit</b><br>Price: ${pxFmt(extY)}<br>Time: ${esc(extX.replace("T"," ").slice(0,19))}<extra></extra>` },
    ];
  }

  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    margin: { t: 16, r: 90, b: 52, l: 70 },
    hovermode: "closest",
    font: { color: cssVar("--ink-muted"), size: 12, family: "Inter, Segoe UI, sans-serif" },
    xaxis: { type: "date", tickformat: "%Y-%m-%d %H:%M", tickangle: -25,
      gridcolor: cssVar("--plot-grid"), linecolor: cssVar("--plot-grid"),
      tickfont: { color: cssVar("--ink-muted"), size: 10 },
      range: [x0init, x1init],
      rangeslider: { visible: false },
      rangebreaks: [{ bounds: ["sat", "mon"] }] },
    yaxis: { tickformat: entY < 10 ? ".5f" : ".2f",
      gridcolor: cssVar("--plot-grid"), zerolinecolor: cssVar("--plot-grid"),
      tickfont: { color: cssVar("--ink-muted"), size: 10 } },
    shapes, annotations,
  };

  const el = document.getElementById("modal-chart");
  Plotly.react(el, traces, layout, { responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d","select2d","autoScale2d","toImage"] });

  // +100 buttons for modal
  const btnWrap = document.getElementById("modal-candle-btns");
  const btnBefore = document.getElementById("modal-candle-before");
  const btnAfter  = document.getElementById("modal-candle-after");
  if (btnWrap) {
    if (candles) {
      btnWrap.style.display = "flex";
      _chartState["modal-chart"] = { candles, entryIdx,
        visibleBefore: initBefore, visibleAfter: initAfter };
      // Replace listeners (remove old ones by replacing nodes)
      const newBefore = btnBefore.cloneNode(true);
      const newAfter  = btnAfter.cloneNode(true);
      btnBefore.replaceWith(newBefore);
      btnAfter.replaceWith(newAfter);
      document.getElementById("modal-candle-before").addEventListener("click", () => {
        const st = _chartState["modal-chart"];
        if (!st) return;
        st.visibleBefore = Math.min(st.entryIdx, st.visibleBefore + 100);
        const i0 = st.entryIdx - st.visibleBefore;
        const i1 = Math.min(st.candles.length - 1, st.entryIdx + st.visibleAfter);
        Plotly.relayout(el, { "xaxis.range": [st.candles[i0][0], st.candles[i1][0]] });
      });
      document.getElementById("modal-candle-after").addEventListener("click", () => {
        const st = _chartState["modal-chart"];
        if (!st) return;
        st.visibleAfter = Math.min(st.candles.length - 1 - st.entryIdx, st.visibleAfter + 100);
        const i0 = Math.max(0, st.entryIdx - st.visibleBefore);
        const i1 = Math.min(st.candles.length - 1, st.entryIdx + st.visibleAfter);
        Plotly.relayout(el, { "xaxis.range": [st.candles[i0][0], st.candles[i1][0]] });
      });
    } else {
      btnWrap.style.display = "none";
    }
  }

  // Stats row
  const statsEl = document.getElementById("modal-stats");
  const msc = (label, val, color) =>
    `<div class="modal-stat-card">
       <span class="modal-stat-label">${esc(label)}</span>
       <span class="modal-stat-value" style="${color ? 'color:'+color : ''}">${esc(String(val))}</span>
     </div>`;
  statsEl.innerHTML = [
    msc("Entry price",  pxFmt(entY), ""),
    msc("Exit price",   pxFmt(extY), ""),
    sl > 0 ? msc("Stop loss",   pxFmt(sl),  "var(--danger)") : "",
    tp > 0 ? msc("Take profit", pxFmt(tp),  "var(--good)")   : "",
    msc("P&L",          (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + " USD", pnlCol),
    msc("Bars held",    bars, ""),
    lots !== "—" ? msc("Lots", lots, "") : "",
    msc("Entry time",   String(entX || "—").replace("T"," ").slice(0,19), ""),
    msc("Exit time",    String(extX || "—").replace("T"," ").slice(0,19), ""),
    msc("Exit reason",  exitReason, ""),
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
  if (overlay) {
    overlay.addEventListener("click", e => { if (e.target === overlay) closeTradeModal(); });
  }
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeTradeModal(); });

// Event delegation for benchmark trade-row clicks → opens modal.
// Skips .strat-trade-row which handles expansion inline via its own listener.
document.addEventListener("click", e => {
  const row = e.target.closest(".trade-row");
  if (!row || row.classList.contains("strat-trade-row")) return;
  const tkey = row.dataset.tkey;
  const tidx = parseInt(row.dataset.tidx, 10);
  if (tkey && !isNaN(tidx) && _benchmarkTrades[tkey]) {
    openTradeModal(_benchmarkTrades[tkey][tidx]);
  }
});

// ── CI: trigger monitoring workflow via GitHub API ────────────────────────────
function _getCiConfig() {
  return {
    pat:  localStorage.getItem(GH_CI_PAT_KEY)  || "",
    repo: localStorage.getItem(GH_CI_REPO_KEY) || "",
  };
}

function _saveCiConfig(pat, repo, remember) {
  if (remember) {
    localStorage.setItem(GH_CI_PAT_KEY,  pat);
    localStorage.setItem(GH_CI_REPO_KEY, repo);
  } else {
    localStorage.removeItem(GH_CI_PAT_KEY);
    localStorage.removeItem(GH_CI_REPO_KEY);
  }
}

function _updateCiBtn(state, label) {
  const btn = document.getElementById("ci-run-btn");
  if (!btn) return;
  btn.textContent = label;
  btn.disabled = state === "running";
  btn.className = "ci-run-btn" + (state === "running" ? " ci-running" : state === "success" ? " ci-success" : state === "failed" ? " ci-failed" : "");
}

async function _triggerCiWorkflow(pat, repo) {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${GH_CI_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: "master", inputs: { reason: "Dashboard manual trigger" } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
}

async function _pollCiCompletion(triggeredAt, pat, repo) {
  // Poll /actions/runs to find the workflow run started after triggeredAt
  const maxAttempts = 36;  // 36 × 10s = 6 min timeout
  const delay = ms => new Promise(r => setTimeout(r, ms));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await delay(attempt === 0 ? 5000 : 10000);
    try {
      const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=5&event=workflow_dispatch`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const run = (data.workflow_runs ?? []).find(r => new Date(r.created_at) >= triggeredAt);
      if (!run) continue;

      const elapsed = Math.round((Date.now() - triggeredAt) / 1000);
      _updateCiBtn("running", `\u23F3 CI running\u2026 ${elapsed}s`);

      if (run.status === "completed") {
        return run.conclusion;   // "success" | "failure" etc.
      }
    } catch (_) { /* network error — keep polling */ }
  }
  return "timeout";
}

function _showCiModal() {
  const modal = document.getElementById("ci-config-modal");
  if (!modal) return;
  const cfg = _getCiConfig();
  const repoInput = document.getElementById("ci-repo-input");
  const patInput  = document.getElementById("ci-pat-input");
  if (repoInput && cfg.repo) repoInput.value = cfg.repo;
  if (patInput  && cfg.pat)  patInput.value  = cfg.pat;
  modal.style.display = "flex";

  const closeModal = () => { modal.style.display = "none"; };

  document.getElementById("ci-modal-close")?.addEventListener("click",  closeModal, { once: true });
  document.getElementById("ci-modal-cancel")?.addEventListener("click", closeModal, { once: true });
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); }, { once: true });

  document.getElementById("ci-modal-run")?.addEventListener("click", async () => {
    const repo = repoInput?.value.trim() ?? "";
    const pat  = patInput?.value.trim() ?? "";
    const remember = document.getElementById("ci-remember-check")?.checked ?? true;

    if (!repo || !repo.includes("/")) {
      repoInput?.focus();
      repoInput?.setCustomValidity("Enter owner/repo");
      repoInput?.reportValidity();
      return;
    }
    if (!pat || !pat.startsWith("gh")) {
      patInput?.focus();
      patInput?.setCustomValidity("Enter a valid GitHub PAT");
      patInput?.reportValidity();
      return;
    }

    _saveCiConfig(pat, repo, remember);
    closeModal();

    _updateCiBtn("running", "\u23F3 Triggering\u2026");
    const triggeredAt = new Date(Date.now() - 2000); // small buffer for clock skew

    try {
      await _triggerCiWorkflow(pat, repo);
    } catch (err) {
      _updateCiBtn("failed", "\u2717 Trigger failed");
      console.error("CI trigger error:", err);
      setTimeout(() => _updateCiBtn("", "\u25BA Run backtests"), 5000);
      return;
    }

    _ci.triggeredAt = triggeredAt;
    _updateCiBtn("running", "\u23F3 CI running\u2026 0s");

    const conclusion = await _pollCiCompletion(triggeredAt, pat, repo);

    if (conclusion === "success") {
      _updateCiBtn("success", "\u2713 Done \u2014 refreshing");
      // Wait briefly then refresh dashboard data
      setTimeout(() => loadDashboardData({ showSpinner: false }).finally(() => {
        _updateCiBtn("", "\u25BA Run backtests");
      }), 3000);
    } else if (conclusion === "timeout") {
      _updateCiBtn("failed", "\u231B Timed out \u2014 check GH Actions");
      setTimeout(() => _updateCiBtn("", "\u25BA Run backtests"), 8000);
    } else {
      _updateCiBtn("failed", `\u2717 CI ${conclusion}`);
      setTimeout(() => _updateCiBtn("", "\u25BA Run backtests"), 6000);
    }
  }, { once: true });
}

// Wire CI button
document.addEventListener("DOMContentLoaded", () => {
  const ciBtn = document.getElementById("ci-run-btn");
  if (ciBtn) {
    ciBtn.addEventListener("click", () => {
      if (ciBtn.disabled) return;
      const { pat, repo } = _getCiConfig();
      // If both PAT and repo are already stored, confirm-then-trigger; else show modal
      if (pat && repo) {
        _showCiModal();   // still show modal so user can verify config
      } else {
        _showCiModal();
      }
    });
  }
});