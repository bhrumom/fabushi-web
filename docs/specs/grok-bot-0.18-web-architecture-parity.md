# Grok Bot 0.18 Web Architecture Parity — Specification

Status: active  
Owner: Fabushi Web  
Last updated: 2026-09-23  
Related issue/task/PR: Grok Bot 0.18 → Fabushi Web architecture and behavior parity  
Target repository: `bhrumom/fabushi-web`  
Target baseline: `c481dea9e2624a4903fe68e22e22760a47ef7727`  
Reference repository: `b-nnett/grok-bot-0.18-reconstructed`  
Reference baseline: `a9f633e09d49a85829b8236331b9e21f7e612634`

## 1. Context / problem

Fabushi Web is currently an independent web boundary built primarily around the existing Next.js application and web-specific product surfaces. The goal of this project is not to add a Grok-looking chat page on top of the current site. The goal is to make the Fabushi Web application adopt the same architectural ideas, runtime responsibilities, interaction model, lifecycle behavior, and module completeness represented by the pinned Grok Bot 0.18 reconstructed source tree, while translating desktop-only boundaries into correct web-native equivalents.

The pinned Grok reference contains 2,111 repository files at the selected baseline. Of those, 322 are under `frontend/**` and 1,724 are under `source/**`. The major reconstructed runtime areas include:

| Grok source area | Files at pinned baseline |
| --- | ---: |
| `frontend/**` | 322 |
| `source/electron-main/**` | 185 |
| `source/electron-preload/**` | 16 |
| `source/electron-dev-controls/**` | 1 |
| `source/node-agent-coordinator/**` | 24 |
| `source/host/**` | 471 |
| `source/local-exec-daemon/**` | 3 |
| `source/box-exec-daemon/**` | 3 |
| `source/shared/**` | 165 |
| `source/packages/**` | 852 |
| `source/internal/**` | 2 |
| remaining `source/**` support files | 2 |

Fabushi Web must account for every reference file one by one, but **per-file accounting does not mean mechanical 1:1 file copying**. Every product-relevant responsibility represented by the reference must be implemented as a real Web equivalent. A reference file may map to one or more new target files, to an already-existing Fabushi Web implementation that demonstrably owns the same responsibility, or to an evidenced Web-specific `not-applicable` disposition when the source mechanism is intrinsically desktop-only. Directory-level statements such as "frontend migrated" or "host equivalent exists" are not sufficient evidence.

The canonical migration rule is therefore: **per-file audit and disposition + per-product-responsibility Web implementation**. The Fabushi Web target tree does not need to contain exactly 2,111 corresponding files, and creating no-op/shim files only to mirror the source tree is explicitly incorrect.

The resulting product should behave like a first-class web counterpart to the Grok Bot desktop application in the same sense that Telegram Web is a first-class counterpart to Telegram Desktop: the browser is the user-facing client, while durable agent/coordinator/host/runner state and execution can continue in server or paired-device runtimes.

The ultimate parity test is the **Grok Bot Web effect**: in a normal browser, except for capabilities that the browser security model genuinely cannot own directly, a user must receive the same core Agent experience, lifecycle, tool behavior, remote-computer behavior, and recovery semantics as Grok Bot 0.18. Platform differences must be explicit Web adaptations, not silent product shrinkage.

## 2. Goal

Build Fabushi Web as a Grok-shaped web application with the following properties:

1. The user-visible shell, conversations, transcripts, composer, agents, settings, plugins/MCP, tools, reactions, status surfaces, remote-computer surfaces, and real-time behaviors reach functional parity with the pinned Grok Bot 0.18 reference wherever those behaviors make sense on the web.
2. Grok's architecture is preserved as explicit runtime boundaries rather than collapsed into a monolithic Next.js process.
3. Every Grok source file is individually audited and accounted for in a machine-readable parity ledger, while every product-relevant responsibility represented by those files receives a real Fabushi Web implementation or a demonstrably equivalent existing implementation. Desktop-only implementation mechanisms may be `not-applicable` only with an evidenced Web rationale and, where the user-facing effect still matters, an explicit Web replacement behavior.
4. Desktop transport is translated rather than bypassed:
   - Electron IPC becomes typed HTTPS/RPC and WebSocket transport.
   - Electron preload becomes a thin browser-safe Web preload/platform bridge.
   - Electron main responsibilities become a Web Main/Gateway boundary.
   - Node Agent Coordinator responsibilities are implemented by a Mahayana Coordinator boundary.
   - Host and Runner remain separate responsibilities.
5. Language choice is driven by the responsibility of each module, not by a blanket "everything must be Rust" or "everything must be TypeScript" rule.
6. The final web application is production-capable, reconnectable, resumable, multi-device, secure, observable, testable, and installable as a PWA where supported.

## 3. Non-goals / out of scope

1. Do not embed Electron in the browser build.
2. Do not treat visual imitation alone as parity.
3. Do not collapse Coordinator, Host, Runner, and Web Gateway into a single process merely to reduce implementation work.
4. Do not use another Fabushi platform repository as a hidden runtime implementation for web-specific behavior.
5. Do not create a second parallel Fabushi Web application that leaves the existing canonical production entrypoint untouched indefinitely.
6. Do not ship original Grok Bot installer binaries, checksum-pinned shipped renderer assets, proprietary branding, or recovered binary-only assets as Fabushi Web product dependencies.
7. Do not weaken browser security boundaries to simulate desktop-only privileges.
8. Do not claim a desktop-only feature is "migrated" when the web implementation merely hides the UI.
9. Do not require local-computer privileges from a normal browser page. Local-computer control, when required, must use an explicitly paired local companion/runner with user-visible permission and revocation.
10. Do not create one target file for every source file merely to satisfy a numeric migration count.
11. Do not add no-op Web methods for intrinsically desktop-owned mechanics such as native window minimize/maximize. Translate the user-facing product effect to Web/PWA behavior, or record the mechanism as `not-applicable` with evidence.

