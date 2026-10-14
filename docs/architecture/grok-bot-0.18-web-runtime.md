# Grok Bot 0.18 Web runtime vertical slice

This document records the first production-shaped Web runtime boundary required by `grok-bot-0.18-web-architecture-parity.md`. It is intentionally not a declaration that the full 2,111-file parity program is complete.

## Runtime ownership

```text
Browser / PWA
  -> source/web-main (public authenticated HTTP + RFC6455 WebSocket)
  -> source/mahayana-agent-coordinator (durable request/run/event state + resync)
  -> source/host (turn lifecycle, inference, transcript mutation, tool dispatch)
  -> source/box-exec-daemon (allow-listed privileged runner tools)
```

The browser never calls Host or Runner directly. Web Main owns browser authentication/origin enforcement. The Coordinator owns durable run identity, request de-duplication, event ordering, owner isolation, reconnect cursors and recovery. Host owns turn semantics and inference. Runner owns privileged tool execution and idempotency.

## Durable run contract

A `chat.send` caller-supplied request ID is persisted before execution. Retrying that request ID returns the same operation ID. The Coordinator persists the event stream and high-water sequence so a WebSocket reconnect can request `afterSeq` and receive the missed events plus active-run state. Host and Runner both receive stable execution/idempotency keys, so Coordinator recovery does not intentionally create a second tool execution.

The representative integration test proves this sequence across real child processes:

`accepted -> preparing -> thinking -> tool-running -> streaming -> completed`

The test disconnects the WebSocket during tool execution, reconnects with the same authenticated session, resynchronizes missed events, and asserts one operation start, one tool execution state and one completion for the durable run.

## Production configuration

Web Main requires `FABUSHI_WEB_SESSION_SECRET`, `FABUSHI_ALLOWED_ORIGINS`, an internal service token, and a production authentication introspection endpoint. Host requires a real inference endpoint in production; the deterministic provider exists only under `NODE_ENV=test` with an explicit test flag. Runner tools are allow-listed rather than arbitrary shell execution.

The existing browser-WASM transport remains only as an unconfigured migration fallback until the full Web deployment is cut over. Once `NEXT_PUBLIC_MAHAYANA_GATEWAY_URL` is present the Host UI selects the authenticated WebSocket transport first. Removing the browser-WASM production fallback is a later R5/AC-15 closure item, after the remaining Host/MCP/auth/product surfaces are available through Web Main.
