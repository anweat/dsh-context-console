# Changelog

## 0.1.1-alpha.5 - 2026-09-09

- Target DeepSeek Harness `0.1.5-alpha.1` and Session Log V3.
- Restore V0–V3 logs through the official session-format catalog, including
  packed rows, branch rewinds, embedded assistant streams, and turn closers.
- Move both Host RPC surfaces to exact routes on Connection's authenticated
  shared `/api` transport.
- Keep generated messages and simulator edits valid under the V3 assistant
  stream contract.

## 0.1.0 - 2026-08-22

- Publish Context Console as an independent DSH plugin.
- Add trajectory wall, context inventory, cache history, and simulated messages.
- Integrate the complete Message Forge workflow: durable drafts, detailed
  context cards, surface replacement, session-log import, and conservative
  repaired-session creation.
- Target DeepSeek Harness `0.1.1-rc.2` and Node.js `^22.19.0 || >=24.0.0`.