## 4. Requirements

### R1 — Pinned reference and deterministic scope

The sole Grok reference for this migration is:

`b-nnett/grok-bot-0.18-reconstructed@a9f633e09d49a85829b8236331b9e21f7e612634`

Implementation must not silently follow later source changes. Any future baseline change requires a Spec amendment and a new manifest generation.

### R2 — Exhaustive per-file parity ledger

Before product implementation is considered underway, generate and commit a machine-readable architecture/parity manifest derived from the exact pinned Grok tree.

Required canonical artifact:

`docs/architecture/grok-bot-0.18-web-parity-manifest.json`

A human-readable generated companion is recommended:

`docs/architecture/grok-bot-0.18-web-parity-ledger.md`

Every one of the 2,111 reference files must have exactly one manifest record with at least:

- `source_path`
- `source_blob_sha`
- `source_area`
- `source_kind`
- `source_responsibility`
- `product_relevant`
- `web_effect`
- `platform_delta`
- `target_path` (nullable for a justified `not-applicable` source mechanism)
- `related_target_paths`
- `target_language`
- `runtime_owner`
- `transport_boundary`
- `status`
- `behavior_contract`
- `replacement_behavior`
- `tests`
- `evidence`
- `notes`

Allowed implementation lifecycle statuses may include `planned`, `implementing`, `implemented`, `equivalent`, and `not-applicable`. Final acceptance permits only:

- `implemented`
- `equivalent`
- `not-applicable`

`not-applicable` requires a Web-platform reason and evidence. It cannot be used as a shortcut for difficult work.

Status semantics are strict:

- `implemented`: a real Fabushi Web production path owns the mapped responsibility and has appropriate verification.
- `equivalent`: an already-existing Fabushi Web production path demonstrably owns the same responsibility and Web-visible effect, with evidence.
- `not-applicable`: the **source implementation mechanism**, not a still-required product capability, is intrinsically inapplicable to the Web platform. If the user-facing effect remains meaningful on Web, `replacement_behavior` is mandatory.

A source record does **not** require a unique one-to-one target file. Multiple Grok files may legitimately converge into one Web module, and one Grok file may legitimately fan out across multiple Web modules, when the ledger records the ownership and behavior mapping.

No reference code file may disappear from accounting because a parent directory was marked complete. Conversely, manifest completeness must never be confused with requiring an equal number of target files.

### R3 — Grok-shaped target architecture

The target architecture must preserve these independent boundaries:

```text
Browser / PWA
    |
    | HTTPS + WebSocket
    v
Web Main / Gateway
    |
    v
Mahayana Agent Coordinator
    |
    v
Host
    |
    +-------------------+
    |                   |
    v                   v
Remote Runner       Paired Local Runner
 / Sandbox            / Companion
```

The production browser must not call Host or Runner directly.

### R4 — Canonical source-area mapping

The default mapping is:

| Grok Bot 0.18 | Fabushi Web target | Primary responsibility |
| --- | --- | --- |
| `frontend/**` | `frontend/apps/web/**` and web-owned `frontend/packages/**` | Browser UI, interaction, state projection |
| `source/electron-main/**` | `source/web-main/**` | Web gateway, auth/session, settings, RPC, coordinator ownership, browser-safe lifecycle |
| `source/electron-preload/**` | `source/web-preload/**` | Thin typed browser bridge over HTTPS/WebSocket/browser capabilities |
| `source/electron-dev-controls/**` | `source/web-dev-controls/**` | Web development/test controls with production gating |
| `source/node-agent-coordinator/**` | `source/mahayana-agent-coordinator/**` | Renderer/browser port, request/reply/event, reconnect/resync, Host supervision, routing |
| `source/host/**` | `source/host/**` | Agent execution, inference routing, MCP/tools, transcript mutation, workflows |
| `source/box-exec-daemon/**` | `source/box-exec-daemon/**` | Remote sandbox/box execution daemon |
| `source/local-exec-daemon/**` | `source/local-exec-daemon/**` | Explicit paired-device/local companion execution daemon |
| `source/shared/**` | `source/shared/**` plus generated shared-contract adapters where required | Protocol, schemas, common runtime contracts |
| `source/packages/**` | `source/packages/**` or `frontend/packages/**` according to package runtime | Reusable runtime/UI packages |
| `source/internal/**` | `source/internal/**` | Internal runtime support |
| tests/scripts/config | equivalent Web build/test/release paths | Deterministic verification and delivery |

The table above is a responsibility/ownership mapping, not a filename-copying mandate. The manifest may choose a different target path, multiple target paths, an existing equivalent, or a justified `not-applicable` disposition for an individual source file when the record explains the Web ownership and product effect. Native desktop mechanics such as Electron window chrome are expected to be translated to browser/PWA semantics rather than recreated as non-functional Web APIs.

### R5 — No parallel legacy production runtime

The final product must have one canonical Fabushi Web application runtime.

Existing Web surfaces may be incrementally migrated, but final acceptance requires:

- no second "Grok Web" application living beside the real Fabushi Web application;
- no duplicate conversation engines;
- no duplicate agent stores;
- no old fallback runtime silently handling features that the new architecture is supposed to own;
- no legacy UI shell retained as a production fallback after its mapped Grok-equivalent responsibility is complete.

Official-site/content routes may remain separate product surfaces, but they must not duplicate the app runtime.

