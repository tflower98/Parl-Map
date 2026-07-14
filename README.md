# Parliamentary Defence Ecosystem Map — self-updating pipeline

An interactive stakeholder map of the UK parliamentary defence, trade and industry
ecosystem that refreshes itself nightly from Parliament's open APIs, flags drift
for human review, and never silently invents data.

## How it works

- `data/manual.json` — the human-verified dataset. This is the asset: every node
  carries its source and date. Edit this file to add or enrich stakeholders.
- `scripts/fetch-live.mjs` — nightly pull of the machine-readable layers:
  Defence Committee, Business & Trade Committee, MoD government and opposition
  posts, from committees-api.parliament.uk and members-api.parliament.uk.
- `scripts/build.mjs` — merges manual + live, regenerates `index.html`, and
  writes `reports/drift.md`. New committee members are auto-added with an
  "enrich manually" provenance flag; departed members lose the link but keep
  their node pending human review.
- `.github/workflows/nightly.yml` — runs the above at 02:30 UTC daily, commits
  only when something changed, and opens a GitHub issue when drift is detected.

## What stays manual, deliberately

APPG register entries, PPS appointments, the NATO PA delegation and debate
cohorts have **no API**. The pipeline reminds you (via the drift report, once
the manual layer is >30 days old) to check the APPG register, the GOV.UK PPS
list and recent Hansard — it does not guess. Update `data/manual.json` and bump
`lastVerified` when you do.

## Deploy (one-time, ~10 minutes)

1. Create a new **private** GitHub repository and push this folder to it.
2. In the repo: Settings → Pages → Source: "Deploy from a branch" →
   Branch: `main`, folder `/ (root)`. Your map will be served at the Pages URL.
   (Skip this step if you'd rather open `index.html` locally.)
3. Settings → Actions → General → Workflow permissions → "Read and write
   permissions" → Save.
4. Actions tab → "Nightly parliamentary data sync" → "Run workflow" to test.
5. Optionally create an issue label named `data-drift`.

From then on it runs nightly unattended. Watch the Issues tab: a new issue
means Parliament changed and the map already reflects the machine-readable
part of it — your job is the enrichment and the manual layers.

## First-run caveat

The Parliament API response schemas in `fetch-live.mjs` are written defensively
against the documented shapes but were authored without live API access. If the
first manual run logs extraction failures, the fetcher carries forward prior
data and the drift report says so — fix the field mapping in `extractMembers()`
once against the real payload and it's stable thereafter.

## Provenance rules (do not break these)

- Nothing enters `manual.json` without a named source and date.
- Auto-added nodes keep their "enrich manually" flag until a human verifies them.
- Ministers responding ex officio are not interest signals.
- Attribution-by-constituency inferences carry a verify flag.

Data: Open Parliament Licence v3.0. Committee/debate data partly via
TheyWorkForYou (mySociety), cited per their reuse terms.
