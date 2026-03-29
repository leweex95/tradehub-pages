const state = {
  history: null,
  benchmarkId: null,
  symbol: "ALL",
  metric: "net_pnl_dollars",
  includeSynthetic: true,
};

const els = {
  heroMeta: document.getElementById("hero-meta"),
  demoBanner: document.getElementById("demo-banner"),
  benchmarkSelect: document.getElementById("benchmark-select"),
  symbolSelect: document.getElementById("symbol-select"),
  metricSelect: document.getElementById("metric-select"),
  syntheticToggle: document.getElementById("synthetic-toggle"),
  summaryGrid: document.getElementById("summary-grid"),
  runtimeChart: document.getElementById("runtime-chart"),
  metricChart: document.getElementById("metric-chart"),
  dailyChart: document.getElementById("daily-chart"),
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

fetch("monitoring-history.json")
  .then((response) => response.json())
  .then((history) => {
    state.history = history;
    const latestRun = getLatestRealRun();
    state.benchmarkId = latestRun?.benchmarks?.[0]?.id || null;
    populateControls();
    bindEvents();
    render();
  })
  .catch((error) => {
    document.body.innerHTML = `<main class="page"><section class="panel"><p class="empty-state">Failed to load dashboard data: ${String(error)}</p></section></main>`;
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
  els.syntheticToggle.addEventListener("change", () => {
    state.includeSynthetic = els.syntheticToggle.checked;
    render();
  });
}

function populateControls() {
  const latestRun = getLatestRealRun();
  const benchmarks = latestRun?.benchmarks || [];
  els.benchmarkSelect.innerHTML = benchmarks
    .map((benchmark) => `<option value="${benchmark.id}">${escapeHtml(benchmark.public_name)}</option>`)
    .join("");
  els.metricSelect.value = state.metric;
  els.syntheticToggle.checked = state.includeSynthetic;
  rebuildSymbolOptions();
}

function rebuildSymbolOptions() {
  const latestBenchmark = getLatestBenchmark();
  const symbols = latestBenchmark ? latestBenchmark.symbols.map((item) => item.symbol) : [];
  const values = ["ALL", ...symbols];
  if (!values.includes(state.symbol)) {
    state.symbol = "ALL";
  }
  els.symbolSelect.innerHTML = values
    .map((value) => `<option value="${value}">${value === "ALL" ? "All symbols" : escapeHtml(value)}</option>`)
    .join("");
  els.symbolSelect.value = state.symbol;
}

function getRuns() {
  const runs = state.history?.runs || [];
  return runs.filter((run) => state.includeSynthetic || !run.is_synthetic);
}

function getLatestRealRun() {
  const runs = state.history?.runs || [];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (!runs[index].is_synthetic) {
      return runs[index];
    }
  }
  return runs[runs.length - 1] || null;
}

function getBenchmark(run, benchmarkId = state.benchmarkId) {
  return run?.benchmarks?.find((item) => item.id === benchmarkId) || null;
}

function getLatestBenchmark() {
  return getBenchmark(getLatestRealRun());
}

function benchmarkSeries(metricKey, runtimeMode = false) {
  return getRuns()
    .map((run) => {
      const benchmark = getBenchmark(run);
      if (!benchmark) {
        return null;
      }
      const source = state.symbol === "ALL"
        ? benchmark.summary
        : benchmark.symbols.find((item) => item.symbol === state.symbol)?.summary;
      if (!source) {
        return null;
      }
      const value = runtimeMode ? source.elapsed_sec : source[metricKey];
      return {
        label: run.date,
        value: typeof value === "number" ? value : null,
        isSynthetic: Boolean(run.is_synthetic),
      };
    })
    .filter(Boolean);
}

function render() {
  renderHero();
  renderSummary();
  renderRuntimeChart();
  renderMetricChart();
  renderSymbolTable();
  renderDailyChart();
  renderAlerts();
  renderFooter();
}

function renderHero() {
  const latestRun = getLatestRealRun();
  const benchmark = getLatestBenchmark();
  const meta = state.history?.history_meta || {};
  els.heroMeta.innerHTML = `
    <article class="hero-stat">
      <span class="eyebrow">Latest Real Run</span>
      <strong>${escapeHtml(latestRun?.date || "n/a")}</strong>
      <span>${escapeHtml(latestRun?.repo?.short_commit || "unknown")} ${latestRun?.repo?.dirty ? "- dirty worktree" : ""}</span>
    </article>
    <article class="hero-stat">
      <span class="eyebrow">Suite History</span>
      <strong>${meta.real_run_count || 0} real / ${meta.synthetic_run_count || 0} demo</strong>
      <span>${escapeHtml(state.history?.reference?.baseline_source || "baseline unavailable")}</span>
    </article>
    <article class="hero-stat">
      <span class="eyebrow">Selected Benchmark</span>
      <strong>${escapeHtml(benchmark?.public_name || "n/a")}</strong>
      <span>${escapeHtml(state.symbol === "ALL" ? "Aggregate view" : state.symbol)}</span>
    </article>
  `;

  if ((meta.synthetic_run_count || 0) > 0) {
    els.demoBanner.classList.remove("hidden");
    els.demoBanner.textContent = "Seeded demo history is present so the first dashboard has trend lines immediately. Toggle it off to view only real runs.";
  } else {
    els.demoBanner.classList.add("hidden");
  }
}

function renderSummary() {
  const benchmark = getLatestBenchmark();
  const source = state.symbol === "ALL"
    ? benchmark?.summary
    : benchmark?.symbols.find((item) => item.symbol === state.symbol)?.summary;
  if (!benchmark || !source) {
    els.summaryGrid.innerHTML = `<section class="panel summary-card"><p class="empty-state">No benchmark data available.</p></section>`;
    return;
  }

  const baselineStatus = benchmark.status.profitability;
  const speedStatus = benchmark.status.speed;
  const fingerprintStatus = benchmark.status.fingerprint;

  const cards = [
    { label: "Runtime", value: `${formatNumber(source.elapsed_sec, 2)}s`, meta: speedLabel(speedStatus), status: pillClass(speedStatus) },
    { label: "Rows / sec", value: formatNumber(source.rows_per_sec, 2), meta: "Normalized speed", status: "info" },
    { label: "Net PnL", value: currency.format(source.net_pnl_dollars || 0), meta: metricLabel(state.metric), status: source.net_pnl_dollars >= 0 ? "pass" : "warn" },
    { label: "Stability", value: `${formatNumber(source.win_rate_pct, 2)}%`, meta: `Baseline ${baselineStatus} / result ${fingerprintStatus}`, status: pillClass(baselineStatus === "fail" || fingerprintStatus === "changed" ? "alert" : "pass") },
  ];

  els.summaryGrid.innerHTML = cards.map((card) => `
    <section class="panel summary-card">
      <span class="eyebrow">${escapeHtml(card.label)}</span>
      <div class="value">${escapeHtml(card.value)}</div>
      <div class="meta"><span class="pill ${card.status}">${escapeHtml(card.meta)}</span></div>
    </section>
  `).join("");
}

function renderRuntimeChart() {
  const benchmark = getLatestBenchmark();
  const series = benchmarkSeries(state.metric, true);
  const band = benchmark?.history_summary || {};
  els.runtimeNote.textContent = band.status === "ready"
    ? `Median ${formatNumber(band.median_sec, 2)}s, alert above ${formatNumber(band.upper_bound_sec, 2)}s (${band.sample_size} comparable real runs)`
    : "Needs at least 5 comparable real runs before the runtime alert band becomes meaningful.";
  drawLineChart(els.runtimeChart, series, {
    valueFormatter: (value) => `${formatNumber(value, 2)}s`,
    bandUpper: band.upper_bound_sec,
    bandCenter: band.median_sec,
  });
}

function renderMetricChart() {
  const series = benchmarkSeries(state.metric, false);
  els.metricNote.textContent = state.symbol === "ALL"
    ? "Aggregate benchmark trend."
    : `Per-symbol trend for ${state.symbol}.`;
  drawLineChart(els.metricChart, series, {
    valueFormatter: formatMetricValue(state.metric),
  });
}

function renderSymbolTable() {
  const benchmark = getLatestBenchmark();
  const breaches = new Map((benchmark?.baseline?.symbol_breaches || []).map((item) => [item.symbol, item]));
  const rows = benchmark?.symbols || [];
  els.symbolTableBody.innerHTML = rows.map((row) => {
    const breach = breaches.get(row.symbol);
    const baselineLabel = breach
      ? `drift ${formatSignedNumber(breach.pnl_delta || 0, 2)}`
      : "match";
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

function renderDailyChart() {
  const benchmark = getLatestBenchmark();
  const source = state.symbol === "ALL"
    ? benchmark?.summary
    : benchmark?.symbols.find((item) => item.symbol === state.symbol)?.summary;
  const daily = source?.daily || [];
  els.dailyNote.textContent = state.symbol === "ALL"
    ? "Aggregated by benchmark."
    : `Exit-day realized PnL for ${state.symbol}.`;
  drawBarChart(els.dailyChart, daily.map((item) => ({
    label: item.day,
    value: item.net_pnl_dollars,
  })), (value) => currency.format(value || 0));
}

function renderAlerts() {
  const latestRun = getLatestRealRun();
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
        body: "Latest runtime is above the statistically tracked alert band.",
        kind: "warn",
      });
    }
    if (benchmark.status.fingerprint === "changed") {
      cards.push({
        title: `${benchmark.public_name}: result fingerprint changed`,
        body: benchmark.status.input_changed_since_last_real_run
          ? "Result hash changed together with the sanitized input fingerprint. Treat as input drift first."
          : "Result hash changed while sanitized input fingerprint stayed stable. This is a stronger regression signal.",
        kind: benchmark.status.input_changed_since_last_real_run ? "warn" : "alert",
      });
    }
  }

  if (!cards.length) {
    cards.push({
      title: "No active regression alerts",
      body: "Latest run is within the current profitability and runtime expectations for all configured benchmarks.",
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
  const latestRun = getLatestRealRun();
  const reference = state.history?.reference || {};
  els.footerCopy.textContent = `Generated ${state.history?.generated_at || "n/a"} / latest real commit ${latestRun?.repo?.short_commit || "unknown"} / baseline ${reference.baseline_commit || "not tagged"} / public output contains hashes and aggregates only.`;
}

function drawLineChart(svg, series, options = {}) {
  const width = 860;
  const height = 300;
  const margin = { top: 20, right: 22, bottom: 36, left: 56 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const values = series.map((point) => point.value).filter((value) => typeof value === "number");

  if (!values.length) {
    svg.innerHTML = `<text x="36" y="48" fill="#647384" font-size="14">No data available.</text>`;
    return;
  }

  let min = Math.min(...values);
  let max = Math.max(...values);
  if (typeof options.bandUpper === "number") {
    max = Math.max(max, options.bandUpper);
  }
  if (typeof options.bandCenter === "number") {
    max = Math.max(max, options.bandCenter);
    min = Math.min(min, options.bandCenter);
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.12;
  min -= pad;
  max += pad;

  const x = (index) => margin.left + (index / Math.max(1, series.length - 1)) * innerWidth;
  const y = (value) => margin.top + innerHeight - ((value - min) / (max - min)) * innerHeight;

  const grid = [];
  for (let step = 0; step <= 4; step += 1) {
    const value = min + ((max - min) * step / 4);
    const yPos = y(value);
    grid.push(`<line x1="${margin.left}" y1="${yPos}" x2="${width - margin.right}" y2="${yPos}" stroke="rgba(32,48,63,0.10)" />`);
    grid.push(`<text x="10" y="${yPos + 4}" fill="#647384" font-size="12">${escapeHtml(options.valueFormatter ? options.valueFormatter(value) : formatNumber(value, 2))}</text>`);
  }

  const path = series.map((point, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(point.value)}`).join(" ");
  const points = series.map((point, index) => `
    <circle cx="${x(index)}" cy="${y(point.value)}" r="${point.isSynthetic ? 3.4 : 4.4}" fill="${point.isSynthetic ? "#d97706" : "#0f766e"}">
      <title>${escapeHtml(point.label)}: ${escapeHtml(options.valueFormatter ? options.valueFormatter(point.value) : String(point.value))}${point.isSynthetic ? " (demo seed)" : ""}</title>
    </circle>
  `).join("");

  const xLabels = series.map((point, index) => `
    <text x="${x(index)}" y="${height - 12}" text-anchor="middle" fill="#647384" font-size="11">${escapeHtml(point.label.slice(5))}</text>
  `).join("");

  const band = typeof options.bandUpper === "number" && typeof options.bandCenter === "number"
    ? `
      <line x1="${margin.left}" y1="${y(options.bandUpper)}" x2="${width - margin.right}" y2="${y(options.bandUpper)}" stroke="#c2410c" stroke-dasharray="6 6" />
      <line x1="${margin.left}" y1="${y(options.bandCenter)}" x2="${width - margin.right}" y2="${y(options.bandCenter)}" stroke="#0f766e" stroke-dasharray="4 4" />
    `
    : "";

  svg.innerHTML = `
    <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
    ${grid.join("")}
    ${band}
    <path d="${path}" fill="none" stroke="#0f766e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
    ${points}
    ${xLabels}
  `;
}

function drawBarChart(svg, items, valueFormatter) {
  const width = 860;
  const height = 300;
  const margin = { top: 18, right: 20, bottom: 48, left: 56 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const values = items.map((item) => item.value);

  if (!values.length) {
    svg.innerHTML = `<text x="36" y="48" fill="#647384" font-size="14">No per-day trades in the latest run.</text>`;
    return;
  }

  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = Math.max(1, max - min);
  const y = (value) => margin.top + innerHeight - ((value - min) / span) * innerHeight;
  const zeroY = y(0);
  const barWidth = innerWidth / Math.max(items.length, 1);

  const bars = items.map((item, index) => {
    const x = margin.left + index * barWidth + 6;
    const currentY = y(item.value);
    const heightValue = Math.max(4, Math.abs(currentY - zeroY));
    const fill = item.value >= 0 ? "#0f766e" : "#c2410c";
    return `
      <rect x="${x}" y="${Math.min(currentY, zeroY)}" width="${Math.max(12, barWidth - 12)}" height="${heightValue}" rx="6" fill="${fill}">
        <title>${escapeHtml(item.label)}: ${escapeHtml(valueFormatter(item.value))}</title>
      </rect>
      <text x="${x + Math.max(12, barWidth - 12) / 2}" y="${height - 16}" text-anchor="middle" fill="#647384" font-size="11">${escapeHtml(item.label.slice(5))}</text>
    `;
  }).join("");

  svg.innerHTML = `
    <line x1="${margin.left}" y1="${zeroY}" x2="${width - margin.right}" y2="${zeroY}" stroke="rgba(32,48,63,0.18)" />
    ${bars}
  `;
}

function pillClass(status) {
  if (status === "fail" || status === "alert" || status === "changed") {
    return "alert";
  }
  if (status === "warn" || status === "insufficient_history") {
    return "warn";
  }
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

function formatMetricValue(metric) {
  return (value) => {
    if (metric === "net_pnl_dollars") return currency.format(value || 0);
    if (metric === "win_rate_pct") return `${formatNumber(value, 2)}%`;
    if (metric === "profit_factor") return formatNumber(value, 2);
    return formatNumber(value, 2);
  };
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return Number(value).toFixed(digits);
}

function formatSignedNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
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