### R6 — Frontend parity

The Web frontend must implement Grok renderer **responsibilities and product effects** domain by domain and preserve equivalent behavior for, at minimum:

- root shell and error boundaries;
- account and sign-in surfaces;
- conversation list and active conversation;
- transcript rendering;
- streaming response rendering;
- thinking/running/completed/failed/recovered states;
- composer and rich input;
- attachments/media;
- agent creation, editing, deletion, identity, avatars;
- sidebar and navigation;
- command palette/search actions;
- reactions and reaction acknowledgement;
- settings;
- plugins/MCP marketplace and installed-plugin state;
- tool execution status;
- remote computer/VNC surface;
- group/member collaboration surfaces where present in the reference;
- feedback/about/help surfaces where applicable;
- deep-link routing;
- notifications;
- update/version state translated to Web/PWA semantics;
- responsive behavior for desktop/tablet/mobile Web.

The final frontend must not require Electron globals, Node built-ins, local filesystem APIs, or desktop-only window controls.

A representative Grok Bot Web turn must behave as a real agent run rather than a simplified chat request:

```text
Browser composer
  -> Turn accepted
  -> preparing/thinking visible
  -> Host inference
  -> tool request
  -> Runner/MCP execution
  -> ToolStarted / live progress
  -> ToolCompleted
  -> continued inference
  -> TranscriptDelta / streaming answer
  -> completed
```

If the browser refreshes or temporarily disconnects during that run, re-authentication and Coordinator resync must restore the **same durable run** and current tool/stream state when the run is still active; the task must not silently disappear merely because the tab reloaded.

### R7 — Platform runtime abstraction

The frontend must depend on typed runtime contracts, not raw transport details.

At minimum, define browser equivalents of:

- the desktop/main RPC bridge;
- coordinator port;
- event subscription;
- attachment staging/commit/download;
- MCP/plugin operations;
- auth/account state;
- experiments/feature flags;
- remote computer status and controls;
- telemetry/health reporting;
- deep links;
- notifications;
- settings;
- PWA update state.

A compatibility adapter may expose Grok-shaped bridge contracts internally to minimize UI divergence, but new code must access them through a typed Fabushi Web platform-runtime layer.

### R8 — WebSocket coordinator transport parity

The existing Grok coordinator message families must remain conceptually intact:

- `lifecycle`
- `request`
- `reply`
- `event`

The Web transport must support:

- protocol version negotiation;
- hello/ready/shutdown lifecycle;
- typed request IDs;
- typed failure envelopes;
- streaming events;
- cancellation;
- reconnect;
- resync after reconnect;
- connection replacement;
- stale-session rejection;
- backpressure/queue limits;
- duplicate-frame handling;
- out-of-order protection where ordering matters;
- heartbeat/liveness;
- auth/session refresh;
- deterministic pending-call settlement on disconnect.

The browser-side coordinator client must be transport-compatible in behavior with the Grok reference even though the underlying port is WebSocket instead of Electron MessagePort.

### R9 — Web Main / Gateway

`source/web-main/**` owns the Web equivalent of Electron main responsibilities that logically belong outside the browser, including:

- authenticated HTTP/RPC endpoints;
- WebSocket upgrade and connection ownership;
- secure session management;
- CSRF/origin enforcement;
- per-user/per-workspace routing;
- settings and preference persistence;
- OAuth callback forwarding;
- WebAuthn/passkey server coordination;
- MCP/plugin lifecycle APIs;
- upload/download mediation;
- deep-link handoff;
- push-notification subscription state;
- coordinator process/service ownership;
- remote runner/box connection acquisition;
- paired-device/local-runner routing;
- health/version/capability discovery.

It must not absorb Host turn execution logic.

### R10 — Mahayana Coordinator

`source/mahayana-agent-coordinator/**` is the Web equivalent of Grok's Node Agent Coordinator and must remain an independent architectural boundary.

It owns:

- browser renderer session/port attachment;
- request/reply/event framing;
- transcript routing;
- agent/thread routing;
- streaming activity;
- reactions;
- cancel;
- reconnect/resync;
- Gateway routing;
- Host supervision;
- remote/local runner routing;
- MCP relay;
- OAuth/auth forwarding where the reference coordinator participates;
- Host crash settlement;
- stale generation rejection;
- transport-state events;
- recovery/reconciliation;
- multi-tab/client-session ownership rules.

Rust is preferred for this boundary because it is a long-lived concurrent runtime, but parity and interface correctness take precedence over language preference.

### R11 — Host boundary

`source/host/**` must migrate Grok Host responsibilities individually rather than replacing them with a generic API call.

Host responsibilities include, as applicable to reference modules:

- inference routing;
- provider adapters;
- turn execution;
- tool dispatch;
- MCP integration;
- local/remote execution requests;
- transcript mutation;
- conversation state;
- attachments and selected image inputs;
- workflow execution;
- plugin/tool metadata;
- usage tracking;
- auth/provider state consumed by Host;
- cancellation and failure settlement;
- event emission;
- storage abstractions;
- watched resources translated to Web/server equivalents;
- trace/observability hooks.

Rust is preferred for durable runtime/state-machine behavior. TypeScript/Node adapters are allowed when a provider SDK or ecosystem integration is materially better there, but such adapters must remain behind typed Host contracts and cannot collapse Host into Web Main.

### R12 — Runner parity

The Grok Box and local-exec responsibilities must be preserved as Runner boundaries.

#### Remote Runner

Remote Runner provides Web-safe remote execution:

