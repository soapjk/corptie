<p align="center">
  <img src="apps/macos/Sources/CopetsMac/Resources/AppIcon.png" alt="Corptie app icon" width="144">
</p>

<h1 align="center">Corptie</h1>

<p align="center">
  <strong>A macOS workbench that organizes projects as Works, tracks Tasks, and keeps AI Sessions working together.</strong>
</p>

<p align="center">
  <a href="https://github.com/soapjk/corptie/releases">Downloads and releases</a>
  ·
  <a href="README.md">简体中文</a>
</p>

Corptie brings work context, tasks, Agent roles, execution Sessions, and local workspaces into one native desktop app. Discuss requirements in Work Chat, start an execution Session for a specific Task, and carry context forward through artifacts, memories, and automations while managing progress, input, and approvals across parallel tasks.

It supports software, general, office, data, and design work. Coding tasks can also use Git Worktree isolation and project code search to operate within explicit repository boundaries.

## Capabilities

| Capability | How it works |
| --- | --- |
| **Work and Task** | A Work gathers context, a Workspace, and participating Agents. Tasks record requirements, priority, acceptance and verification criteria, and execution Sessions. |
| **Work Chat and execution Sessions** | Discuss requirements within a Work and carry out concrete tasks in bound Worker Sessions, with shared controls for messages, input, approvals, interruption, and recovery. |
| **Agents and Skills** | Configure reusable roles, working instructions, and available Skills, then select Agents for the work. |
| **Session Channels** | First contact between two exact Sessions requires user authorization. An active Channel supports ongoing bidirectional messaging, history, and revocation. |
| **Artifacts and memories** | Keep searchable, versioned documents. Work-scoped Artifacts are shared with Sessions in that Work; Task-scoped Artifacts stay within their owning Task. Memories retain reusable context and preferences. |
| **Automation** | Trigger actions at a specified time, after a delay, on a fixed interval, on process exit, or when a condition is met. Inspect runs and pause, resume, or cancel automations. |
| **Workspaces and Worktrees** | Associate work with local projects and support parallel development through Task workspace preparation, Git Worktree management, and code search. |
| **Multiple Providers** | Integrations include Codex App Server, Claude Agent SDK, and OpenClacky through a shared Provider contract. Available operations depend on each Provider's declared capabilities. |
| **Native desktop interaction** | SwiftUI and AppKit interfaces provide Session management, floating panels, and detachable orbs. |

## How work is organized

| Concept | Meaning |
| --- | --- |
| **Work** | An ongoing unit of work containing context, Tasks, participating Agents, artifacts, and an optional Workspace. |
| **Task** | A concrete piece of work belonging to one Work, with requirements, acceptance criteria, verification criteria, and a lifecycle. |
| **Agent** | A reusable role and capability configuration. |
| **Session** | The executor, authorization context, and message endpoint. Work Chat supports discussion; Worker Sessions execute Tasks. |
| **Workspace / Worktree** | A local project resource and an isolated Git working directory. |
| **Artifact** | A durable document with a scope, versions, and discovery metadata. |
| **Channel** | Revocable, bidirectional communication authorization between two exact Sessions. |
| **Automation** | A configuration that triggers actions based on time or events. |

Sessions execute work and exchange messages. Agents, Works, Tasks, Workspaces, and Providers are resources. Channel messaging does not automatically create, delegate, or complete Tasks; Task lifecycle and acceptance are separate workflows.

## Get started

### Runtime requirements

- macOS 14 or later.
- Node.js 22.13 or later with built-in `node:sqlite` support.
- At least one available, authenticated Provider runtime: Codex, Claude Code, or OpenClacky.

