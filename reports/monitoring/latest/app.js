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
  stratFilter: null,   // null = all; string = strategy nickname
  tabSymFilter: {},    // { nickname: symbol | null }
};

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
  return hasConsecutiveFingerprintChange(b.id) || hasConsecutivePnlDrift(b.id);
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
fetch("monitoring-history.json").then(r => r.json()).then(monData => {
  state.history = monData;
  const stratGroups = groupBenchmarksByStrategy(getLatestRun()?.benchmarks ?? []);
  state.activeTab = stratGroups[0]?.nickname ?? null;
  boot(stratGroups);
}).catch(err => {
  document.body.innerHTML = `<main class="page"><div class="panel" style="padding:32px"><p class="empty-state">Failed to load dashboard data: ${esc(String(err))}</p></div></main>`;
});

// ── Theme toggle ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, state.theme);
    document.documentElement.dataset.theme = state.theme;
    renderCharts();   // redraw Plotly after palette change
  });
});

window.addEventListener("resize", debounce(renderCharts, 120));

// ── Root boot ─────────────────────────────────────────────────────────────────
function boot(stratGroups) {
  renderHero();
  renderHeaderStatus();
  renderStratFilter(stratGroups);
  renderAggCharts(stratGroups);
  renderAggLegend(stratGroups);
  renderTabs(stratGroups);
  renderFooter();
}

function renderCharts() {
  const stratGroups = groupBenchmarksByStrategy(getLatestRun()?.benchmarks ?? []);
  renderAggCharts(stratGroups);
  // also redraw any open pane charts
  if (state.activeTab) renderTabPane(state.activeTab, stratGroups);
}

// ── Hero ──────────────────────────────────────────────────────────────────────
function renderHero() {
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

// ── Strategy filter ───────────────────────────────────────────────────────────
function renderStratFilter(stratGroups) {
  const el = document.getElementById("strat-filter");
  if (!el) return;
  const active = state.stratFilter;
  const btns = [
    `<button class="filter-btn${active === null ? " active" : ""}" data-strat="">All strategies</button>`,
    ...stratGroups.map(g =>
      `<button class="filter-btn${active === g.nickname ? " active" : ""}" data-strat="${esc(g.nickname)}">${esc(g.public_name)}</button>`
    ),
  ].join("");
  el.innerHTML = `<span class="filter-label">Filter:</span><div class="filter-btns">${btns}</div>`;
  el.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.stratFilter = btn.dataset.strat || null;
      renderStratFilter(stratGroups);
      renderAggCharts(stratGroups);
    });
  });
}

