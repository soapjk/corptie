# Corptie Scripts Tools Set

Use this protocol only when Corptie explicitly starts a project-toolset initialization or update turn. Do not initialize or modify `.corptie` during ordinary development work.

## Scope

Inspect the Git project outside `.corptie`, but write only inside the existing `.corptie` directory. Never modify tracked project files, `.gitignore`, project-owned scripts, remote resources, or Git history.

Adapt these executable files:

- `.corptie/scripts/start`
- `.corptie/scripts/restart`
- `.corptie/scripts/stop`
- `.corptie/scripts/status`
- `.corptie/scripts/health`
- `.corptie/scripts/version`

The scripts may call project-owned commands and scripts. Keep project-specific paths and local configuration inside `.corptie`.

## Command contract

Every script must:

1. be executable and run without interactive input;
2. use `CORPTIE_PROJECT_ROOT` when present, otherwise resolve the repository root relative to itself;
3. write exactly one JSON object to stdout;
4. write diagnostics only to stderr;
5. include `schemaVersion: 1`, `action`, and `ok` in its JSON result.

Lifecycle commands `start`, `restart`, and `stop` return exit code `0` only when the requested transition succeeds.

`status` reports `running` and, when known, `pid`. Return `0` when running and `3` when stopped.

`health` reports `healthy` and a short `detail`. Return `0` when healthy and `4` when unhealthy or unreachable.

`version` must inspect the running service rather than merely the checkout. Report:

- `revision`: full Git commit OID used by the running service;
- `worktreePath`: absolute source worktree when known;
- `dirty`: whether uncommitted source was used;
- `startedAt`: ISO-8601 timestamp when known.

Return `0` when the running revision is known and `5` when it cannot be proven.

## Completion

Test `status`, `health`, and `version` without starting or stopping an existing service. Fix invalid JSON or unsafe behavior. Set `configured` to `true` in `.corptie/toolset.json` only after all six scripts exist and are executable. Summarize what was detected and any remaining limitation; do not publish or upload anything.