- isolated container/microVM lifecycle;
- shell/process execution;
- filesystem operations;
- browser/computer automation;
- upload/download;
- liveness;
- resource limits;
- VNC/WebRTC/noVNC or equivalent visual stream;
- cancellation;
- cleanup;
- capability-scoped credentials.

#### Local Runner / Companion

A normal web page must not simulate unrestricted local machine control. If Fabushi Web needs local-computer parity, it must use an explicitly installed and paired companion:

```text
Fabushi Web
   |
Cloud/Web Coordinator
   |
authenticated device channel
   |
Fabushi Local Runner
   |
OS/browser/filesystem/accessibility capabilities
```

Pairing, permission, device identity, revocation, and user-visible connection state are mandatory.

### R13 — MCP / connector parity

Web must support the Grok MCP/plugin lifecycle at parity where available:

- catalog/list;
- effective plugins;
- install/update/remove;
- account attach/remove/rename;
- authenticate;
- auth-completed events;
- custom instructions;
- server tool discovery;
- tool enable/disable;
- tool invocation result/error projection;
- OAuth callback flow;
- reconnect/re-auth behavior;
- logo/metadata loading;
- per-user isolation.

Provider secrets and long-lived connector credentials must not be exposed to browser JavaScript.

### R14 — Authentication and identity

The Web architecture must support durable authenticated sessions and multi-device continuity.

Requirements include:

- secure HTTP-only session cookies or an equivalently safe browser session mechanism;
- OAuth state/PKCE as applicable;
- WebAuthn/passkey support where the product requires it;
- session rotation;
- logout/revocation;
- multi-tab behavior;
- multi-device sync;
- reauthentication on sensitive actions;
- no provider secrets in localStorage/sessionStorage/indexedDB unless explicitly designed as a non-secret public artifact.

### R15 — Attachments and media

Translate desktop attachment operations into Web-native behavior:

- browser file picker/drag-drop/paste;
- staged upload;
- server-side validation;
- size/type limits;
- commit/discard semantics;
- download with safe content disposition;
- image/media preview;
- transcript references;
- interrupted upload recovery where practical;
- cancellation and cleanup.

No frontend module may depend on arbitrary host filesystem paths.

### R16 — Remote-computer parity

The Web application must provide the same product role as Grok's remote-computer surface:

- provision/connect state;
- connecting/ready/down/recovering status;
- visual remote display;
- keyboard/pointer/clipboard controls where permitted;
- reconnect;
- liveness;
- resize/viewport handling;
- user-presence state where applicable;
- explicit security boundary between browser and runner;
- failure/recovery reporting.

Web implementation may use WebRTC, secure WebSocket, noVNC, or another appropriate transport; exact desktop technology is not required if behavior is equivalent or better.

### R17 — PWA / Telegram-Web-like application behavior

Fabushi Web must support a first-class application experience:

- installable Web App Manifest;
- standalone display mode where supported;
- service worker with safe versioning;
- deep links;
- notification subscription where supported;
- resilient shell loading;
- no stale service-worker cache that can mix incompatible protocol versions;
- responsive desktop/mobile layouts;
- resume an existing account/workspace from another browser/device;
- remote agent work may continue when the browser tab closes if the user-started task is owned by server/runner runtime.

PWA support must not pretend that browser background execution can replace server-side durable work.

### R18 — Language selection

Language is selected per responsibility.

Default guidance:

| Layer | Preferred language / technology | Reason |
| --- | --- | --- |
| Browser renderer | TypeScript + React, integrated with the repository's Web framework | Browser ecosystem and UI parity |
| Browser preload/platform bridge | TypeScript | Browser APIs and typed frontend contracts |
| PWA/service worker | TypeScript | Browser-native lifecycle |
| Web Main/Gateway | Rust preferred for durable WebSocket/session runtime; TypeScript allowed for framework-native thin adapters | Long-lived concurrency plus Web integration |
| Mahayana Coordinator | Rust preferred | Durable concurrent state machine and supervision |
| Host | Rust preferred; TypeScript allowed for ecosystem-specific provider adapters | Reliability plus SDK practicality |
| Remote/local runners | Rust preferred | Process, filesystem, networking, native OS integration |
| Shared wire contracts | Language-neutral schemas with generated Rust/TypeScript types | Prevent contract drift |
| Browser E2E tests | TypeScript | Playwright/browser tooling |
| Runtime/unit/property tests | Native to implementation language | Best test ergonomics |
| Browser-heavy compute | Rust/WASM only when it materially improves the implementation | Avoid unnecessary WASM |

A module may use another language only when the parity ledger records the technical reason and the resulting boundary is at least as testable and maintainable.

### R19 — Shared contracts and repository ownership

Fabushi Web must remain the canonical owner of Web-specific implementations.

If a contract is genuinely cross-platform and repository governance requires it to live in `bhrumom/fabushi-platform-core`, this repository must still contain the Web adapter/consumer and the Grok parity manifest must point to that adapter. A Grok source file cannot be marked complete merely because a vaguely related external contract exists.

No Web feature may rely on an unversioned or undocumented implementation in another platform repository.

### R20 — Protocol/schema discipline

All browser ↔ Web Main ↔ Coordinator ↔ Host ↔ Runner boundaries must be typed and versioned.

Required classes of contracts include:

- request/reply;
- events;
- lifecycle;
- streaming;
- cancellation;
- reconnect/resync;
- auth/session;
- MCP;
- attachments;
- remote computer;
- runner actions;
- errors/failures;
- health/capabilities.

Wire schemas must be validate-on-read at trust boundaries. Generated types are preferred over separately handwritten Rust and TypeScript representations.

### R21 — Failure and recovery parity

The implementation must have tested behavior for:

- WebSocket disconnect during a turn;
- reconnect after temporary network loss;
- browser refresh during a turn;
- tab close/reopen;
- duplicate active tabs;
- server restart;
- coordinator restart;
- Host crash/restart;
- Runner crash/restart;
- stale generation;
- cancelled turn;
- delayed/out-of-order event;
- duplicate reply;
- auth expiry;
- OAuth failure;
- WebAuthn cancellation;
- MCP auth failure;
- attachment upload interruption;
- remote-computer liveness loss;
- local companion disconnect;
- protocol version mismatch;
- PWA stale cache/version mismatch;
- unavailable provider;
- tool timeout;
- partial transcript recovery.

Recovery must fail closed where accepting stale or ambiguous state could execute the wrong action.

### R22 — Security

At minimum:

- strict tenant/user/workspace isolation;
- origin validation for WebSocket;
- CSRF defense for state-changing HTTP requests;
- secure cookie flags;
- CSP;
- no provider secrets in browser bundles;
- no arbitrary server filesystem access from user-controlled paths;
- upload validation and quotas;
- explicit runner capability scopes;
- paired-device identity and revocation;
- audit logging for sensitive device/tool actions;
- rate limits and bounded queues;
- no unsafe debug/dev controls in production;
- secrets redacted from logs and client-visible errors.

### R23 — Performance

Parity must include perceived responsiveness, not only correctness.

Targets must be established and measured for:

- app shell first interactive state;
- conversation open;
- transcript hydration;
- send acknowledgement;
- first streamed response token/event;
- command palette/search;
- reconnect;
- remote-computer connection;
- large transcript virtualization;
- memory growth during long streaming sessions.

The migration may improve Grok reference performance; it must not knowingly regress core flows without a recorded reason.

### R24 — Accessibility and responsive Web behavior

The Web implementation must include:

- keyboard navigation;
- focus management;
- screen-reader semantics for core controls;
- reduced-motion support;
- browser zoom support;
- high-DPI rendering;
- desktop/tablet/mobile responsive layouts;
- touch input where applicable.

Desktop window-control UI from Grok must be removed or translated rather than shown as non-functional controls.

### R25 — Observability

Every distributed request should be traceable across boundaries using correlation fields such as:

- user/workspace;
- browser session;
- connection ID;
- agent ID;
- conversation/thread ID;
- turn ID;
- request ID;
- generation;
- coordinator instance;
- Host instance;
- Runner/device ID.

At minimum capture:

- transport state;
- send acknowledgement;
- time-to-first-response;
- stream lifecycle;
- reconnect/resync;
- Host/Runner crashes;
- MCP calls;
- remote-computer liveness;
- recovery actions;
- client failures.

Telemetry must respect privacy/security requirements.

### R26 — Provenance and rights-safe implementation

Use the pinned reconstructed repository as architecture/behavior/source reference.

Do not make the Fabushi Web production build depend on:

- the original Grok Bot DMG/EXE;
- extracted `app.asar`;
- checksum-pinned shipped renderer chunks;
- proprietary original branding/assets not licensed for Fabushi.

Where source provenance/licensing is unclear, reproduce architecture/behavior through an independent Fabushi implementation rather than copying binary-derived assets verbatim.

### R27 — No false completion

A module is not complete because:

- a target file exists;
- a one-to-one mirror file was created for a source file;
- a placeholder/no-op compatibility shim exists;
- a manifest status changed;
- a UI component renders;
- a mocked endpoint returns success;
- a unit test exists without production wiring.

For `implemented` / `equivalent` records, completion evidence must show:

1. production target path(s);
2. runtime ownership;
3. behavior contract and Web-visible effect;
4. real implementation;
5. test coverage appropriate to that responsibility;
6. evidence that the production path uses it.

For `not-applicable` records, completion evidence must instead show:

1. the exact source responsibility;
2. why that implementation mechanism is intrinsically desktop-only or otherwise inapplicable to Web;
3. the required Web replacement behavior when the user-facing effect still matters;
4. evidence that no required Grok product capability was silently dropped.

## 5. Current state

At target baseline `c481dea9e2624a4903fe68e22e22760a47ef7727`:

- the repository contains the canonical Fabushi Web boundary;
- the current product is primarily under `frontend/apps/web/**`;
- the repository already includes app, host, marketplace, miniapp, remote-computer, runtime, content, and official-site surfaces;
- the repository does not yet contain the full Grok-shaped `source/web-main`, Web preload, Mahayana Coordinator, Host, Runner, shared, and package structure required by this Spec;
- there is no committed 2,111-entry Grok parity manifest;
- therefore Grok Bot 0.18 Web architecture parity is not complete.

This Spec does not classify existing Fabushi files as obsolete automatically. The per-file audit/disposition and product-responsibility plan must determine whether they are retained as demonstrated equivalents, migrated, replaced, split/merged into new Web-owned modules, or removed.

## 6. Target state

The final repository should have one Web production system shaped approximately as below. This tree expresses runtime ownership boundaries; it does **not** require one target file per Grok source file:

```text
fabushi-web/
├── frontend/
│   ├── apps/
│   │   └── web/
│   │       ├── src/
│   │       ├── public/
│   │       └── ...
│   └── packages/
│
├── source/
│   ├── web-main/
│   ├── web-preload/
│   ├── web-dev-controls/
│   ├── mahayana-agent-coordinator/
│   ├── host/
│   ├── box-exec-daemon/
│   ├── local-exec-daemon/
│   ├── shared/
│   ├── packages/
│   └── internal/
│
├── docs/
│   ├── architecture/
│   │   ├── grok-bot-0.18-web-parity-manifest.json
│   │   └── grok-bot-0.18-web-parity-ledger.md
│   └── specs/
│       └── grok-bot-0.18-web-architecture-parity.md
│
└── tests/
    ├── contract/
    ├── integration/
    ├── e2e/
    └── browser/
```