// ── Aggregate charts (all strategies, all runs, deduped) ──────────────────────
function renderAggCharts(stratGroups) {
  const runs = getDeduplicatedRuns();  // ← one entry per calendar date

  if (state.stratFilter) {
    // Filtered view: per-symbol stacked bars for selected strategy
    const grp = stratGroups.find(g => g.nickname === state.stratFilter);
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
    const rtTraces = symbols.map((sym, i) => {
      const colour = cssVar(PALETTE[i % PALETTE.length]);
      const ys = runs.map(run =>
        (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === grp.nickname)
          .flatMap(b => b.symbols ?? []).filter(s => s.symbol === sym)
          .reduce((a, s) => a + (s.summary?.elapsed_sec ?? 0), 0));
      return { type: "scatter", mode: "lines+markers", name: sym, x: dates, y: ys,
        line: { color: colour, width: 2 }, marker: { color: colour, size: 5 },
        hovertemplate: `<b>${esc(sym)}</b><br>%{x}: %{y:.2f}s<extra></extra>` };
    });

    plot("agg-pnl-chart", pnlTraces, { barmode: "stack", xaxis: { type: "category" }, yaxis: { title: "USD" } });
    plot("agg-runtime-chart", rtTraces, { yaxis: { title: "Seconds" } });
    document.getElementById("agg-pnl-note").textContent = `Per-symbol net PnL for ${grp.public_name} — one bar per run date.`;
    document.getElementById("agg-runtime-note").textContent = `Per-symbol runtime breakdown for ${grp.public_name}.`;
    return;
  }

  // Unfiltered view: one trace per strategy
  const rtTraces = stratGroups.map((grp, i) => {
    const colour = cssVar(PALETTE[i % PALETTE.length]);
    const xs = [], ys = [];
    for (const run of runs) {
      const sum = (run.benchmarks ?? [])
        .filter(b => strategyNicknameOf(b) === grp.nickname)
        .reduce((acc, b) => acc + (b.summary?.elapsed_sec ?? 0), 0);
      if (sum > 0) { xs.push(run.date); ys.push(sum); }
    }
    return { type: "scatter", mode: "lines+markers", name: grp.public_name, x: xs, y: ys,
      line: { color: colour, width: 2.5 }, marker: { color: colour, size: 6 },
      hovertemplate: `<b>${esc(grp.public_name)}</b><br>%{x}: %{y:.2f}s<extra></extra>` };
  });
  plot("agg-runtime-chart", rtTraces, { yaxis: { title: "Total seconds" } });
  document.getElementById("agg-runtime-note").textContent = "Sum of all benchmark runtimes per run date across each strategy.";

  const pnlTraces = stratGroups.map((grp, i) => {
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
}

function renderAggLegend(stratGroups) {
  const el = document.getElementById("agg-legend");
  if (!el) return;
  el.innerHTML = stratGroups.map((grp, i) => {
    const colour = cssVar(PALETTE[i % PALETTE.length]);
    return `<span class="legend-chip"><span class="legend-dot" style="background:${colour}"></span>${esc(grp.public_name)}</span>`;
  }).join("");
}

// ── Tabs ───────────────────────────────────────────────────────────────────────
function renderTabs(stratGroups) {
  const bar = document.getElementById("tabs-bar");
  const panes = document.getElementById("tab-panes");
  if (!bar || !panes) return;

  bar.innerHTML = stratGroups.map(grp => {
    const latestRun = getLatestRun();
    const benchmarks = (latestRun?.benchmarks ?? []).filter(b => strategyNicknameOf(b) === grp.nickname);
    const alertCount = benchmarks.filter(b => benchmarkHasAlert(b)).length;
    const badge = alertCount > 0
      ? `<span class="tab-badge">${alertCount}</span>`
      : `<span class="tab-badge ok">✓</span>`;
    const active = grp.nickname === state.activeTab ? "active" : "";
    return `<button class="tab-btn ${active}" role="tab" data-tab="${esc(grp.nickname)}">${esc(grp.public_name)}${badge}</button>`;
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

  // Collect all unique symbols across all benchmarks for this strategy
  const symbolSet = new Set();
  for (const b of allBenchmarks) for (const s of (b.symbols ?? [])) symbolSet.add(s.symbol);
  const allSymbols = [...symbolSet].sort();

  // Respect symbol filter
  const activeSym = state.tabSymFilter[nickname] ?? null;
  const benchmarks = activeSym
    ? allBenchmarks.filter(b => (b.symbols ?? []).some(s => s.symbol === activeSym))
    : allBenchmarks;

  const totalTrades  = benchmarks.reduce((a,b) => a + (b.summary?.trade_count ?? 0), 0);
  const totalWins    = benchmarks.reduce((a,b) => a + (b.summary?.wins ?? 0), 0);
  const totalPnl     = benchmarks.reduce((a,b) => a + (b.summary?.net_pnl_dollars ?? 0), 0);
  const totalElapsed = benchmarks.reduce((a,b) => a + (b.summary?.elapsed_sec ?? 0), 0);
  const winRate      = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
  const alertCount   = benchmarks.filter(b => benchmarkHasAlert(b)).length;

  const symChips = allSymbols.length > 1 ? `
    <div class="symbol-filter">
      <span class="filter-label">Symbol:</span>
      <button class="filter-chip${activeSym === null ? " active" : ""}" data-sym="">All</button>
      ${allSymbols.map(sym =>
        `<button class="filter-chip${activeSym === sym ? " active" : ""}" data-sym="${esc(sym)}">${esc(sym)}</button>`
      ).join("")}
    </div>` : "";

  pane.innerHTML = `
    ${symChips}
    <div class="stat-row">
      ${statCard("Total trades", totalTrades, "")}
      ${statCard("Win rate", fmt(winRate, 1) + "%", "across all months & symbols")}
      ${statCard("Net PnL", currency.format(totalPnl), "all months combined", totalPnl >= 0 ? "var(--good)" : "var(--danger)")}
      ${statCard("Runtime", fmt(totalElapsed, 1) + "s", "total across benchmarks")}
      ${statCard("Alerts", alertCount || "✓", alertCount ? "vs previous run" : "no changes vs prev run", alertCount > 0 ? "var(--danger)" : "var(--good)")}
    </div>

    <div class="alerts-list" id="alerts-${esc(nickname)}"></div>

    <div class="month-grid-wrap">
      <p class="eyebrow">Month-by-month breakdown</p>
      <div class="month-grid" id="months-${esc(nickname)}"></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div class="panel" style="padding:18px" id="scope-${esc(nickname)}"></div>
      <div class="panel" style="padding:18px" id="integrity-${esc(nickname)}"></div>
    </div>
  `;

  // Wire symbol filter chip clicks
  pane.querySelectorAll(".filter-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      state.tabSymFilter[nickname] = chip.dataset.sym || null;
      renderTabPane(nickname, stratGroups);
    });
  });

  renderPaneAlerts(nickname, benchmarks);
  renderPaneMonths(nickname, benchmarks);
  const suiteMeta = (state.history?.benchmarks ?? []).find(b => b.id === (benchmarks[0]?.id ?? ""));
  renderPaneScope(nickname, suiteMeta ?? benchmarks[0] ?? null);
  renderPaneIntegrity(nickname, latestRun);
  renderPaneHistoryCharts(nickname, grp, activeSym);
}

// ── Per-strategy history charts ───────────────────────────────────────────────
function renderPaneHistoryCharts(nickname, grp, activeSym) {
  const pane = document.getElementById(`pane-${nickname}`);
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
    const pnlYs = runs.map(run =>
      (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === nickname)
        .flatMap(b => b.symbols ?? []).filter(s => s.symbol === activeSym)
        .reduce((a, s) => a + (s.summary?.net_pnl_dollars ?? 0), 0));
    const rtYs = runs.map(run =>
      (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === nickname)
        .flatMap(b => b.symbols ?? []).filter(s => s.symbol === activeSym)
        .reduce((a, s) => a + (s.summary?.elapsed_sec ?? 0), 0));
    plot(`pane-pnl-${nickname}`, [{ type:"bar", name: activeSym, x: dates, y: pnlYs,
      marker: { color: pnlYs.map(v => v >= 0 ? "rgba(111,217,143,0.85)" : "rgba(255,123,97,0.85)") } }],
      { xaxis: { type: "category" }, yaxis: { title: "USD" }, margin: { t:6, r:8, b:36, l:52 } });
    plot(`pane-rt-${nickname}`, [{ type:"scatter", mode:"lines+markers", name: activeSym, x: dates, y: rtYs,
      line: { color: colour, width: 2 }, marker: { size: 5, color: colour } }],
      { yaxis: { title: "Seconds" }, margin: { t:6, r:8, b:36, l:52 } });
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
    const rtTraces = symbols.map((sym, i) => {
      const colour = cssVar(PALETTE[i % PALETTE.length]);
      const ys = runs.map(run =>
        (run.benchmarks ?? []).filter(b => strategyNicknameOf(b) === nickname)
          .flatMap(b => b.symbols ?? []).filter(s => s.symbol === sym)
          .reduce((a, s) => a + (s.summary?.elapsed_sec ?? 0), 0));
      return { type:"scatter", mode:"lines+markers", name: sym, x: dates, y: ys,
        line: { color: colour, width: 1.5 }, marker: { size: 4, color: colour } };
    });
    plot(`pane-pnl-${nickname}`, pnlTraces, { barmode: "stack", xaxis: { type: "category" }, yaxis: { title: "USD" }, margin: { t:6, r:8, b:36, l:52 } });
    plot(`pane-rt-${nickname}`, rtTraces, { yaxis: { title: "Seconds" }, margin: { t:6, r:8, b:36, l:52 } });
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
      cards.push({ kind: "alert",
        title: `${label}: result fingerprint changed vs previous run`,
        body: "The trade output hash differs from the prior monitoring run. This indicates a code or data change that affected results." });
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
    cards.push({ kind: "pass",
      title: "No regressions vs previous run",
      body: "Results and PnL are consistent with the preceding monitoring run." });
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
    const hasAlert = hasConsecutiveFingerprintChange(b.id) || hasConsecutivePnlDrift(b.id);
    const alertBadge = hasAlert
      ? `<span class="pill alert" style="margin-left:8px;font-size:.7rem">⚠ changed</span>` : "";
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