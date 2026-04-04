#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import html
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORTS_DIR = ROOT / "reports"
INDEX_FILE = ROOT / "index.html"
UTC = dt.timezone.utc
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
COMPARISON_HINTS = ("comparison", "compare", "vs", "benchmark")


@dataclass
class Report:
    rel_path: str
    title: str
    updated_at: dt.datetime
    is_comparison: bool


def run_git(args: list[str]) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return ""
    return result.stdout.strip()


def last_commit_time(path: Path) -> dt.datetime:
    rel = path.relative_to(ROOT).as_posix()
    committed = run_git(["log", "-1", "--format=%cI", "--", rel])
    if committed:
        try:
            return dt.datetime.fromisoformat(committed.replace("Z", "+00:00")).astimezone(UTC)
        except ValueError:
            pass
    return dt.datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)


def extract_title(path: Path) -> str:
    fallback = path.stem.replace("-", " ").replace("_", " ").strip().title()
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return fallback
    match = TITLE_RE.search(text[:12000])
    if not match:
        return fallback
    extracted = " ".join(match.group(1).split()).strip()
    return extracted or fallback


def collect_reports() -> list[Report]:
    if not REPORTS_DIR.exists():
        return []

    reports: list[Report] = []
    for path in REPORTS_DIR.rglob("*.html"):
        rel = path.relative_to(ROOT).as_posix()
        name_lc = path.name.lower()
        reports.append(
            Report(
                rel_path=rel,
                title=extract_title(path),
                updated_at=last_commit_time(path),
                is_comparison=any(hint in name_lc for hint in COMPARISON_HINTS),
            )
        )
    reports.sort(key=lambda item: (item.updated_at, item.rel_path), reverse=True)
    return reports


def format_utc(timestamp: dt.datetime) -> str:
    return timestamp.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")


def render_latest(report: Report | None, label: str) -> str:
    if not report:
        return (
            '<p class="empty">'
            "No matching reports found yet. The section updates automatically when new HTML reports are pushed to <code>reports/</code>."
            "</p>"
        )

    return (
        '<article class="latest-card">'
        f'<h3><a href="{html.escape(report.rel_path)}">{html.escape(report.title)}</a></h3>'
        f'<p class="meta">{html.escape(report.rel_path)} | {format_utc(report.updated_at)}</p>'
        f"<p>{html.escape(label)}</p>"
        "</article>"
    )


def render_report_list(reports: list[Report]) -> str:
    if not reports:
        return (
            '<p class="empty">'
            "No reports have been published yet. Once the private TradeHub pipeline pushes report files here, they will appear automatically."
            "</p>"
        )

    rows = []
    for report in reports:
        rows.append(
            "<li>"
            f'<a href="{html.escape(report.rel_path)}">{html.escape(report.title)}</a>'
            f'<span class="meta">{html.escape(report.rel_path)} | {format_utc(report.updated_at)}</span>'
            "</li>"
        )
    return "<ul class=\"report-list\">\n" + "\n".join(rows) + "\n</ul>"


