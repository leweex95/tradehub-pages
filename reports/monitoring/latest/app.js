const THEME_KEY = "tradehub-monitoring-theme";

const state = {
  history: null,
  benchmarkId: null,
  symbol: "ALL",
  metric: "net_pnl_dollars",
  theme: localStorage.getItem(THEME_KEY) || "dark",
};

const els = {
  benchmarkSelect: document.getElementById("benchmark-select"),
  symbolSelect: document.getElementById("symbol-select"),
  metricSelect: document.getElementById("metric-select"),
  themeSelect: document.getElementById("theme-select"),
  heroMeta: document.getElementById("hero-meta"),
  summaryGrid: document.getElementById("summary-grid"),
  scopeCard: document.getElementById("scope-card"),
  integrityCard: document.getElementById("integrity-card"),
  runtimeNote: document.getElementById("runtime-note"),
  metricNote: document.getElementById("metric-note"),
  dailyNote: document.getElementById("daily-note"),
  symbolTableBody: document.querySelector("#symbol-table tbody"),
  alertsList: document.getElementById("alerts-list"),
  footerCopy: document.getElementById("footer-copy"),
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

applyTheme(state.theme);

fetch("monitoring-history.json")
  .then((response) => response.json())
  .then((history) => {
    state.history = history;
    state.benchmarkId = history?.benchmarks?.[0]?.id || getLatestRun()?.benchmarks?.[0]?.id || null;
    populateControls();
    bindEvents();
    render();
  })
  .catch((error) => {
    document.body.innerHTML = `<main class="page"><section class="panel"><p class="empty-state">Failed to load dashboard data: ${escapeHtml(String(error))}</p></section></main>`;
  });

function bindEvents() {
  els.benchmarkSelect.addEventListener("change", () => {
    state.benchmarkId = els.benchmarkSelect.value;
    rebuildSymbolOptions();
    render();
  });
  els.symbolSelect.addEventListener("change", () => {
    state.symbol = els.symbolSelect.value;
    render();
  });
  els.metricSelect.addEventListener("change", () => {
    state.metric = els.metricSelect.value;
    render();
  });
  els.themeSelect.addEventListener("change", () => {
    state.theme = els.themeSelect.value;
    localStorage.setItem(THEME_KEY, state.theme);
    applyTheme(state.theme);
    render();
  });
  window.addEventListener("resize", debounce(renderChartsOnly, 120));
}

function populateControls() {
  const benchmarks = state.history?.benchmarks || [];
  els.benchmarkSelect.innerHTML = benchmarks
    .map((benchmark) => `<option value="${benchmark.id}">${escapeHtml(benchmark.public_name)}</option>`)
    .join("");
  els.benchmarkSelect.value = state.benchmarkId;
  els.metricSelect.value = state.metric;
  els.themeSelect.value = state.theme;
  rebuildSymbolOptions();
}

function rebuildSymbolOptions() {
  const benchmark = getLatestBenchmark();
  const symbols = benchmark?.symbol_scope?.symbols || [];
  const values = ["ALL", ...symbols];
  if (!values.includes(state.symbol)) {
    state.symbol = "ALL";
  }
  els.symbolSelect.innerHTML = values
    .map((value) => `<option value="${value}">${value === "ALL" ? "All symbols" : escapeHtml(value)}</option>`)
    .join("");
  els.symbolSelect.value = state.symbol;
}

function render() {
  renderHero();
  renderSummary();
  renderScopeCards();
  renderChartsOnly();
  renderSymbolTable();
  renderAlerts();
  renderFooter();
}

function renderChartsOnly() {
  renderRuntimeChart();
  renderMetricChart();
  renderDailyChart();
}

function renderHero() {
  const latestRun = getLatestRun();
  const latestBenchmark = getLatestBenchmark();
  const meta = state.history?.history_meta || {};
  els.heroMeta.innerHTML = `
    <article class="hero-stat">
      <p class="eyebrow">Latest Real Run</p>
      <strong>${escapeHtml(latestRun?.date || "n/a")}</strong>
      <span>${escapeHtml(latestRun?.repo?.short_commit || "unknown")}${latestRun?.repo?.dirty ? " - dirty worktree" : ""}</span>
    </article>
    <article class="hero-stat">
      <p class="eyebrow">History Coverage</p>
      <strong>${meta.real_run_count || 0} daily point${(meta.real_run_count || 0) === 1 ? "" : "s"}</strong>
      <span>No repeated same-day same-commit runs counted twice.</span>
    </article>
    <article class="hero-stat">
      <p class="eyebrow">Selected Strategy</p>
      <strong>${escapeHtml(latestBenchmark?.public_name || "n/a")}</strong>
      <span>${escapeHtml(state.symbol === "ALL" ? "Aggregate view" : `Symbol ${state.symbol}`)}</span>
    </article>
  `;
}

function renderSummary() {
  const benchmark = getLatestBenchmark();
  const source = getSelectedSource(benchmark);
  if (!benchmark || !source) {
    els.summaryGrid.innerHTML = `<section class="summary-card"><p class="empty-state">No benchmark data available.</p></section>`;
    return;
  }

  const cards = [
    {
      label: "Runtime",
      value: `${formatNumber(source.elapsed_sec, 2)}s`,
      meta: speedLabel(benchmark.status.speed),
      status: pillClass(benchmark.status.speed),
    },
    {
      label: "Rows / sec",
      value: formatNumber(source.rows_per_sec, 2),
      meta: "Normalized throughput",
      status: "info",
    },
    {
      label: "Net PnL",
      value: currency.format(source.net_pnl_dollars || 0),
      meta: metricLabel(state.metric),
      status: source.net_pnl_dollars >= 0 ? "pass" : "warn",
    },
    {
      label: "Result Stability",
      value: `${formatNumber(source.win_rate_pct, 2)}%`,
      meta: `Baseline ${benchmark.status.profitability} / fingerprint ${benchmark.status.fingerprint}`,
      status: pillClass(
        benchmark.status.profitability === "fail" || benchmark.status.fingerprint === "changed"
          ? "alert"
          : benchmark.status.speed
      ),
    },
  ];

  els.summaryGrid.innerHTML = cards.map((card) => `
    <section class="summary-card">
      <p class="eyebrow">${escapeHtml(card.label)}</p>
      <span class="summary-value">${escapeHtml(card.value)}</span>
      <p class="summary-meta"><span class="pill ${card.status}">${escapeHtml(card.meta)}</span></p>
    </section>
  `).join("");
}

function renderScopeCards() {
  const benchmark = getLatestBenchmark();
  if (!benchmark) {
    els.scopeCard.innerHTML = `<p class="empty-state">No scope metadata available.</p>`;
    els.integrityCard.innerHTML = "";
    return;
  }

  els.scopeCard.innerHTML = `
    <p class="eyebrow">Benchmark Scope</p>
    <h2>${escapeHtml(benchmark.public_name)}</h2>
    <div class="scope-stack">
      ${scopeLine("Time range", `${benchmark.window.start} -> ${benchmark.window.end}`)}
      ${scopeLine("Primary timeframe", benchmark.timeframes.primary)}
      ${scopeLine("Upper timeframe", benchmark.timeframes.upper)}
      ${scopeLine("Config hint", benchmark.config_path_hint)}
      ${scopeList("Symbols", benchmark.symbol_scope.symbols)}
    </div>
  `;

  const latestRun = getLatestRun();
  els.integrityCard.innerHTML = `
    <p class="eyebrow">Reproducibility</p>
    <h2>Sanitized traceability</h2>
    <div class="scope-stack">
      ${scopeLine("Repo commit", latestRun?.repo?.short_commit || "unknown")}
      ${scopeLine("Branch", latestRun?.repo?.branch || "unknown")}
      ${scopeLine("Baseline source", state.history?.reference?.baseline_source || "n/a")}
      ${scopeLine("Baseline commit", state.history?.reference?.baseline_commit || "not tagged")}
      ${scopeLine("PnL tolerance", formatNumber(state.history?.reference?.pnl_tolerance, 2))}
    </div>
    <p class="scope-body">Exact parameters stay private. The dashboard only exposes hashes, fixed window/symbol scope, and aggregate outcomes.</p>
  `;
}

function renderRuntimeChart() {
  const benchmark = getLatestBenchmark();
  const series = benchmarkSeries((source) => source.elapsed_sec);
  const band = benchmark?.history_summary || {};
  els.runtimeNote.textContent = band.status === "ready"
    ? `Median ${formatNumber(band.median_sec, 2)}s, alert above ${formatNumber(band.upper_bound_sec, 2)}s across ${band.sample_size} comparable runs.`
    : "Needs at least 5 comparable runs before the runtime alert band becomes statistically meaningful.";

  const traces = [
    {
      type: "scatter",
      mode: "lines+markers",
      x: series.map((item) => item.date),
      y: series.map((item) => item.value),
      customdata: series.map((item) => [item.commit, item.window, item.symbolLabel]),
      line: { color: cssVar("--accent"), width: 3 },
      marker: { color: cssVar("--accent"), size: 8 },
      hovertemplate:
        "<b>%{x}</b><br>Runtime: %{y:.2f}s<br>Commit: %{customdata[0]}<br>Window: %{customdata[1]}<br>Scope: %{customdata[2]}<extra></extra>",
      name: "Runtime",
    },
  ];

  if (typeof band.upper_bound_sec === "number") {
    traces.push(horizontalBandTrace(series, band.upper_bound_sec, "Alert band", cssVar("--danger"), "dash"));
  }
  if (typeof band.median_sec === "number") {
    traces.push(horizontalBandTrace(series, band.median_sec, "Median", cssVar("--muted"), "dot"));
  }

  plot("runtime-chart", traces, { yaxis: { title: "Seconds" } });
}

function renderMetricChart() {
  const series = benchmarkSeries((source) => source[state.metric]);
  els.metricNote.textContent = state.symbol === "ALL"
    ? "Aggregate benchmark trend across the fixed symbol basket."
    : `Per-symbol trend for ${state.symbol}.`;
  plot("metric-chart", [
    {
      type: "scatter",
      mode: "lines+markers",
      x: series.map((item) => item.date),
      y: series.map((item) => item.value),
      customdata: series.map((item) => [item.commit, item.valueLabel]),
      line: { color: cssVar("--accent"), width: 3 },
      marker: { color: cssVar("--accent"), size: 8 },
      hovertemplate:
        "<b>%{x}</b><br>Value: %{customdata[1]}<br>Commit: %{customdata[0]}<extra></extra>",
      name: metricLabel(state.metric),
    },
  ], { yaxis: { title: metricAxisLabel(state.metric) } });
}

function renderDailyChart() {
  const benchmark = getLatestBenchmark();
  const source = getSelectedSource(benchmark);
  const daily = source?.daily || [];
  els.dailyNote.textContent = state.symbol === "ALL"
    ? "Aggregate exit-day PnL across the benchmark scope."
    : `Exit-day realized PnL for ${state.symbol}.`;

  plot("daily-chart", [
    {
      type: "bar",
      x: daily.map((item) => item.day),
      y: daily.map((item) => item.net_pnl_dollars),
      marker: {
        color: daily.map((item) => item.net_pnl_dollars >= 0 ? cssVar("--accent") : cssVar("--danger")),
      },
      customdata: daily.map((item) => [item.trade_count]),
      hovertemplate:
        "<b>%{x}</b><br>Net PnL: %{y:$,.2f}<br>Trades: %{customdata[0]}<extra></extra>",
      name: "Daily PnL",
    },
  ], { yaxis: { title: "USD" } });
}

function renderSymbolTable() {
  const benchmark = getLatestBenchmark();
  const breaches = new Map((benchmark?.baseline?.symbol_breaches || []).map((item) => [item.symbol, item]));
  const rows = benchmark?.symbols || [];
  els.symbolTableBody.innerHTML = rows.map((row) => {
    const breach = breaches.get(row.symbol);
    const baselineLabel = breach ? `drift ${formatSignedNumber(breach.pnl_delta || 0, 2)}` : "match";
    return `
      <tr>
        <td><strong>${escapeHtml(row.symbol)}</strong></td>
        <td>${formatNumber(row.summary.elapsed_sec, 2)}s</td>
        <td>${formatNumber(row.summary.rows_per_sec, 2)}</td>
        <td>${row.summary.trade_count}</td>
        <td>${formatNumber(row.summary.win_rate_pct, 2)}%</td>
        <td>${currency.format(row.summary.net_pnl_dollars || 0)}</td>
        <td><span class="pill ${breach ? "alert" : "pass"}">${escapeHtml(baselineLabel)}</span></td>
        <td>${escapeHtml((row.summary.result_fingerprint || "").slice(0, 10))}</td>
      </tr>
    `;
  }).join("");
}

function renderAlerts() {
  const latestRun = getLatestRun();
  const cards = [];
  for (const benchmark of latestRun?.benchmarks || []) {
    if (benchmark.status.profitability === "fail") {
      cards.push({
        title: `${benchmark.public_name}: profitability drift`,
        body: `${benchmark.baseline.symbol_breaches.length || 0} symbol-level breach(es) against the fixed regression baseline.`,
        kind: "alert",
      });
    }
    if (benchmark.status.speed === "alert") {
      cards.push({
        title: `${benchmark.public_name}: runtime anomaly`,
        body: "Latest runtime is above the tracked upper runtime band for the same scope and inputs.",
        kind: "warn",
      });
    }
    if (benchmark.status.fingerprint === "changed") {
      cards.push({
        title: `${benchmark.public_name}: result fingerprint changed`,
        body: benchmark.status.input_changed_since_last_real_run
          ? "Result hash changed together with the sanitized input fingerprint, so this looks more like input drift."
          : "Result hash changed while sanitized input fingerprint stayed stable, which is a stronger regression signal.",
        kind: benchmark.status.input_changed_since_last_real_run ? "warn" : "alert",
      });
    }
  }

  if (!cards.length) {
    cards.push({
      title: "No active regression alerts",
      body: "Latest run is within the tracked profitability and runtime expectations for every monitored strategy.",
      kind: "pass",
    });
  }

  els.alertsList.innerHTML = cards.map((card) => `
    <article class="alert-card ${card.kind}">
      <h3>${escapeHtml(card.title)}</h3>
      <p>${escapeHtml(card.body)}</p>
    </article>
  `).join("");
}

function renderFooter() {
  const latestRun = getLatestRun();
  els.footerCopy.textContent =
    `Generated ${state.history?.generated_at || "n/a"} / latest real commit ${latestRun?.repo?.short_commit || "unknown"} / baseline ${state.history?.reference?.baseline_commit || "not tagged"} / public output contains hashes and aggregates only.`;
}

function benchmarkSeries(valueSelector) {
  return getRuns().map((run) => {
    const benchmark = getBenchmark(run);
    const source = getSelectedSource(benchmark);
    const value = source ? valueSelector(source) : null;
    return {
      date: run.date,
      value,
      commit: run.repo?.short_commit || "unknown",
      window: benchmark ? `${benchmark.window.start} -> ${benchmark.window.end}` : "n/a",
      symbolLabel: state.symbol === "ALL" ? (benchmark?.symbol_scope?.symbols || []).join(", ") : state.symbol,
      valueLabel: formatMetricValue(state.metric)(value),
    };
  }).filter((item) => item.value !== null && item.value !== undefined);
}

function getRuns() {
  return state.history?.runs || [];
}

function getLatestRun() {
  const runs = getRuns();
  return runs[runs.length - 1] || null;
}

function getBenchmark(run, benchmarkId = state.benchmarkId) {
  return run?.benchmarks?.find((item) => item.id === benchmarkId) || null;
}

function getLatestBenchmark() {
  return getBenchmark(getLatestRun());
}

function getSelectedSource(benchmark) {
  if (!benchmark) {
    return null;
  }
  if (state.symbol === "ALL") {
    return benchmark.summary;
  }
  return benchmark.symbols.find((item) => item.symbol === state.symbol)?.summary || null;
}

function plot(id, traces, extraLayout = {}) {
  const layout = {
    paper_bgcolor: cssVar("--plot-paper"),
    plot_bgcolor: cssVar("--plot-paper"),
    margin: { t: 16, r: 16, b: 44, l: 58 },
    hovermode: "x unified",
    font: { color: cssVar("--ink"), family: "Segoe UI, Arial, sans-serif" },
    xaxis: {
      gridcolor: cssVar("--plot-grid"),
      linecolor: cssVar("--plot-grid"),
      tickfont: { color: cssVar("--muted") },
    },
    yaxis: {
      gridcolor: cssVar("--plot-grid"),
      zerolinecolor: cssVar("--plot-grid"),
      tickfont: { color: cssVar("--muted") },
    },
    legend: { orientation: "h", x: 0, y: 1.16, font: { color: cssVar("--muted") } },
    ...extraLayout,
  };
  Plotly.react(id, traces, layout, {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  });
}

function horizontalBandTrace(series, value, name, color, dash) {
  return {
    type: "scatter",
    mode: "lines",
    x: series.map((item) => item.date),
    y: series.map(() => value),
    line: { color, width: 2, dash },
    hovertemplate: `<b>${escapeHtml(name)}</b><br>${value.toFixed(2)}<extra></extra>`,
    name,
  };
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
}

function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function scopeLine(label, value) {
  return `
    <div class="scope-line">
      <span class="scope-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function scopeList(label, values) {
  return `
    <div class="scope-line">
      <span class="scope-list-label">${escapeHtml(label)}</span>
      <div class="scope-list-value">${values.map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join("")}</div>
    </div>
  `;
}

function pillClass(status) {
  if (status === "fail" || status === "alert" || status === "changed") return "alert";
  if (status === "warn" || status === "insufficient_history") return "warn";
  return "pass";
}

function speedLabel(status) {
  if (status === "alert") return "runtime alert";
  if (status === "insufficient_history") return "tracking";
  return "stable";
}

function metricLabel(metric) {
  return {
    net_pnl_dollars: "PnL stability",
    win_rate_pct: "Win rate stability",
    trade_count: "Trade count stability",
    profit_factor: "Profit factor stability",
  }[metric] || metric;
}

function metricAxisLabel(metric) {
  return {
    net_pnl_dollars: "USD",
    win_rate_pct: "Percent",
    trade_count: "Trades",
    profit_factor: "Factor",
  }[metric] || metric;
}

function formatMetricValue(metric) {
  return (value) => {
    if (metric === "net_pnl_dollars") return currency.format(value || 0);
    if (metric === "win_rate_pct") return `${formatNumber(value, 2)}%`;
    return formatNumber(value, 2);
  };
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return Number(value).toFixed(digits);
}

function formatSignedNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${Number(value).toFixed(digits)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function debounce(fn, delay) {
  let timeout = null;
  return () => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(fn, delay);
  };
}
