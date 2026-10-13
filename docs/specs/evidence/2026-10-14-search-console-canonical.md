# Search Console canonical investigation — 2026-10-14

## Outcome
Source repair prepared in https://github.com/bhrumom/fabushi-web/pull/5.
Production is not repaired and Google indexing recovery is not verified.

## Proven live findings
At 2026-10-13T18:28:32Z, Actions collected 57 public URLs (17 initial probes plus 40 sitemap HTML entries).
- Official home, apps, download, FAQ, privacy and contact returned HTTP 200 and their expected individual canonical.
- https://ombhrum.com/app/ returned HTTP 200, index/follow, but canonical https://ombhrum.com/. The sitemap includes /app/. This is a confirmed inconsistent signal, independently of the Google report.
- https://web.ombhrum.com/ returned the official homepage with apex-home canonical and index/follow. It did not expose the existing Web application's intended metadata/noindex. Live browser and public search corroborated the content.
- Official robots.txt returned HTTP 200, allowing the public site and disallowing /api/. It names the apex sitemap.
- Official sitemap.xml returned HTTP 200 and uses apex URLs. The Web host currently serves the same robots and sitemap assets. Sharing a sitemap alone is not treated as an error.
- Alias probes did not satisfy the intended permanent normalization for index.html, HTTP, www, fabushi and Web /web/. Exact returned status/redirect chains and any transport errors are in the artifact; a failed probe alone is not proof of a DNS/redirect configuration fault.
- No other self-canonical mismatch was detected in the 40 sampled sitemap HTML pages. The sample is bounded and not exhaustive.

## Source diagnosis and change
The read-only legacy deploy generator lacks explicit ASSETS binding/run_worker_first. Cloudflare's documented asset-first default allows an existing index asset to bypass the hostname router. This explains the observed identical roots, but remote deployed settings were not directly retrieved.
Canonical source now defines ASSETS + run_worker_first=true, explicit html handling and independent internal /web/index.html fetch; index aliases/HTTP/legacy hosts normalize permanently. /app metadata is self-canonical. Proxy and R2 logic is retained.

## Exact source/Actions evidence
Candidate implementation: 1de3af6f631299f5f929d9ab72654b177bc3b954.
Push run https://github.com/bhrumom/fabushi-web/actions/runs/38447008709:
- routing job 115467914063: success.
- live public-http-audit job 115467913818: failure (8 observations; live site still unhealthy).
- artifact 11839035695: official-site-seo-1de3af6f631299f5f929d9ab72654b177bc3b954.
- ZIP digest sha256:03277f5cc4ca870efa7ae76f4c85fda27c2249953709eb45aa28a1102dd9eed3.

PR merge-ref run https://github.com/bhrumom/fabushi-web/actions/runs/38447020095 checks c24e147e4e8dfa6e780af3749ffff7a5e971903c, not the branch SHA:
- routing 115467951710: success; audit 115467951342: failure.
- artifact 11839715232, ZIP digest sha256:bad89de177db5c88c21ca0e03165db0a1201d56a75aceab8aa3f1a376c25f39d.
Downloaded ZIP digest matched. Parsed http-audit.json contains the observations above.

These are source checks and public HTTP observations, not production deployment or Google index proof.

## Remaining blockers / executable continuation
1. Search Console currently signed out. Notification email lacks affected URL list. Obtain its indexing-report export and URL Inspection user/Google canonical plus last crawl date. Assess each duplicate's intent before changing other pages or requesting validation.
2. Canonical repository export lacks frontend workspace manifest/lock and complete site build/deploy dependencies; only separate MCP-privacy CI is present. Restore the canonical build/deploy boundary through its own spec, preserve runtime dependencies via canonical Core artifacts, then build the complete official-site/Web assets in Actions.
3. Consume frontend/wrangler.official-site.toml in the canonical deployment. Do not let a legacy generated asset-first config overwrite it. Never deploy an empty/incomplete asset directory.
4. Re-run the public audit after deployment and verify original important canonicals, Web content/noindex, aliases, robots and sitemap; then inspect Google canonical after recrawl.
5. Blocker notification email was rejected twice by automatic approval review. No email delivered. No further send retry without approval. No relevant reply was present in the final Gmail check.

## Expected duplicates/exclusions
Canonicalized tracking/query variants and legacy-host aliases may be expected. /web deliberately has noindex; /search deliberately has noindex. Informational pages on Web with apex canonical may be retained duplicates unless the report/user intent establishes otherwise. The application root serving marketing content is a product routing defect. Do not eliminate all duplicates or redirect the entire Web host to the official site.