Choose an installer from [GitHub Releases](https://github.com/soapjk/corptie/releases), install and open Corptie, then check the local backend and selected Provider's availability. Model access and authentication come from the corresponding Provider runtime.

### Your first Work

1. Prepare a Contributor Agent with a role and the Skills it needs.
2. Create a Work, describe its context, and select participating Agents. Associate a Workspace when working with a local project.
3. Discuss requirements in Work Chat, then create a Task with a concrete goal, acceptance criteria, and verification steps.
4. Start an execution Session for the Task. Corptie prepares and binds its working directory; coding tasks execute within the corresponding Workspace / Worktree boundary.
5. Follow the Session's actual state and reply, approve, or interrupt as needed. Save durable material as Artifacts and configure Automation for later triggers.
6. Review the implementation, deliverables, and verification evidence before confirming completion.

To coordinate with another Session, request a Channel and confirm its initial authorization, then continue communicating through that Channel.

## Local data and runtime boundaries

Corptie's backend, SQLite state, work queue, and artifact storage run locally by default. App-managed Providers use dedicated runtime configuration and state directories; isolation details depend on the Provider.

Local-first does not mean offline inference. Model requests, authentication, and enabled external tools may access the network according to the Provider, tools, and user configuration. Session communication authorization does not replace permissions for other actions.

The production backend defaults to `127.0.0.1:47321`; development defaults to `127.0.0.1:47322`. The development rebuild script isolates backend data, presentation data, and frontend preferences by Worktree. Its path and port configuration are described below.

## Develop from source

In addition to the runtime requirements, install a Swift 6 toolchain, Rust / Cargo, and Python 3 for the development launcher. Rust builds the backend native module.

Install dependencies and build the native module from the repository root:

```sh
npm ci --prefix apps/backend
npm --prefix apps/backend run build:native
```

For an initial foreground run:

```sh
scripts/run-development.sh
```

This entry point checks the development backend and builds the macOS debug app only if its binary is missing. It runs an existing binary directly. After implementation changes, rebuild and restart development with:

```sh
scripts/dev-rebuild-restart.sh
```

**The rebuild script currently requires an external volume path.** `CORPTIE_DEVELOPMENT_RUNTIME_ROOT` defaults to `/Volumes/T9/CorptieData/development-launcher`; overrides must also be under `/Volumes/`. Configure it for your actual volume, for example:

```sh
CORPTIE_DEVELOPMENT_RUNTIME_ROOT="/Volumes/YourVolume/CorptieData/development-launcher" \
  scripts/dev-rebuild-restart.sh
```

The script compiles the Swift app and Rust module, starts the backend owned by the development app, and checks health and processes. Logs and data are stored by Worktree under the configured root; the script prints log paths. To run different Worktrees concurrently, set `CORPTIE_DEVELOPMENT_BACKEND_PORT` to an available port for this rebuild entry point.

Useful verification commands:

```sh
npm test --prefix apps/backend
swift test --package-path apps/macos
curl --fail http://127.0.0.1:47322/health
```

Backend tests build the native module first. Adjust the health URL when using a custom port.

### Package

After installing dependencies and building the native module, run:

```sh
scripts/package-macos-installer.sh
```

Artifacts are written to `dist/`. The current script uses the `arm64-apple-macosx` build output path. It uses ad-hoc app signing unless `CORPTIE_APP_SIGNING_IDENTITY` is set; use that variable to select a Developer ID Application certificate when available.

## Code navigation

| Entry point | Contents |
| --- | --- |
| [macOS frontend](apps/macos/Sources/CopetsMac) | Native UI for Work / Task management, Sessions, artifacts, and automations. |
| [Backend application services](apps/backend/src/application) | Work and Task workflows, Session startup, Artifacts, memories, and Automation. |
| [Provider layer](apps/backend/src/agent-provider) | Shared contracts, Session bindings, and Provider adapters. |
| [Session Channel service](apps/backend/src/collaboration/sessionChannelService.mjs) | Communication authorization, message delivery, and Channel lifecycle. |
| [Project code services](apps/backend/src/project-code) | Code snapshots, indexing, search, and reads. |
| [Backend native module](apps/backend/native) | Rust native capabilities. |
| [Development and packaging scripts](scripts) | Local execution, development rebuilds, verification helpers, and installers. |

The frontend consumes shared models and declared capabilities; backend business logic organizes execution through the common Provider abstraction. Preserve the boundaries between frontend, backend, and Provider implementations when extending the product.

## License

[Apache-2.0](LICENSE)
