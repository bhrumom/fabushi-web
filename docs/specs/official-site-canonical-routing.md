# Official site canonical and host routing — Specification

Status: active
Owner: Fabushi Web
Last updated: 2026-10-14
Related task: Search Console notification 1a12fcd60dd095f9

## 1. Context / problem
Google reported "Duplicate, Google chose different canonical than user". The email does not identify affected URLs. Live browser inspection on 2026-10-13 UTC confirmed that both https://ombhrum.com/ and https://web.ombhrum.com/ display the official home page and declare https://ombhrum.com/ canonical. This is not proof that either URL is in Google's report. The legacy deployment generator does not declare ASSETS binding or run_worker_first, so Cloudflare's default asset-first handling bypasses host-specific Worker routing for matching files.

## 2. Goal
Repair demonstrable canonical/routing defects while preserving the informational website and separate Web app. Establish independently inspectable HTTP evidence and keep Google index evidence separate from source/CI evidence.

## 3. Non-goals
Do not combine the two products, noindex all public pages, remove expected duplicates, change application stores, copy legacy product fixes, or claim Google canonical/index convergence without Search Console data.

## 4. Requirements
- R1: Official informational pages remain on https://ombhrum.com with page-specific canonical URLs.
- R2: Worker runs before static assets for hostname routing, using explicit ASSETS binding. Preserve original Worker name, API proxies, R2 downloads, and custom domains.
- R3: Web root serves /web/index.html internally without redirect loops. /web aliases redirect to the Web root, preserving query strings. Legacy official hosts permanently redirect to the official domain.
- R4: An explicit /index.html alias on the official host redirects to /; HTTP uses HTTPS without redirecting the application host to the official host.
- R5: /app has its own canonical; it must not inherit the home canonical merely because it lacks metadata. Preserve its existing indexing policy.
- R6: Collect HTTP redirect chains, headers, canonical/meta robots, robots.txt and sitemap from a disposable GitHub Actions runner. Sitemap entries must be examined without inventing Google-selected canonical data.
- R7: Obtain actual affected URLs and indexed Google-selected canonical from Search Console before assigning notification-specific root cause or requesting validation.
- R8: No local builds/tests. Product implementation lives in bhrumom/fabushi-web.

## 5. Current state
Canonical main: fbc91de95952a21bfe259c7cca4335c6960ec553.
The exported repository lacks frontend/package.json, workspace lock/manifests, a complete official-site build/deploy workflow and shared Rust build roots. Its sole current workflow verifies the separate MCP privacy Worker.
Public source metadata for home/apps/download/faq/privacy/contact and article/app detail pages is page-specific. /web intentionally has noindex and its own Web canonical; /search intentionally has noindex. These are expected exclusions.
Public HTTP from the task container is restricted (403); robots/sitemap were not observable there. Browser robot-text navigation was blocked by client policy.

## 6. Target state
A checked-in authoritative deploy configuration makes host routing executable. Internal Web asset resolution cannot expose a /web redirect. /app is self-canonical. HTTP audit data is retained independently of tests.

## 7. Architecture and ownership
Use existing official-site-worker.js, Next metadata and site-url.ts. Do not create a second app or alter legacy repository product implementation.

## 8. Contracts
Assets use html_handling = "none"; Worker requests an explicit index asset for known roots. Custom domains remain fabushi.ombhrum.com and web.ombhrum.com; apex remains a zone route. Retain OFFICIAL_SITE_R2 binding to bushi as in current deployment source.

## 9. Constraints
Do not weaken authentication/security to fetch reports. Do not expose tokens. No credentials in committed files or audit artifacts.

## 10. Failure modes
Missing Web asset returns its real error, not official home fallback. Do not identify incomplete export/build wiring as a successful deployment. Unknown Google canonical remains unknown.

## 11. Strategy
Add canonical Wrangler config, correct worker alias/internal asset handling, correct /app metadata, run focused routing checks and read-only production HTTP audit in Actions. Existing legacy deployment must stop generating stale asset config during the eventual deployment-owner migration; until a complete canonical build pipeline exists, source repair is not live repair.

## 12. Verification
Actions executes node routing checks, Python TOML config integrity checks and a bounded HTTP audit. The audit validates important public self-canonicals and records robots/sitemap and alias behavior. No builds run on persistent devices.

## 13. Acceptance
- AC-1: Source/Actions proves R1–R5 without merging official and application roots.
- AC-2: Audit stores URL/status/redirect/header/canonical/robots/sitemap evidence tied to source SHA.
- AC-3: Corrected Worker/config deployed through an authorized complete production pipeline and public live behavior verified.
- AC-4: Report URL export + Google-selected canonical reviewed page by page; expected duplicates retained.

## 14. Release / rollback
Integrate through PR. Deploy only the matching complete site export; never deploy an incomplete asset directory. Preserve previous deployment version for rollback. Source changes alone do not close AC-3.

## 15. Evidence
Live browser DOM observation: official and Web root both canonical official root; Web root title is the official home title. Search retrieval corroborates identical content. Cloudflare docs confirm asset-first default.
Email notification verified. Search Console browser is signed out. Blocker email rejected by automatic approval review; no notification delivered.

## 16. References
- https://developers.cloudflare.com/workers/static-assets/binding/
- https://developers.google.com/search/docs/crawling-indexing/canonicalization-troubleshooting
- canonical AGENTS.md; docs/specs/spec-first-ai-development.md
- legacy read-only deployment source .github/workflows/deploy-official-site-cloudflare.yml

## 17. Spec compliance record
| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| R1–R6 / AC-1–2 | pending | Implementation and exact-head Actions pending |
| R7 / AC-4 | blocked | Search Console session/report data unavailable |
| R8 | passed | Canonical repository only; no local build/test |
| AC-3 | blocked | Canonical export lacks complete build/deploy dependencies |