Exact paths may evolve only through a Spec update plus manifest migration.

## 7. Architecture and ownership boundaries

### Browser / renderer

Owns:

- rendering;
- local ephemeral UI state;
- accessibility;
- browser capability detection;
- user interaction;
- browser file selection;
- transport client;
- PWA integration.

Does not own:

- provider secrets;
- durable agent execution;
- unrestricted filesystem/process access;
- Host supervision;
- Runner lifecycle.

### Web Main / Gateway

Owns browser-facing server boundary and authenticated session routing.

Does not own turn semantics that belong to Host.

### Mahayana Coordinator

Owns orchestration, routing, supervision, transport session state, and reconnect/resync.

Does not render UI and does not become the Runner.

### Host

Owns agent/turn/tool/inference/MCP behavior.

Does not become a browser BFF or UI server.

### Runner

Owns privileged execution.

Does not make product-level conversation decisions.

## 8. Interfaces / contracts / schemas / data flow

### Primary turn flow

```text
Browser composer
  -> Web preload/platform runtime
  -> WebSocket request
  -> Web Main authenticated route
  -> Mahayana Coordinator
  -> Host
  -> provider/tools/MCP/Runner
  -> Host events
  -> Coordinator event stream
  -> WebSocket
  -> renderer transcript projection
```

### Browser bridge

The bridge should provide typed methods and event subscriptions equivalent to Grok's renderer-facing responsibilities, with Web-native implementations.

### Transport envelope

At minimum preserve:

```text
lifecycle: hello | ready | shutdown
request:   requestId + method + args
reply:     requestId + ok/failed outcome
event:     family + payload
```

Cancellation and streaming/resync contracts must be explicit, not inferred from connection close.

### Versioning

Client and server negotiate protocol version. Incompatible clients must receive a deterministic upgrade/reload response rather than undefined behavior.

## 9. Constraints and non-functional requirements

1. Production Web code must run without Electron.
2. Browser bundle must not include Node-only secrets/runtime dependencies.
3. Long-lived work must not depend on a browser tab remaining open.
4. WebSockets must be authenticated and origin-validated.
5. Every privileged Runner action must be attributable and capability-scoped.
6. The UI must remain responsive during streaming and large transcript rendering.
7. No hidden fallback to legacy runtime after a mapped responsibility is finalized.
8. All final parity claims must be made against the exact implementation HEAD.
9. Heavy/full acceptance evidence must come from reproducible CI runs on that exact HEAD.
10. The final application must support current evergreen Chromium, WebKit/Safari, and Firefox-class browser behavior for core flows, with documented exceptions where a browser lacks a required platform capability.

## 10. Failure modes and edge cases

The implementation plan and tests must explicitly cover all failure cases listed in R21 plus:

- multiple browser windows attempting ownership of the same interactive device session;
- user logout while a remote turn is still running;
- permission revocation while a local runner action is in progress;
- service worker update while a WebSocket session is alive;
- upload finalized after conversation cancellation;
- MCP/plugin removed while a tool call is queued;
- remote box recreated while transcript state still references the previous box;
- network partition where browser thinks it is connected but server session has expired;
- browser sleep/wake;
- mobile background/foreground transitions;
- push notification arriving for a deleted/archived conversation.

## 11. Implementation strategy

### Phase 0 — Freeze and generate parity manifest

1. Pin the Grok source commit.
2. Enumerate all 2,111 reference files with blob SHA.
3. Identify each source file's responsibility, product relevance, and Web-visible effect.
4. Classify the platform delta: direct Web implementation, existing equivalent, converged/split Web implementation, or genuinely desktop-only mechanism.
5. Assign target path(s) or replacement behavior, runtime, language, and initial status.
6. Add a strict checker that fails if the reference tree and manifest differ.

The manifest is an exhaustive **audit index**, not a mandate to generate 2,111 target files. No broad migration phase should proceed without this manifest.

### Phase 1 — Contracts and Web transport

Implement:

- shared schemas;
- browser runtime contract;
- WebSocket lifecycle;
- request/reply/event;
- cancellation;
- reconnect/resync;
- protocol versioning;
- deterministic error mapping.

### Phase 2 — Web Main and Mahayana Coordinator

Implement real production wiring and supervision before migrating high-level UI behavior.

### Phase 3 — Host and Runner boundaries

Implement the Web-equivalent Grok Host responsibilities by domain, with real provider/tool/MCP/runner integration, while individually closing the corresponding source-file ledger records.

### Phase 4 — Frontend module migration

Implement Grok renderer responsibilities and user-visible effects domain by domain in the canonical Fabushi Web app, while individually closing the corresponding source-file ledger records.

Suggested domain order:

1. shell/runtime boot;
2. account/auth;
3. agents/sidebar/navigation;
4. conversation/transcript;
5. composer/streaming;
6. attachments/media;
7. reactions;
8. settings;
9. MCP/plugins;
10. command/search;
11. remote computer;
12. collaboration/groups;
13. feedback/deep links/notifications;
14. remaining recovered/reference frontend modules.

### Phase 5 — Packages/shared completion

Clear every remaining `source/packages/**`, `source/shared/**`, internal/support, scripts, and tests manifest item.

### Phase 6 — Remove legacy/fallback paths

Only after production evidence proves replacement:

- remove duplicate runtime paths;
- remove obsolete adapters;
- remove stale feature flags used only for fallback;
- remove Electron assumptions;
- keep official-site/content surfaces that are intentionally distinct.