def build_html(reports: list[Report]) -> str:
    now = dt.datetime.now(tz=UTC)
    commit = run_git(["rev-parse", "--short", "HEAD"]) or "unknown"

    # Find most-recent monitoring and forward reports
    mon_report = next(
        (r for r in reports if "monitoring" in r.rel_path and r.rel_path.endswith("index.html")),
        reports[0] if reports else None,
    )
    fwd_report = next(
        (r for r in reports if "forward" in r.rel_path and r.rel_path.endswith("index.html")),
        None,
    )
    mon_href = html.escape(mon_report.rel_path) if mon_report else "#"
    mon_updated = format_utc(mon_report.updated_at) if mon_report else "—"
    fwd_href = html.escape(fwd_report.rel_path) if fwd_report else "forward/index.html"
    fwd_updated = format_utc(fwd_report.updated_at) if fwd_report else "—"

    # Read forward_data.json for real timestamp + mode badge
    fwd_json_path = ROOT / "forward" / "forward_data.json"
    fwd_mode = "demo"
    fwd_badge_class = "demo"
    fwd_badge_label = "Demo / Forward"
    if fwd_json_path.exists():
        try:
            fwd_meta = json.loads(fwd_json_path.read_text(encoding="utf-8"))
            gen_at = fwd_meta.get("generated_at", "")
            if gen_at:
                fwd_updated = format_utc(
                    dt.datetime.fromisoformat(gen_at.replace("Z", "+00:00")).astimezone(UTC)
                )
            fwd_mode = fwd_meta.get("mode", "demo")
            if fwd_mode == "live":
                fwd_badge_class = "live"
                fwd_badge_label = "Live Forward"
        except Exception:
            pass

    return f"""<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TradeHub — Strategy Performance</title>
  <style>
    :root {{
      --bg: #03060a;
      --bg2: #070d14;
      --panel: rgba(8, 20, 32, 0.92);
      --panel-raised: rgba(12, 26, 42, 0.95);
      --panel-border: rgba(65, 217, 168, 0.14);
      --ink: #e8f4ef;
      --ink-muted: #7aa898;
      --accent: #41d9a8;
      --accent-glow: rgba(65, 217, 168, 0.12);
      --accent-border: rgba(65, 217, 168, 0.35);
      --warn: #f5c26b;
      --danger: #ff7b61;
      --good: #6fd98f;
      --shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
    }}
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: "Segoe UI", "Inter", Arial, sans-serif;
      font-size: 15px;
      line-height: 1.6;
      color: var(--ink);
      background: var(--bg);
      background-image:
        radial-gradient(ellipse at 12% 0%, rgba(65,217,168,.07) 0%, transparent 42%),
        radial-gradient(ellipse at 88% 100%, rgba(255,123,97,.05) 0%, transparent 42%);
      min-height: 100vh;
    }}
    .page {{
      max-width: 1140px;
      margin: 0 auto;
      padding: 56px 24px 72px;
    }}
    /* brand header */
    .brand {{
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 60px;
    }}
    .brand-dot {{
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 12px var(--accent);
      animation: pulse 2.8s ease-in-out infinite;
    }}
    @keyframes pulse {{
      0%, 100% {{ box-shadow: 0 0 8px var(--accent); }}
      50%       {{ box-shadow: 0 0 22px var(--accent), 0 0 40px var(--accent-glow); }}
    }}
    .brand-name {{
      font-size: 1.05rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }}
    .brand-sub {{ color: var(--ink-muted); font-weight: 400; }}
    /* hero */
    .hero {{ margin-bottom: 56px; }}
    .eyebrow {{
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--accent);
      margin-bottom: 10px;
    }}
    .hero h1 {{
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(2.4rem, 5vw, 4.2rem);
      line-height: 1.02;
      letter-spacing: -0.025em;
      margin-bottom: 16px;
    }}
    .hero h1 em {{ font-style: italic; color: var(--accent); }}
    .hero p {{
      font-size: 1.05rem;
      color: var(--ink-muted);
      max-width: 62ch;
    }}
    /* nav cards */
    .cards {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 56px;
    }}
    .card {{
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: 24px;
      padding: 28px 30px;
      box-shadow: var(--shadow);
      text-decoration: none;
      color: inherit;
      display: flex;
      flex-direction: column;
      gap: 10px;
      transition: border-color .22s, background .22s, box-shadow .22s, transform .18s;
      position: relative;
      overflow: hidden;
    }}
    .card::before {{
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 24px;
      background: var(--accent-glow);
      opacity: 0;
      transition: opacity .22s;
    }}
    .card:hover {{ border-color: var(--accent-border); box-shadow: 0 28px 70px rgba(0,0,0,.65), 0 0 30px var(--accent-glow); transform: translateY(-2px); }}
    .card:hover::before {{ opacity: 1; }}
    .card-icon {{
      font-size: 2.4rem;
      line-height: 1;
      margin-bottom: 4px;
      position: relative;
    }}
    .card h2 {{
      font-family: Georgia, "Times New Roman", serif;
      font-size: 1.4rem;
      font-weight: 600;
      position: relative;
    }}
    .card p {{
      font-size: 0.92rem;
      color: var(--ink-muted);
      position: relative;
      flex: 1;
    }}
    .card-meta {{
      font-size: 0.75rem;
      color: var(--ink-muted);
      position: relative;
    }}
    .card-arrow {{
      font-size: 1.2rem;
      color: var(--accent);
      position: relative;
      margin-top: 4px;
    }}
    .card-badge {{
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      border: 1px solid var(--panel-border);
      color: var(--accent);
      background: var(--accent-glow);
      position: relative;
    }}
    .card-badge.live {{
      color: var(--good);
      background: rgba(111,217,143,.12);
      border-color: rgba(111,217,143,.25);
    }}
    .card-badge.demo {{
      color: var(--warn);
      background: rgba(245,194,107,.10);
      border-color: rgba(245,194,107,.22);
    }}
    /* features grid */
    .features {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 56px;
    }}
    .feature {{
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: 16px;
      padding: 18px 20px;
    }}
    .feature-icon {{ font-size: 1.4rem; margin-bottom: 8px; }}
    .feature h3 {{ font-size: 0.95rem; font-weight: 600; margin-bottom: 4px; }}
    .feature p {{ font-size: 0.84rem; color: var(--ink-muted); }}
    /* footer */
    .footer {{
      font-size: 0.78rem;
      color: rgba(120,160,140,.45);
      text-align: center;
      border-top: 1px solid var(--panel-border);
      padding-top: 24px;
    }}
    @media (max-width: 600px) {{
      .page {{ padding: 32px 16px 48px; }}
      .hero h1 {{ font-size: 2.4rem; }}
    }}
  </style>
</head>
<body>
  <main class="page">
    <!-- Brand -->
    <div class="brand">
      <span class="brand-dot"></span>
      <span class="brand-name">TradeHub <span class="brand-sub">/ public dashboard</span></span>
    </div>

    <!-- Hero -->
    <section class="hero">
      <p class="eyebrow">Systematic trading research</p>
      <h1>Strategy performance<br><em>made transparent</em></h1>
      <p>
        Public aggregate metrics from automated backtesting and forward testing pipelines.
        All sensitive parameters stay private — only hashes, aggregates, dates and symbol scope are exposed.
      </p>
    </section>

    <!-- Navigation cards -->
    <div class="cards">
      <a href="{mon_href}" class="card">
        <div class="card-icon">📈</div>
        <span class="card-badge">Daily Backtesting</span>
        <h2>Monitoring Dashboard</h2>
        <p>
          Long-term regression tracking — runtime stability, profitability drift, result fingerprints
          and consecutive-run change detection across all strategies.
        </p>
        <div class="card-meta">Last updated: {mon_updated}</div>
        <div class="card-arrow">→</div>
      </a>

      <a href="{fwd_href}" class="card">
        <div class="card-icon">⚡</div>
        <span class="card-badge {fwd_badge_class}">{fwd_badge_label}</span>
        <h2>Forward Testing</h2>
        <p>
          Live or demo-account forward deployments — trade-level data, equity curves, daily P&amp;L
          breakdown and per-strategy performance metrics.
        </p>
        <div class="card-meta">Last updated: {fwd_updated}</div>
        <div class="card-arrow">→</div>
      </a>
    </div>

    <!-- Feature highlights -->
    <div class="features">
      <div class="feature">
        <div class="feature-icon">🔒</div>
        <h3>Privacy-first</h3>
        <p>Only hashes, aggregates and dates are published. No signals, parameters or trade details exposed.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">🔄</div>
        <h3>Automated pipeline</h3>
        <p>Daily backtests commit results automatically via GitHub Actions on each push.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">📊</div>
        <h3>Consecutive tracking</h3>
        <p>Regressions detected by comparing each run vs the prior run — not a stale baseline.</p>
      </div>
      <div class="feature">
        <div class="feature-icon">🎯</div>
        <h3>Multi-strategy</h3>
        <p>Independent benchmark suites per strategy, with per-symbol breakdown and monthly windows.</p>
      </div>
    </div>

    <!-- Footer -->
    <footer class="footer">
      Generated {format_utc(now)} · commit {html.escape(commit)} · {len(reports)} report(s)
    </footer>
  </main>
</body>
</html>
"""


def main() -> int:
    reports = collect_reports()
    INDEX_FILE.write_text(build_html(reports), encoding="utf-8")
    print(f"Generated {INDEX_FILE.relative_to(ROOT).as_posix()} with {len(reports)} report(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
