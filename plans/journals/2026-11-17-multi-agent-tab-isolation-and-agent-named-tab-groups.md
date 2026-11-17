---
title: Multi-agent tab isolation and agent-named tab groups
date: 2026-11-17
summary: Every local MCP session is now its own agent with its own tab and self-named group; tabs held by another live agent are refused.
---

# Multi-agent tab isolation and agent-named tab groups

## What happened
- Several Claude Code sessions sharing one helmsman MCP config took over each other's tabs, and every tab group was titled "claude-code".
- Root cause: `local/src/main.ts` sent agent id `local:<clientName>`, so every session of the same client was one agent to the extension. The extension's isolation was already correct for distinct ids (`tests/multi-agent.e2e.ts`).
- Live evidence: 8 helmsman-mcp processes on the machine, each with its own project/worktree cwd, two pairs sharing a cwd.

## Decision
- Per-process agent id `local:<client>/<cwd folder>#<random8>` (`shared/local-agent-id.ts`).
- The AI agent names its own group (`browser_tabs` `name` on any action, `rename`). Fallback title is the cwd folder; titles are unique among live agents with a `·N` suffix (user's choice).
- Ownership is a 10-minute lease: held while any call is in flight, renewed at call end, persisted at most every 15s. Tabs held by a live agent are refused for tab tools, select, close and window close (user's choice).
- On-page Stop stops only the agent owning that tab; popup controls stay global.

## Review catches
- Lease was never persisted when calls came less than 15s apart (the throttle compared against the previous call, not the last save). A service-worker restart would have freed an active agent's tabs.
- Stop could run before the store loaded on a cold service worker and fall through to a global stop.
- The handback prompt still used the raw label; a 10-minute user handback equalled the lease.

## Verification
- 3 real `claude -p` sessions in parallel in an isolated Chromium: each named its own group ("Tóm tắt IANA", "httpbin tác giả", "Đọc h1 example.com") with separate tabs and colours.
- Targeted e2e 26/26, full e2e green (real-sites suite opt-in), unit 90/90.
- Gotcha: the e2e default port 47821 is the user's live helmsman hub. Run tests with `HELMSMAN_PORT=47931 E2E_PORT=8797` or the test Chrome replaces the real extension connection.

## Next steps
- Deploy the Worker so `helmsman-mcp.tgz` (what users' npx runs) and the instructions update, and ship the new extension build.
- Cloud/ChatGPT is still one agent per OAuth client; per-conversation identity needs research.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