### Phase 7 — Strict parity closure

Run strict manifest validation requiring:

- zero `planned`;
- zero `implementing`;
- zero unresolved/missing source entries;
- zero target paths without real implementation evidence;
- zero forbidden Electron production dependencies;
- zero undocumented legacy fallback roots.

## 12. Verification / test strategy

### Static / manifest

- exact source tree ↔ manifest equality;
- no duplicate source entries;
- every source entry has an explicit disposition and responsibility mapping;
- final statuses only;
- target path(s) exist and are production-wired for `implemented`/`equivalent` records;
- every `not-applicable` record has platform rationale and required replacement behavior/evidence;
- no rule requires source-file count to equal target-file count;
- no Electron imports in browser/server production paths;
- no secret-bearing values in browser bundles.

### Unit

Test state machines, schema validation, error mapping, retries, resync, cancellation, Host behavior, Runner capabilities, and browser adapters.

### Contract

Use the same fixtures against both sides of each boundary:

- browser ↔ Web Main;
- Web Main ↔ Coordinator;
- Coordinator ↔ Host;
- Host ↔ Runner;
- Host ↔ MCP.

### Integration

Test real process/service boundaries, not only mocks:

- coordinator lifecycle;
- Host crash/recovery;
- remote Runner lifecycle;
- local companion pairing;
- MCP OAuth/auth;
- attachment upload/download;
- session rotation.

### Browser E2E

Use Playwright or equivalent against production-shaped builds.

Required flows include:

1. sign in;
2. open/create agent;
3. open/create conversation;
4. send turn;
5. observe thinking/running/streaming/completed;
6. cancel turn;
7. refresh during turn and resync;
8. disconnect/reconnect network;
9. attachments;
10. reactions;
11. MCP catalog/install/auth/tool call/result/error;
12. settings changes;
13. deep links;
14. remote computer connect/control/reconnect;
15. paired local runner where supported;
16. logout;
17. multi-tab ownership;
18. PWA update/reload compatibility;
19. a turn that invokes a real tool/Runner and exposes preparing/thinking/tool-running/streaming/completed state transitions;
20. refresh or temporary disconnect during that tool-running turn, followed by resync to the same durable run rather than task loss or duplicate execution.

### Browser matrix

Core flows must be verified in:

- Chromium;
- WebKit/Safari;
- Firefox.

Mobile viewport and touch smoke coverage is required.

### Exact-HEAD acceptance

Final acceptance evidence must identify:

- repository;
- exact commit SHA;
- workflow/run ID;
- browser matrix;
- test suites;
- manifest strict-check result;
- build/deploy artifact identity where applicable.

## 13. Acceptance criteria / Definition of Done

### AC-1 — Reference pin

The implementation and manifest identify exactly Grok commit `a9f633e09d49a85829b8236331b9e21f7e612634`.

### AC-2 — Complete manifest

All 2,111 pinned reference files are represented exactly once.

### AC-3 — Source-accounting and product-responsibility closure

Every Grok source file is audited exactly once, and every product-relevant responsibility represented by the reference has a real Web implementation or evidenced existing equivalent. A one-to-one target-file count is neither required nor accepted as proof of parity. No `not-applicable` record may remove a user-facing/core Agent capability merely because the desktop implementation mechanism cannot run in a browser.

### AC-4 — Grok-shaped boundaries

Web Main, Web preload/browser bridge, Mahayana Coordinator, Host, and Runner are distinct production boundaries with tests.

### AC-5 — No Electron requirement

Fabushi Web production runs without Electron and without Electron IPC/preload runtime.

### AC-6 — Frontend functional parity

The required user-visible domains in R6 function through production paths.

### AC-7 — Transport parity

Request/reply/event/lifecycle/streaming/cancel/reconnect/resync are production-tested.

### AC-8 — Crash/recovery

Host, Coordinator, Runner, connection, and stale-generation failure cases have deterministic tested settlement.

### AC-9 — MCP parity

MCP/plugin discovery, install, auth, tool listing, invocation, result/error, and lifecycle are production-tested.

### AC-10 — Auth/security

Browser sessions, OAuth/WebAuthn where applicable, tenant isolation, WebSocket origin/auth enforcement, and secret handling pass security checks.

### AC-11 — Attachments/media

Web-native attachment flows work without host filesystem assumptions.

### AC-12 — Remote computer

Remote-computer lifecycle and interaction work in the browser with reconnection/liveness evidence.

### AC-13 — Local computer

If local-computer control is included, it works only through an explicit paired local runner with permission/revocation. If a Grok local feature truly has no Web-safe counterpart, its manifest disposition explains the constraint and the product provides the closest safe equivalent.

### AC-14 — PWA/Web application experience

The app is installable where supported and handles version/update/deep-link/session continuity safely.

### AC-15 — No parallel legacy runtime

No duplicate old conversation/agent/Host runtime remains in production as an undocumented fallback.

### AC-16 — Strict parity checker

A strict checker passes on exact HEAD with zero unresolved manifest states and zero forbidden production roots/imports.

### AC-17 — CI evidence

Exact-HEAD CI passes required unit, contract, integration, browser E2E, security/static, and manifest checks.

### AC-18 — Spec compliance

Every requirement and acceptance criterion in this document has a final `passed`, `blocked`, or `not-applicable` record with evidence/reason. Completion requires no blocked item unless the user explicitly accepts the blocker and updates scope.

### AC-19 — Grok Bot Web effect

