# ccvitals

> Operational HUD statusline for [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) — live session vitals: effort, subagents, rate-limit burn rate, context, cost. Incremental transcript parsing, plugin system.

<!-- TODO: add demo GIF here -->

## What you get

A two-line statusline that surfaces the signals a heavy Claude Code user actually needs:

**Line 1**: update alert · model · effort · plan badge · cost (session + 30d, `~` = custo nocional equivalente-API, não fatura) · session duration · cwd · branch (uncommitted, push/pull) · current task · version chip.

**Line 2**: context bar · rate limits with burn-rate delta · prompt-cache hit rate + absolute expiry · compact count · tools · turns · todo progress.

Plus optional extra lines: live subagents (spinner, model · effort, elapsed, slow/stuck warnings) and the last user message echoed back (with secret redaction).

## Differentiators

- **Incremental transcript parsing** — caches per-session state (mtime/size + SHA1 head fingerprint); only the delta is parsed each render.
- **Burn-rate delta on rate limits** — `tokens%_used − time%_elapsed`. Positive = burning faster than the window allows.
- **Absolute prompt-cache expiry** — shows `exp HH:MM:SS`, not a stale countdown.
- **Subagent tracking** — spinner, model badge, effort, elapsed, zombie cleanup, slow/stuck warnings, worktree marker.
- **Secret redaction** — postgres/mysql/mongo URLs, sk-/sk-ant-/ghp_/AKIA/SG./JWT tokens, Bearer/x-api-key headers, password assignments are scrubbed from the echoed last-user-message.
- **Compact-boundary multi-flag** — resilient to Claude Code schema drift across versions.
- **Effort capture from `/effort`** — works around CC 2.1.112+ removing `effortLevel` from the statusline stdin.

## Install

```bash
npm install -g ccvitals
```

Or clone and run from source:

```bash
git clone https://github.com/marcelo-maciel/ccvitals.git ~/.claude/ccvitals
```

Then point Claude Code at it via `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/ccvitals/index.js\""
  }
}
```

## Configuration

All optional. Add a `statusline` block to `~/.claude/settings.json`:

```json
{
  "statusline": {
    "accent": "blue",
    "thresholds": {
      "costSession": [15, 30],
      "costMonthly": [300, 800],
      "rateLimit": [50, 80],
      "push": [3, 10]
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `accent` | string | `blue` | One of: `orange`, `blue`, `teal`, `green`, `lavender`, `rose`, `gold`, `slate`, `cyan`. |
| `thresholds.costSession` | `[low, high]` | `[15, 30]` | USD. Coloring boundaries for current session cost. |
| `thresholds.costMonthly` | `[low, high]` | `[300, 800]` | USD. Coloring boundaries for rolling 30-day cost. |
| `thresholds.rateLimit` | `[low, high]` | `[50, 80]` | Percent used. Coloring for `5h`/`7d` rate-limit chips. |
| `thresholds.push` | `[low, high]` | `[3, 10]` | Commit count. Coloring for git push/pull indicators. |

### Environment variables

| Var | Effect |
|---|---|
| `STATUSLINE_DISABLE=1` | Skip rendering entirely. |
| `STATUSLINE_STDIN_TIMEOUT=ms` | Bail out if Claude Code doesn't pipe stdin within `ms` (default: 5000, range 500-30000). |
| `DEBUG_STATUSLINE=1` | Persist per-context errors to `cache/statusline-errors.log`. |
| `CLAUDE_CONFIG_DIR` | Override the `~/.claude` location (mirrors Claude Code's own var). |

## Requirements

- Node.js ≥ 20
- Claude Code (any recent version)
- A terminal that renders 256-color ANSI and emoji

## Performance

The whole render runs in a few milliseconds on a warm cache. Slow renders (>500ms) are logged so regressions are visible. The bridge file at `os.tmpdir()/claude-ctx-${sessionId}.json` exposes the current context-window percentage to other tools.

## Contributing

Issues and PRs welcome. Keep changes surgical, tests next to the code where possible, and don't refactor adjacent code that wasn't asked.

## License

MIT — see [LICENSE](LICENSE).
