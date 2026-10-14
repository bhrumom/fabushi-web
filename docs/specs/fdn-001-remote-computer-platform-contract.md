# FDN-001 Web Remote Computer Platform Contract — Specification

Status: active
Owner: Fabushi Web Remote Computer controller
Last updated: 2026-10-15
Related issue/task/PR: FDN-001 / G13 / PR #6

## 1. Context / problem

Fabushi Web is a control client for the existing Fabushi Remote Computer system. It must consume the same Fabushi account, paired-client, device, session, authorization, and capability model as Platform Core and the native clients. Platform Core current main requires a stable `requestId` when creating a Remote Computer control session and uses that identity to reconcile a previously accepted request after a lost response. The Web controller previously sent only `clientId` and `clientToken`, so it no longer matched the canonical session contract.

Source lock for this repair:
- Web main: `fbc91de95952a21bfe259c7cca4335c6960ec553`
- Platform Core main: `f781e6c85375ba0945aa4fd4c19ead89e396dfdb`
- Parent product specification: Desktop `docs/specs/fabushi-same-account-device-network.md` (FDN-001)

## 2. Goal

Keep the existing Web Remote Computer controller compatible with the canonical Platform Core create/reconcile contract while preserving account-switch fencing and the existing authoritative paired-client/session owners.

## 3. Non-goals / out of scope

- Do not create a second Fabushi account, device, permission, or Remote Computer store.
- Do not run a desktop-style Tailscale/tsnet daemon in the browser.
- Do not expand Web into a generally controlled local device.
- Do not persist server session tokens beyond the existing session lifecycle.
- Do not weaken Platform Core request validation or remove `requestId`.

## 4. Requirements

- WFDN-R01: Session creation MUST send a stable, bounded `requestId` accepted by the current Platform Core contract.
- WFDN-R02: The pending request identity MUST be scoped to the current Fabushi account, device, and paired client and MUST reuse the existing Web account/session and paired-client owners.
- WFDN-R03: If the HTTP response is lost or authentication refresh/retry occurs after the server accepted the request, a subsequent session-create attempt MUST reuse the same `requestId` so Platform Core can reconcile rather than create an unrelated operation.
- WFDN-R04: The pending request identity MUST be cleared only after a successful response is structurally validated against the requested device/client and the current account is still the same.
- WFDN-R05: Account switch or logout MUST fail closed. An asynchronous response from the old account MUST NOT be accepted into the new account state.
- WFDN-R06: If browser session storage required for pending request identity is unavailable or cannot round-trip the value, session creation MUST fail closed rather than silently generate unstable request identities.
- WFDN-R07: `clientToken`, mobile/session credentials, or other secrets MUST NOT be placed in logs, URLs, analytics, or a new renderer-visible authority store.
- WFDN-R08: Device capability projection remains server-derived and unsupported capabilities remain unavailable; this change MUST NOT infer capability from online state.
- WFDN-R09: Legacy unscoped paired-client credentials remain discarded; this repair MUST NOT revive cross-account credentials.

## 5. Current state

The existing `RemoteComputerApi` already owns:
- the authenticated Web session in session-scoped browser storage;
- account-scoped paired clients in the existing v2 persistent storage namespace;
- device/client/session response validation;
- account identity checks around pairing;
- server-derived Remote Computer capabilities.

At the source-locked Web main, `createControlSession` posts only `{ clientId, clientToken }`.

At source-locked Platform Core main, `remote_computer_session_create` rejects missing/invalid `requestId`, loads an existing session by account/device/client/requestId, validates request/client-token hashes, and returns the recoverable session when the request was already accepted.

## 6. Target state

For each account/device/client tuple, Web keeps at most one pending session-create request identity in session storage. The identity survives transport/response uncertainty within the browser session, is reused by the next create attempt, and is removed only after a validated successful response for the same account/device/client. This is an idempotency/reconciliation key, not a second session database.

## 7. Architecture and ownership boundaries

- Account authority: existing Fabushi Web authenticated session / server.
- Device/client/session authority: Platform Core Remote Computer.
- Web credential projection: existing `RemoteComputerApi` and account-scoped paired-client storage.
- New state allowed by this spec: one ephemeral pending request identity per account/device/client in browser `sessionStorage`.
- No Web-owned authorization-generation database, node registry, network worker, or second permissions model.

