# Windows browser and original-session MCP plan

**Goal:** Run Sibyl locally on Windows and connect Codex/Claude original conversations through MCP, with bidirectional questions, answers and continued session context.
**Architecture:** Keep Node 26, SQLite and the existing browser UI. Add local routing inside the authenticated native inbox, with no self-pairing or LAN listener needed. Keep the existing remote protocol compatible.
**Execution:** User explicitly requested autonomous implementation without questions; proceed in the existing isolated source snapshot. Use parallel workers only on disjoint file sets, then an independent review.

## Constraints and decisions
- Keep existing user/model credentials and unrelated MCP settings; back up config before writes.
- Ordinary MCP is pull-based. Do not claim idle chats are automatically awakened, or dedicated CLI chats are the user's already open desktop chat.
- Local tools list this computer as connectionId `local`; session discovery/ask/result use the authenticated local inbox. Route questions using owner/session lease, validate target and answer ownership, preserve idempotency and recovery.
- Support Codex project `.codex/config.toml` and Claude `.mcp.json`, with absolute node/script/data paths.
- Browser launch uses the downloaded isolated Node 26 if system Node is too old, supports paths with spaces and Chinese, and logs no secrets.
- Real model validation must distinguish a protocol-only test from actual model MCP tool calls, and verify same session IDs/context across follow-ups.
- No publishing or pushing; keep native macOS behavior supported.

## Tasks
- [x] Windows runtime/discovery: runtime.mjs, runtime.test.mjs, bridge.mjs process launcher. Test executable resolution and cancellation, no implicit shell interpolation.
- [x] Native configuration and UI: native-config.mjs/test, desktop.html/js, DESIGN.md. Add Codex entry and retain existing layout; test config merge/idempotency.
- [x] Local MCP routing: native-inbox.mjs, native-mcp.mjs and real-process tests. Fail first on absent local peer/discovery/ask; implement and verify bidirectional replies, ownership and interrupted state.
- [x] Browser launcher and control integration: default data directory, Codex connect endpoint, launch/stop scripts, platform-neutral baseline tests.
- [x] Configure this workspace's Codex/Claude MCP with backups; run real clients, verify original-session context and return/continue flow; inspect browser and full suite.
- [x] Independent diff review, address material findings, save verification and launch instructions.

## Review focus
Foreign chat handles must not work; local and remote IDs must not collide; failed sends retain question IDs; config updates preserve comments/unrelated servers and are atomic; restarting/closing prevents orphan processes and stale claims.

## Execution ledger
- Upstream baseline b2c2608: source snapshot verified against all 33 GitHub blobs.
- Ruling: use existing source directory in place — user requested autonomous work and this directory has no user edits.
- Baseline Node 26: 35 pass, 6 fail, 1 cancelled, 2 skipped; platform-related failures will be corrected and rechecked.

- Runtime/discovery: safe native/npm resolution, Windows process-tree cancellation; targeted tests green.
- Local MCP: real independent processes verify bidirectional answer routing, result recovery, foreign handle/answer rejection and offline recipients.
- Browser: project save, both MCP config actions, responsive narrow viewport verified in browser; repeat start and graceful stop verified in test.
- Real models: docs/superpowers/real-mcp-validation.json passed, 12 actual MCP calls, same native session IDs, private original context and peer answers retained over four turns each. Dedicated validation conversations, not attachment to existing desktop chats.
- Full Node26 suite: 64 total, 62 pass, 0 fail/cancel, 2 skips (macOS-only build and unavailable private LAN interface).
- Reviewer P2 TOML dotted-table redefinition fixed with two RED/GREEN regressions; independent focused re-review 2/2 pass, no remaining blockers in reviewed scope.
- Existing premium static UI audit reports legacy contract findings; no claim of full accessibility/static-audit compliance. Scoped browser flow verified at runtime.
- Ruling: retain windows-mcp local branch and commit the implementation; no remote push or publication requested.
