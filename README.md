# Copets

Copets 是一个面向多 Agent、异步并行工作的桌面客户端：用一个可拖动、始终置顶、可自定义皮肤的悬浮窗，持续展示 Codex、Claude Code 以及其他 Agent 的任务进度和需要用户介入的状态。

首版优先 macOS，采用 SwiftUI + AppKit 实现原生悬浮窗和高级视觉效果；后端使用 Node.js 作为本地 Agent runtime，并通过稳定的前后端协议保留未来迁移到 Go 或接入 Windows 原生客户端的空间。

当前项目目标和技术方案调研见：

- [docs/project-vision-and-tech-research.md](docs/project-vision-and-tech-research.md)

## Production and Development Environments

Copets supports two isolated local environments.

| Environment | `COPETS_ENV` | Backend port | Config directory | Default data directory |
| --- | --- | ---: | --- | --- |
| Production | `production` or unset | `47321` | `~/Library/Application Support/Copets/config.json` | `~/Library/Application Support/Copets/` |
| Development | `development` | `47322` | `~/Library/Application Support/Copets Development/config.json` | `~/Library/Application Support/Copets Development/` |

The two environments do not share the backend config, SQLite database, frontend `UserDefaults`, panel transparency, or remembered chat window sizes.

Install the production macOS app bundle:

```sh
scripts/install-macos-production.sh
```

Build a full production installer (pkg + dmg):

```sh
scripts/package-macos-installer.sh
```

Output artifacts are written to:

- `dist/Copets-Production-<version>-<timestamp>.pkg`
- `dist/Copets-Production-<version>-<timestamp>.dmg`

The generated `.dmg` contains:

- `Copets.app`
- `Applications` shortcut (for drag-and-drop install)
- readme under `.install/Copets-Readme.md`

Install flow:

1. Open the `.dmg`, then drag `Copets.app` into `Applications`.
2. Open `Copets.app`.
3. On first launch, follow the app prompt to initialize backend configuration (or use system settings when prompted).

Start the production backend manually:

```sh
scripts/start-backend-production.sh
```

Install the production backend as a login LaunchAgent:

```sh
scripts/install-backend-production-launch-agent.sh
```

Run the development backend:

```sh
scripts/start-backend-development.sh
```

Run the development macOS frontend:

```sh
scripts/run-macos-development.sh
```

This lets the installed production Copets manage real work while the development Copets continues to edit and test this repository against an isolated database.

## Development

Start the local Agent runtime:

```sh
scripts/start-backend-development.sh
```

Inspect Codex threads discovered through `codex app-server`:

```sh
curl "http://127.0.0.1:47322/codex/threads?limit=3"
```

The main floating task list only shows Copets-managed sessions by default. To temporarily include Codex history in the aggregate `/sessions` endpoint for debugging:

```sh
curl "http://127.0.0.1:47322/sessions?includeCodexHistory=true"
```

Start a Copets-managed Codex task:

```sh
curl -X POST "http://127.0.0.1:47322/codex/threads" \
  -H "content-type: application/json" \
  --data '{"prompt":"Summarize this repo without editing files.","cwd":"/path/to/copets"}'
```

Existing Codex Desktop history can be displayed from local rollout files, but may be read-only until Copets connects to the same Desktop control channel. Tasks created from Copets use `thread/start` + `turn/start` and can receive follow-up messages through Copets.

Start a headless PTY-backed CLI Agent session:

```sh
curl -X POST "http://127.0.0.1:47322/pty/sessions" \
  -H "content-type: application/json" \
  --data '{"title":"Shell smoke test","command":"/bin/zsh","args":["-f"],"cwd":"/path/to/copets","initialInput":"pwd && ls"}'
```

The PTY adapter runs CLI agents invisibly behind the floating window. It is the preferred compatibility path for tools such as Claude Code, Codex CLI, OpenClacky, Aider, Goose, or any custom terminal agent when a stable SDK/API is not available.

Start a Codex CLI session through the dedicated PTY adapter:

```sh
curl -X POST "http://127.0.0.1:47322/codex/pty-sessions" \
  -H "content-type: application/json" \
  --data '{"title":"Codex smoke test","prompt":"Summarize this repo without editing files.","cwd":"/path/to/copets"}'
```

This is now the preferred Codex interaction path for Copets. It launches `codex --no-alt-screen -C <workspace> -s workspace-write -a on-request <prompt>` inside an invisible PTY, so Copets can send follow-up input and interrupt the running Codex task without relying on Codex Desktop private control channels.

Copets does not show fake percentage progress for Agent tasks. The floating list shows real task state, recent activity, and whether the task is active, blocked, detached, complete, or failed.

Codex CLI sessions are launched with explicit `workspace-write` sandbox and `on-request` approval settings. Copets also prepends a safety rule to Codex prompts so ordinary commands do not trigger Codex self-updates or reinstall actions unless the user explicitly asks for that.

Production Copets stores its own session metadata and transcript in:

```text
~/Library/Application Support/Copets/copets.sqlite
```

Development Copets uses:

```text
~/Library/Application Support/Copets Development/copets.sqlite
```

After a backend restart, clicking a stored Codex CLI task automatically starts a new invisible PTY with `codex resume --last --no-alt-screen -C <workspace> ...` and reattaches the floating window to that resumed session.

Run the macOS floating window:

```sh
scripts/run-macos-development.sh
```
