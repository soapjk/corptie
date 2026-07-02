# Copets

[中文说明](README.zh-CN.md)

**A floating desktop cockpit for asynchronous AI agents.**

Copets keeps Codex, Claude Code, and other CLI or SDK-based agents visible while you work elsewhere. Instead of hiding long-running agent sessions inside terminals or chat tabs, Copets turns them into native macOS floating panels, detachable orbs, live reply previews, approval controls, and quick-reply surfaces.

> The goal is simple: let agents work in parallel without making you babysit every window.

## ✨ Highlights

| Capability | Why it matters |
| --- | --- |
| 🧭 **Multi-agent supervision** | Keep several long-running agents visible at once without living inside terminals or chat tabs. |
| 🫧 **Detached session orbs** | Pull one session out of the main list and keep it as a tiny desktop companion with reply bubbles and quick replies. |
| 🪟 **Desktop-native presence** | Always-on-top floating UI makes agent work feel present across your workspace instead of trapped in one app window. |
| 🧠 **Structured choice extraction** | Turn messy terminal-style choice prompts into readable options, including via Local Agent or OpenAI-compatible parsers. |
| 🧪 **Real-work isolation** | Production and development apps can run side by side with separate ports, configs, databases, and remembered UI state. |

## 🖥️ Experience

Copets is designed for work that does not finish instantly:

- Start several agent tasks and keep them visible without switching contexts.
- Watch real states such as `running`, `needs input`, `approval required`, `complete`, and `failed`.
- Reply from the main chat view or directly from a detached floating orb.
- Read model replies in temporary bubbles before choosing the next option.
- Keep production work and local development safely isolated.

Copets intentionally avoids fake percentage progress. It shows the real state of the agent, the latest activity, and the places where human input is actually needed.

## 🧩 Architecture

```text
apps/macos
  Native SwiftUI + AppKit frontend
  Floating panel, detached orbs, settings, chat/detail views

apps/backend
  Local Node.js runtime
  HTTP API, SSE detail streams, PTY agent manager, SQLite store

scripts
  Dev runners, production backend helpers, macOS packaging
```

Codex CLI sessions use an explicit PTY adapter with resume support, interrupt support, model switching, approval handling, and streaming detail updates. Managed Codex sessions disable auto-update so an agent cannot invalidate an active session mid-run.

## 🚦 Environments

| Environment | Backend | Data |
| --- | ---: | --- |
| Production | `127.0.0.1:47321` | `~/Library/Application Support/Copets/` |
| Development | `127.0.0.1:47322` | `~/Library/Application Support/Copets Development/` |

The two environments do not share backend config, SQLite data, frontend `UserDefaults`, transparency settings, or remembered window sizes.

## 🛠️ Develop

```sh
scripts/start-backend-development.sh
scripts/run-macos-development.sh
```

Useful checks:

```sh
curl "http://127.0.0.1:47322/health"
swift build --package-path apps/macos
node --check apps/backend/src/server.mjs
```

Create a Codex-backed PTY session:

```sh
curl -X POST "http://127.0.0.1:47322/codex/pty-sessions" \
  -H "content-type: application/json" \
  --data '{"title":"Codex smoke test","prompt":"Summarize this repo without editing files.","cwd":"/path/to/copets"}'
```

If `prompt` is empty, Copets sends a tiny initialization prompt asking Codex to reply `Ready`, so new sessions bind and become usable immediately.

## 📦 Package

Build the production installer:

```sh
scripts/package-macos-installer.sh
```

Artifacts are written to `dist/` as timestamped `.pkg` and `.dmg` files. The `.dmg` includes `Copets.app`, an `Applications` shortcut, and a short installer readme.

## 📚 More

- [Project vision and technical research](docs/project-vision-and-tech-research.md)
