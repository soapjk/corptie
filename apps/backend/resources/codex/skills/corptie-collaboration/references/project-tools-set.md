# Corptie Scripts Tools Set

Use this protocol only when Corptie explicitly starts a project-toolset initialization or update turn. Do not initialize or modify `.corptie` during ordinary development work.

## Scope

Inspect the Git project outside `.corptie`, but write only inside the existing `.corptie` directory. Never modify tracked project files, `.gitignore`, project-owned scripts, remote resources, or Git history.

Adapt these executable files:

- `.corptie/scripts/build`
- `.corptie/scripts/start`
- `.corptie/scripts/restart`
- `.corptie/scripts/stop`
- `.corptie/scripts/status`
- `.corptie/scripts/health`
- `.corptie/scripts/verify`
- `.corptie/scripts/version`

The scripts may call project-owned commands and scripts. Keep project-specific paths and local configuration inside `.corptie`.

## Command contract

Every script must:

1. be executable and run without interactive input;
2. use `CORPTIE_PROJECT_ROOT` when present, otherwise resolve the repository root relative to itself;
3. write exactly one JSON object to stdout;
4. write diagnostics only to stderr;
5. include `schemaVersion: 2`, `action`, and `ok` in its JSON result.

Corptie supplies these environment variables:

- `CORPTIE_PROJECT_ROOT`: source Worktree requested by the user;
- `CORPTIE_MAIN_PROJECT_ROOT`: repository main Worktree;
- `CORPTIE_TOOLSET_ROOT`: private toolset directory;
- `CORPTIE_SERVICE_PROFILE`: selected local build/runtime profile;
- `CORPTIE_SOURCE_REVISION`: requested Git commit OID;
- `CORPTIE_SOURCE_FINGERPRINT`: Git tree fingerprint including uncommitted source changes;
- `CORPTIE_SOURCE_DIRTY`: whether the requested source has uncommitted changes.

Do not infer a running version from the checkout HEAD. A source revision is current only when a build artifact and the running process are both bound to the supplied revision, fingerprint, and profile.

## Service profiles

Declare every supported local service variant in `toolset.json`:

```json
{
  "schemaVersion": 2,
  "profiles": [
    { "id": "default", "label": "Default", "description": "Project default service configuration" }
  ],
  "selectedProfile": "default"
}
```

Use separate profiles whenever build-time or runtime commands differ, such as local versus gateway, staging, LAN, or worker-only modes. Keep secrets out of the manifest. Scripts may check that required secret environment variables exist, but must never print their values.

`build` must build `CORPTIE_PROJECT_ROOT` for `CORPTIE_SERVICE_PROFILE` before the existing service is stopped. It must return `revision`, `sourceFingerprint`, `profile`, and a non-empty project-specific `artifactId`. Reuse a build only when all four identities match.

`start` and `restart` must launch the artifact created for the selected profile. `restart` must also start a stopped service. Do not rebuild inside these scripts; Corptie invokes `build` first.

If an existing launchd, systemd, Docker, or process-manager definition hard-codes the wrong command or source directory, do not silently reuse it. Runtime scripts may generate a private service definition under `.corptie/runtime` and activate that definition, or fail with a precise configuration error. Do not modify project-tracked launch files during initialization.

Lifecycle commands `start`, `restart`, and `stop` return exit code `0` only when the requested transition succeeds.

`status` reports `running` and, when known, `pid`. Return `0` when running and `3` when stopped.

`health` reports `healthy` and a short `detail`. Return `0` when healthy and `4` when unhealthy or unreachable.

`verify` is stricter than liveness. It must prove that the effective service behavior matches `CORPTIE_SERVICE_PROFILE`, for example by checking a version endpoint, authentication boundary, database mode, feature flag, process arguments, or other project-specific invariant. Report `verified`, `profile`, and a short `detail`. Return `0` only when the selected profile is proven active.

`version` must inspect the running service rather than merely the checkout. Report:

- `revision`: full Git commit OID used by the running service;
- `sourceFingerprint`: exact source tree fingerprint used for the artifact;
- `artifactId`: stable identity of the running build artifact;
- `profile`: effective runtime profile;
- `verified`: `true` only when the running process is proven to use that artifact and profile;
- `worktreePath`: absolute source worktree when known;
- `dirty`: whether uncommitted source was used;
- `builtAt`: ISO-8601 build timestamp when known;
- `startedAt`: ISO-8601 timestamp when known.

Return `0` when the running revision is known and `5` when it cannot be proven.

Store non-secret artifact provenance under `.corptie/runtime`. Prefer an application version endpoint, an artifact-local manifest read by the running process, or a process command/artifact path that can be cross-checked. A timestamp written immediately before restart is not proof that the process loaded that artifact.

## Completion

Test `status`, `health`, `verify`, and `version` without starting or stopping an existing service. Do not run a production build during initialization. Fix invalid JSON or unsafe behavior. Set `configured` to `true` in `.corptie/toolset.json` only after all eight scripts exist and are executable. Summarize what was detected and any remaining limitation; do not publish or upload anything.