Using Fabushi Web in a normal browser must deliver the same core Grok Bot 0.18 Agent product effect, except for capabilities that are genuinely owned by the desktop OS and cannot safely belong to a browser page. At minimum, exact-HEAD browser acceptance must prove a durable turn can progress through acceptance → preparing/thinking → tool/Runner or MCP execution → live tool state → continued inference → streaming transcript → completion, and that refresh/reconnect during the run resynchronizes the same run without silently losing or duplicating it. Any remaining platform difference must be documented as an explicit Web adaptation rather than an unacknowledged feature reduction.

## 14. Release / migration / rollback

### Migration

Migration is incremental by domain, but each domain must have an explicit cutover point from old production path to new production path.

### Rollback

Rollback must be possible at deploy/version granularity. Do not keep hidden dual-runtime behavior as a permanent rollback mechanism.

### Deployment

Web frontend, Web Main/Gateway, Coordinator, Host, and Runner versions must expose compatible protocol versions. Deploy ordering must account for rolling compatibility.

### Data migration

Any conversation/agent/settings storage migration requires:

- versioned schema;
- forward migration;
- rollback/compatibility plan;
- fixture tests.

## 15. Observability / evidence

Required evidence artifacts include:

- parity manifest;
- strict-check report;
- exact commit SHA;
- CI run links/IDs;
- contract test output;
- browser E2E reports;
- screenshots for major UI states;
- video for representative end-to-end agent/remote-computer flow when practical;
- trace/log correlation for one full turn across Browser → Web Main → Coordinator → Host → Runner/MCP → Browser;
- security/static scan result;
- list of any accepted not-applicable records with rationale.

Evidence must demonstrate production wiring, not only isolated component behavior.

## 16. References / provenance

Primary reference:

- `https://github.com/b-nnett/grok-bot-0.18-reconstructed`
- pinned commit: `a9f633e09d49a85829b8236331b9e21f7e612634`

Target:

- `https://github.com/bhrumom/fabushi-web`
- baseline when this Spec was authored: `c481dea9e2624a4903fe68e22e22760a47ef7727`

Repository governance:

- `AGENTS.md`
- `docs/specs/spec-first-ai-development.md`
- `docs/specs/SPEC_TEMPLATE.md`

The Grok reference is an unofficial reconstruction. Architecture and behavior may be used as the parity reference defined by this Spec; production assets and code must still satisfy applicable rights/licensing requirements.

## 17. Spec compliance record

Initial state: this Spec is the implementation gate. Product migration has not been accepted as complete.

| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| R1 | passed | Reference repository and exact commit pinned in this Spec. |
| R2 | pending | 2,111-entry audit manifest not yet committed; it must map responsibilities/effects without requiring 2,111 target files. |
| R3 | pending | Target runtime boundaries not yet proven. |
| R4 | pending | Per-file target mapping must be generated. |
| R5 | pending | Legacy/parallel runtime audit not yet complete. |
| R6 | pending | Frontend parity not yet proven. |
| R7 | pending | Platform runtime abstraction not yet proven. |
| R8 | pending | WebSocket coordinator parity not yet proven. |
| R9 | pending | Web Main/Gateway not yet proven. |
| R10 | pending | Mahayana Coordinator not yet proven. |
| R11 | pending | Host parity not yet proven. |
| R12 | pending | Runner parity not yet proven. |
| R13 | pending | MCP parity not yet proven. |
| R14 | pending | Auth/identity parity not yet proven. |
| R15 | pending | Attachment/media parity not yet proven. |
| R16 | pending | Remote-computer parity not yet proven. |
| R17 | pending | PWA/Telegram-Web-like behavior not yet proven. |
| R18 | pending | Per-module language decisions not yet present in manifest. |
| R19 | pending | Shared-contract ownership audit not yet complete. |
| R20 | pending | Wire schema/versioning implementation not yet proven. |
| R21 | pending | Failure/recovery matrix not yet proven. |
| R22 | pending | Security gates not yet proven. |
| R23 | pending | Performance measurements not yet established. |
| R24 | pending | Accessibility/browser responsiveness not yet proven. |
| R25 | pending | Observability evidence not yet proven. |
| R26 | pending | Production provenance/asset audit not yet complete. |
| R27 | pending | Completion evidence rules apply during implementation. |
| AC-1 | passed | Exact Grok baseline is fixed. |
| AC-2 | pending | Manifest missing. |
| AC-3 | pending | Per-source audit and per-product-responsibility Web parity closure not yet performed. |
| AC-4 | pending | Runtime boundaries not yet verified. |
| AC-5 | pending | Electron-free production proof not yet available. |
| AC-6 | pending | UI/behavior E2E evidence not yet available. |
| AC-7 | pending | Transport E2E evidence not yet available. |
| AC-8 | pending | Crash/recovery evidence not yet available. |
| AC-9 | pending | MCP E2E evidence not yet available. |
| AC-10 | pending | Auth/security evidence not yet available. |
| AC-11 | pending | Attachment evidence not yet available. |
| AC-12 | pending | Remote-computer evidence not yet available. |
| AC-13 | pending | Local-runner disposition/evidence not yet available. |
| AC-14 | pending | PWA evidence not yet available. |
| AC-15 | pending | Legacy fallback audit not yet complete. |
| AC-16 | pending | Strict checker not yet implemented. |
| AC-17 | pending | Exact-HEAD CI not yet run. |
| AC-18 | pending | Final compliance review occurs after implementation. |
| AC-19 | pending | End-to-end Grok Bot Web effect has not yet been proven in exact-HEAD browser acceptance. |

Allowed final compliance statuses are `passed`, `blocked`, and `not-applicable`. The `pending` values above are initial implementation-state markers and must be eliminated before final acceptance.
