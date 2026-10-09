# Official MCP privacy disclosure
Status: active
Owner: Fabushi official site
Updated: 2026-10-09

## Context and goal
User authorized making the official connector marketplace usable and public. The existing privacy page covers only testing/support; Google OAuth branding now points to it. Explain the implemented provider authorization and data flow accurately before submitting restricted-scope review.

## Scope and requirements
P1: Keep existing privacy/support information and layout. Add a named Google/GitHub connection section with selected-connector OAuth scopes, independent Fabushi login, tool requests/results, native encrypted credentials, short-lived broker token delivery and minimal account connection metadata.
P2: Explain task-directed data use and sharing with selected model/service providers when a user runs tools; do not claim data never leaves the device. State no sale, advertising use, or model training of Google user data and adherence to Google API Services User Data Policy including Limited Use.
P3: Explain native disconnect/uninstall, provider account access revocation and support deletion requests. Do not invent a fixed retention period or claim provider revocation always succeeds.
P4: Publish only from canonical fabushi-web source; preserve unrelated live assets/runtime/routes. Verification must run in Actions. Do not rebuild or redeploy the whole migrated site using incomplete runtime inputs.

## Current and target state / ownership / interfaces
Existing Next privacy page and official-site Worker are Web-owned. Add durable static HTML at /mcp-privacy/ with the same disclosure text and link it from the existing page. Deployment must update only that asset or a narrow route while retaining the existing Worker bindings and assets. No platform or desktop runtime changes; no database migration.

## Failure modes, implementation and verification
Inspect current Cloudflare deployment and available delivery capabilities. If safe preservation cannot be established, leave deploy blocked instead of replacing the site. Add prose first; Actions checks the rendered static disclosure and source syntax. Record exact commit and deployed response. Roll back only the new disclosure route/asset.

## Acceptance
AC-P1: Both source surfaces contain accurate disclosure and support/revocation instructions.
AC-P2: Public policy URL serves HTTP 200 and matching text from verified canonical commit.
AC-P3: OAuth branding points to that usable policy; Google review remains explicit until approved.

## Provenance and compliance
Desktop docs/specs/fabushi-official-mcp-marketplace.md, Core mcp_oauth.rs and native OAuth/vault implementation, user continuation authorization.
P1-P4 and AC-P1..3 pending; record final evidence before completion.
