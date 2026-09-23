# Grok Bot 0.18 Web parity ledger

Pinned reference: `b-nnett/grok-bot-0.18-reconstructed@a9f633e09d49a85829b8236331b9e21f7e612634`

This generated companion summarizes the machine-readable 2,111-record audit index. It is **not** a completion claim. Records remain `planned` or `implementing` until each source responsibility has source-content review, production wiring, tests, and evidence.

## Status

- planned: 2101
- implementing: 10

## Source areas

- frontend: 322
- repository-support: 65
- source/box-exec-daemon: 3
- source/electron-dev-controls: 1
- source/electron-main: 185
- source/electron-preload: 16
- source/host: 471
- source/internal: 2
- source/local-exec-daemon: 3
- source/node-agent-coordinator: 24
- source/packages: 852
- source/shared: 165
- source/support: 2

## Current implementation evidence

Green vertical-slice baseline: `86a51ba1d50f7a5a593c375ede06a989084cbeeb`, GitHub Actions run `35825476747`.

The first vertical slice establishes a production-shaped Browser/Web Main/Coordinator/Host/Runner boundary with durable request de-duplication, ordered event replay and reconnect/resync. The integration test disconnects during tool execution and verifies recovery of the same operation without duplicate start/tool/completion events.

At that exact SHA:

- strict pinned-reference manifest verification: passed;
- protocol + durable Web effect tests: 5/5 passed;
- Host TypeScript check: passed;
- full Next production build: passed.

This is a baseline, not final parity. The manifest still has 2,101 `planned` and 10 `implementing` records. Browser E2E, full MCP/plugin routing, Remote Computer, paired local Runner, PWA/browser matrix, security/static gates, and final zero-unresolved strict closure remain open.
