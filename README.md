# tradehub-pages

Public GitHub Pages site for HTML reports published from the private TradeHub repository.

## How publishing works

1. The private repo pushes report files into `reports/` in this repo.
2. This repo runs `.github/workflows/deploy-pages.yml` on every push to `master`.
3. The workflow regenerates `index.html` via `scripts/generate_index.py`.
4. The workflow deploys the repository content to GitHub Pages.

## Contract for the private publisher

- Publish report files under `reports/**/*.html`.
- Do not delete these infra files:
  - `.github/workflows/deploy-pages.yml`
  - `scripts/generate_index.py`
  - `.nojekyll`
- Commit and push normally to `master`; no manual Pages step is required.

## Expected output

- Site URL: `https://leweex95.github.io/tradehub-pages/`
- Homepage shows:
  - latest report
  - latest comparison-style report
  - full report list in reverse chronological order