## 8. Interfaces / contracts / schemas / data flow

Session create request:

```json
{
  "clientId": "<existing paired client id>",
  "clientToken": "<existing paired client credential>",
  "requestId": "mobile-request-<bounded opaque id>"
}
```

Data flow:
1. Validate device/client/clientToken using existing rules.
2. Require a current authenticated Web account.
3. Load or create the account/device/client-scoped pending `requestId`.
4. POST to the canonical Platform Core session-create endpoint.
5. Validate deviceId, clientId, sessionId, mobileToken, state, timestamps, permissions, and ICE servers.
6. Recheck that the current account still equals the account that initiated the request.
7. Only then clear the matching pending request identity and return the control session.

## 9. Constraints and non-functional requirements

- GitHub Actions only for executable verification.
- Request identity must be opaque, bounded, and contain no credentials.
- Storage keys must include an account namespace as well as device/client identity.
- A failed request must not rotate the idempotency identity automatically.
- Normal Web behavior must not require a local daemon or developer toolchain.

## 10. Failure modes and edge cases

- Server accepts request, response is lost: retain `requestId`; next create call reconciles.
- Access token refresh causes retry: same request body and `requestId`.
- Browser session storage unavailable: fail closed.
- Stored request identity malformed: replace only with a newly persisted and round-tripped bounded identity before sending.
- Account changes during request: reject the response; do not publish the old session into the new account.
- Revoked/rotated paired client: preserve server rejection; do not hide it by silently rotating `requestId`.
- Invalid/mismatched response: do not clear the pending identity.
- Browser session ends: ephemeral pending identity may be lost; no persistent cross-session authority is created.

## 11. Implementation strategy

Extend `frontend/apps/web/src/lib/remote-computer/remote-api.ts` only at the existing Remote Computer owner:
- introduce an account/device/client-scoped session-storage key;
- load/create a stable request identity;
- send it in session create;
- clear only after validated response plus account fence.

No contract change is required in Platform Core for this repair.

## 12. Verification / test strategy

GitHub Actions evidence must include the exact Web source SHA. Verification should cover:
- Web production build/typecheck that includes `remote-api.ts`;
- a focused source/behavior contract for stable request identity, fail-closed storage, response validation, and account-switch fence;
- no credential/log leakage in the changed surface;
- current Platform Core contract evidence showing `requestId` is required and reconcile is keyed by the stable identity.

Absence of a configured runner/workflow is `blocked`, not pass.

## 13. Acceptance criteria / Definition of Done

- WFDN-AC01: Current Platform Core accepts the Web session-create request shape without removing server validation.
- WFDN-AC02: A lost response followed by another create attempt uses the same request identity and can recover the same server session.
- WFDN-AC03: A validated success clears only its own account/device/client pending identity.
- WFDN-AC04: Account switch during an in-flight request rejects the old response.
- WFDN-AC05: No second device/permission/session authority is introduced.
- WFDN-AC06: Exact-head GitHub Actions verification is green before merge.

## 14. Release / migration / rollback

This is a compatible Web consumer repair for an already-current Platform Core contract. Rollback is the Web commit rollback; no server migration or durable credential migration is introduced. The existing unscoped legacy paired-client cleanup remains in place.

## 15. Observability / evidence

Do not log request bodies, `clientToken`, `mobileToken`, access/refresh tokens, or the paired-client storage payload. Compliance evidence records repository SHA, PR, Actions run/job, executed command, result, and relevant Platform Core source SHA.

## 16. References / provenance

- Fabushi Desktop FDN-001: `docs/specs/fabushi-same-account-device-network.md`
- Web repository policy: `AGENTS.md`, `docs/specs/spec-first-ai-development.md`
- Platform Core current owner: `third_party/mahayana/mahayana-rs/mahayana-platform-worker/src/worker_api/remote_computer.rs`

## 17. Spec compliance record

| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| WFDN-R01–R09 | pending | Implementation and exact-head Actions required |
| WFDN-AC01–AC06 | pending | Exact-head Web + current Platform Core evidence required |
