#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import html
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
    latest = reports[0] if reports else None
    latest_comparison = next((report for report in reports if report.is_comparison), None)
    commit = run_git(["rev-parse", "--short", "HEAD"]) or "unknown"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TradeHub Reports</title>
  <style>
    :root {{
      --bg: #f8fbff;
      --panel: #ffffff;
      --ink: #1d2a38;
      --ink-subtle: #5a6d82;
      --line: #d7e3ef;
      --accent: #0d6efd;
      --accent-soft: #e8f1ff;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 0% 0%, #e8f2ff 0, transparent 50%),
        radial-gradient(circle at 100% 100%, #eef7ee 0, transparent 45%),
        var(--bg);
      line-height: 1.5;
    }}
    .page {{
      max-width: 1040px;
      margin: 0 auto;
      padding: 28px 20px 48px;
    }}
    .header {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 20px;
      margin-bottom: 20px;
    }}
    h1 {{
      margin: 0 0 8px;
      font-size: 1.9rem;
      color: #0b4ea2;
    }}
    h2 {{
      margin: 0 0 12px;
      font-size: 1.3rem;
    }}
    h3 {{
      margin: 0 0 6px;
      font-size: 1.05rem;
    }}
    p {{ margin: 0.35rem 0; }}
    a {{
      color: #0a4f9d;
      text-decoration: none;
    }}
    a:hover {{ text-decoration: underline; }}
    .meta {{
      display: block;
      color: var(--ink-subtle);
      font-size: 0.92rem;
    }}
    section {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
      margin-bottom: 16px;
    }}
    .latest-card {{
      background: var(--accent-soft);
      border: 1px solid #c7ddff;
      border-radius: 10px;
      padding: 12px;
    }}
    .report-list {{
      list-style: none;
      margin: 0;
      padding: 0;
    }}
    .report-list li {{
      border-bottom: 1px solid var(--line);
      padding: 10px 0;
    }}
    .report-list li:last-child {{
      border-bottom: none;
      padding-bottom: 0;
    }}
    .empty {{
      color: var(--ink-subtle);
    }}
    footer {{
      margin-top: 24px;
      color: var(--ink-subtle);
      font-size: 0.9rem;
    }}
    code {{
      background: #eef3f8;
      border-radius: 5px;
      padding: 1px 5px;
      font-family: Consolas, "Courier New", monospace;
    }}
  </style>
</head>
<body>
  <main class="page">
    <header class="header">
      <h1>TradeHub Reports</h1>
      <p>Public report mirror for the private TradeHub project.</p>
      <p>Push report HTML files to <code>reports/</code> in this repository to publish them automatically.</p>
    </header>
    <section>
      <h2>Latest Report</h2>
      {render_latest(latest, "Most recently updated HTML report in this repository.")}
    </section>
    <section>
      <h2>Latest Comparison Report</h2>
      {render_latest(latest_comparison, "Most recently updated comparison-style report (file name contains comparison hints).")}
    </section>
    <section>
      <h2>All Reports</h2>
      {render_report_list(reports)}
    </section>
    <footer>
      <p>Generated at {format_utc(now)} from commit {html.escape(commit)}.</p>
      <p>Deployment notes: <a href="docs/deployment.md">docs/deployment.md</a></p>
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
