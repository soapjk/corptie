# Corptie

[中文说明](README.zh-CN.md)

**A low-distraction desktop companion for AI agents.**

<p align="center">
  <img src="apps/macos/Sources/CopetsMac/Resources/AppIcon.png" alt="Corptie app icon" width="180">
</p>

Corptie turns Codex, Claude Code, and other CLI- or SDK-based agents into assistive tools that fit naturally into your wider desktop workflow. Its compact native macOS floating panel and detachable orbs keep interaction focused on the conversation itself, minimize screen intrusion, and let you assign agent tasks without repeatedly interrupting everything else you are doing. Built-in agent-to-agent messaging and task collaboration allow independent agents to coordinate work directly.

> The goal is simple: let agents work in parallel without making you babysit every window.

## ✨ Highlights

| Capability | Why it matters |
| --- | --- |
| 🧭 **Multi-agent desktop cockpit** | Run and supervise several Codex, Claude Code, or other agent tasks at once, interrupting you only for input, approval, or exceptions. |
| 📱 **Feishu remote agent gateway** | Securely pair trusted Feishu users with local sessions to create or take over sessions, exchange messages, interrupt work, and handle approvals remotely. |
| 🤝 **Structured agent-to-agent collaboration** | Coordinate independent agents through stable identities, service ownership, acceptance criteria, and artifacts, with confirmation, durable delivery, verification, revision, and escalation built in. |
| 🔎 **Per-turn code review and undo** | Inspect the files changed by a Codex reply, open its patch in an external diff tool, and safely reverse only that turn when it does not conflict with newer edits. |
| 🧠 **LLM-enhanced interaction** | Convert terminal-style choice prompts into clickable structured actions with either a Local Agent or an OpenAI-compatible endpoint. |
| 🛡️ **Local-first, isolated runtime** | Keep agents, sessions, queues, and SQLite data on the Mac by default, while running production and development environments side by side with fully separate state. |

## 🎯 Core capabilities

Corptie is designed for work that does not finish instantly:

- Choose the agent, model, reasoning level, sandbox, and approval policy when creating a session.
- See real states such as `running`, `needs input`, `approval required`, `complete`, and `failed`, with unified controls for replies, approvals, interruption, resume, and safe shutdown.
- Detach a session into its own floating orb, read the latest reply, and respond without opening the main panel; choose a completion sound per session.
- Use the Codex App Server protocol by default with a PTY Legacy fallback, or run Claude Code through the Agent SDK.

Corptie intentionally avoids fake percentage progress. It shows the real state of the agent, the latest activity, and the places where human input is actually needed.

## 🖥️ UI Showcase

### Floating Orb Video Demo

<p align="center">
  <a href="https://youtu.be/OqqVC_ITiYc">
    <img src="https://img.youtube.com/vi/OqqVC_ITiYc/maxresdefault.jpg" alt="Corptie YouTube demo" width="100%">
  </a>
</p>

### Main Floating Panel

<img src="resources/imgs/screenshot-20260702-110500.png" alt="Corptie main floating panel showing multiple agent sessions and quick reply entry points" width="100%">

<details>
  <summary>Expand to see more UI screenshots</summary>

### Detached Floating Orb (running state)

<img src="resources/imgs/screenshot-20260702-110255.png" alt="Corptie detached floating orb showing the agent avatar, running state, and persistent desktop entry point" width="520">

### Quick Option Interaction

<img src="resources/imgs/screenshot-20260702-110149.png" alt="Corptie turns agent text options into clickable quick reply buttons" width="720">

</details>

## 🧩 Architecture

```text
apps/macos
  Native SwiftUI + AppKit frontend
  Floating panel, detached orbs, settings, chat/detail views

apps/backend
  Local Node.js runtime
  HTTP API, SSE detail streams, agent adapters, unified work queue, SQLite store

apps/backend/src/collaboration
  Agent/service registry, task state machine, durable delivery, and verification workflow

apps/backend/src/feishu
  Feishu bots, user pairing, session binding, interactive cards, and approval sync

scripts
  Dev runners, production backend helpers, macOS packaging
```

Codex sessions use structured App Server events by default and retain a PTY compatibility mode. Both support resume, interruption, model switching, and approvals. Agent input goes through one durable work queue so user, Feishu, and peer-agent messages are not lost while a session is busy.

## 📱 Feishu gateway

Feishu integration is optional. It requires `lark-cli` on the Mac and a published enterprise app with bot capability in the Feishu Open Platform.

1. In **Feishu Gateway** settings, add a bot with an App ID/App Secret or an existing `lark-cli` profile.
2. Add trusted workspaces that remote users may start sessions in, enable the bot, and generate a six-digit pairing code.
3. Send that code to the bot from the Feishu account you want to trust. Once paired, use interactive cards to choose a workspace and agent, then create or take over a session.

App Secrets are passed to `lark-cli` encrypted storage and are not stored in the Corptie database. Card actions validate the paired user and chat before anything is forwarded to an agent.

## 🤝 Agent collaboration

Corptie assigns a stable agent identity to each managed Codex session and exposes local MCP collaboration tools. Agents can discover peers and services, then coordinate through focused tasks with explicit acceptance criteria and local artifact references.

Every new collaboration request is shown to the user as a confirmation card before delivery. The Collaboration window provides inbox, verification, escalated tasks, agent/service registry, and full task timelines, with controls to cancel tasks or retry failed deliveries.

## 🚦 Environments

| Environment | Backend | Data |
| --- | ---: | --- |
| Production | `127.0.0.1:47321` | `~/Library/Application Support/Corptie/` |
| Development | `127.0.0.1:47322` | `~/Library/Application Support/Corptie Development/` |

The two environments do not share backend config, SQLite data, frontend `UserDefaults`, transparency settings, or remembered window sizes.

Corptie-managed Codex processes also use isolated runtime homes: production uses `~/.corptie/runtimes/codex/`, while development uses `~/.corptie/development/runtimes/codex/`. Neither modifies the native Codex home at `~/.codex/`. On first initialization, Corptie locally copies the existing authentication and the thread state it already manages; the homes diverge after that one-time bootstrap. Every backend startup verifies and repairs Corptie's built-in Skill, and every new or resumed Agent receives the collaboration MCP configuration dynamically.

## 🛠️ Develop

Requirements: macOS 14+, Node.js 20+, Swift 6, and an installed and authenticated Codex CLI or Claude Code. Install backend dependencies before the first run:

```sh
npm install --prefix apps/backend
```

```sh
scripts/run-development.sh
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
  --data '{"title":"Codex smoke test","prompt":"Summarize this repo without editing files.","cwd":"/path/to/corptie"}'
```

If `prompt` is empty, Corptie sends a tiny initialization prompt asking Codex to reply `Ready`, so new sessions bind and become usable immediately.

## 📦 Package

Build the production installer:

```sh
scripts/package-macos-installer.sh
```

Build from the current checkout, verify that production has no unfinished sessions, safely stop it, install the new app, and reopen it:

```sh
scripts/rebuild-install-restart-production.sh
```

Check shutdown safety without changing anything:

```sh
scripts/rebuild-install-restart-production.sh --check-only
```

Artifacts are written to `dist/` as timestamped `.pkg` and `.dmg` files. The `.dmg` includes `Corptie.app`, an `Applications` shortcut, and a short installer readme.

## License

[Apache-2.0](LICENSE)
