# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [1.0.0] - Unreleased

First public release.

### Highlights
- Two-line dense layout with version chip.
- Incremental transcript parsing with mtime/size/SHA1 head-fingerprint cache invalidation and a schema-versioned per-session state cache.
- Effort level tracking: typed `/effort` args, picker confirmations, and inheritance across `/clear` (exact same-process predecessor via pid → sessionId history, mtime heuristic fallback; chained `/clear` supported). Levels: auto/low/medium/high/xhigh/max/ultracode.
- Subagent tracking with spinner, per-agent context bar, model · effort badge, zombie cleanup, slow/stuck warnings, worktree marker.
- Rate limits with cross-session aggregation (MAX across parallel sessions) and burn-rate delta (`tokens%_used − time%_elapsed`).
- Prompt-cache hit rate with absolute expiry timestamp (`exp HH:MM:SS`).
- Compact counter resilient to Claude Code schema drift (JSONL flags OR PreCompact hook, whichever observes more).
- Rolling 30-day cost tracking with thresholds, race-safe across sessions.
- Account/plan badge with subscription type.
- Secret redaction in last-user-message display (postgres/mysql/mongo URLs, tokens, JWTs, Bearer/x-api-key headers).
- Todo progress display with active task label.
- Active session time via hooks (UserPromptSubmit→Stop deltas) instead of wall clock.
- Zero hook registration required to install — just the `statusLine` command.
