<p align="center">
  <img src="apps/macos/Sources/CopetsMac/Resources/AppIcon.png" alt="Corptie app icon" width="144">
</p>

<h1 align="center">Corptie</h1>

<p align="center">
  <strong>Burn tokens more efficiently.</strong>
</p>

<p align="center">
  <a href="https://github.com/soapjk/corptie/releases">Downloads and releases</a>
  ·
  <a href="README.md">简体中文</a>
</p>

Corptie brings projects, tasks, Agents, and Git tools together in a highly efficient development workflow. Create a project → Link a local repository → Create specific tasks and assign them to Agents → Merge changes back into the original repository with Git. A minimal workflow backed by a full set of productivity tools.

## Core capabilities

| Capability | Description |
| --- | --- |
| **Work and Task** | A minimal, two-level project structure with maximum flexibility. |
| **Collaboration tools** | Sessions created through the model can establish communication with one another and work together on tasks, without manually switching between windows to transfer context. A typical example: ask from a Session in Project A for Project B to adapt to the API changes you just made. |
| **Agents and Skills** | Configure roles, working instructions, and available Skills, then select participating Agents according to the work's needs. |
| **Artifacts** | Manage searchable, versioned reference files. |
| **Layered memory** | Manage global user preferences, project memories, and short-term Task memories in separate layers, giving the model useful information while minimizing context usage. |
| **Scheduled tasks** | Tools the model can proactively use to schedule tasks, allowing it to wake up when needed instead of waiting and polling long-running scripts. |
| **Workspace and Worktree** | Associate work with local projects and support parallel development through Task working directory preparation, Git Worktree management, and code search. |
| **IM support** | Quickly connect Feishu bots, with a `/sessions` command for Session management. |

## How work is organized

| Concept | Meaning |
| --- | --- |
| **Work** | An ongoing unit of work, roughly equivalent to a project. You must create a Work to get started. Each Work must be bound to a local folder, preferably a Git repository. |
| **Task** | A specific task within a Work, such as a feature request or a module under ongoing development. Each Task is inherently bound to an Agent Session. This is the main interaction point: users work with the Task's Session to get the task done. |
| **Agent** | A reusable role resource that users can create themselves, combining memories about skills, a persona, and a collection of Skills. Assign an Agent to a Task to move the work forward. |
| **Provider** | The source of model capabilities, such as Codex or Claude. A Provider supplies the core model capabilities; the Agent role described above is a context definition. Selecting a Provider enables an actual model to use the Agent resource to execute tasks. |
| **Artifact** | A resource file associated with a Work or Task, managed directly by the user through Corptie and stored outside the Workspace directory. Artifacts hold intermediate material that needs to be recorded but does not belong in the final project output, such as documents containing private data or design documents the user does not want to push to GitHub. Basic version management is included. |
| **Corptie toolset** | All Sessions created in Corptie receive core Corptie tools through context injection, including the collaboration and scheduled task tools described above. |

## Get started

### Runtime requirements

- macOS 14 or later.
- Node.js 22.13 or later with built-in `node:sqlite` support.
- At least one available, authenticated Provider runtime: Codex, Claude Code, or OpenClacky.

Choose an installer from [GitHub Releases](https://github.com/soapjk/corptie/releases), install and open Corptie, then check the local backend and selected Provider's availability. Model access and authentication come from the corresponding Provider runtime.

### Your first Work

1. Prepare a Contributor Agent with a role and the Skills it needs.
2. Create a Work, enter its name and context, and select participating Agents. Associate a Workspace when working with a local project.
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
