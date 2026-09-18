# Fabushi — web applications and official site

Status: repository bootstrap; source migration is pending.

This public repository is the independent home for **web applications and official site** in the Fabushi platform repository separation project.

- Project: `FAB-P0013` / `PRS`
- Source baseline: `bhrumom/fabushi@cbe65975f3c4c077fa64af4171ebe3d2900185ad`
- Planned source roots: `frontend/apps/web; frontend/packages; frontend/official-site-worker.js; public`
- Migration policy: do not copy secrets, cookies, signing material, `.env` files, test-account state, or build caches.
- The repository becomes an active delivery repository only after its boundary, CI, package/E2E checks, and Release evidence are accepted.

Until migration is accepted, the original repository remains the rollback source of truth.
