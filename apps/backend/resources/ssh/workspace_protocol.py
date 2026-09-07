"""Stateless SSH request handler; Python/Git stay on the Workspace host.

Sent to python3 -I -c by the local Workspace service, not installed as an Agent.
Only the repository's operation receipts and explicit bindings are persisted.
The caller must authorize mutations before sending a request. A cwd is not an
OS security sandbox. Arbitrary process supervision is intentionally not offered
by this protocol until a host can prove containment and descendant termination.
"""
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time

VERSION = 1
LIMIT = 1024 * 1024
MUTATIONS = {"create", "bind", "unbind", "write", "stage", "commit", "merge", "remove"}


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise Failure(code, message)


def absolute(value):
    if not isinstance(value, str) or not value.startswith("/") or any(c in value for c in "\0\r\n"):
        fail("REMOTE_PATH_INVALID", "An absolute POSIX path is required.")
    return os.path.realpath(value)


def git(cwd, *args, allowed=(0,)):
    # Files bound output memory. Output is read only after verifying its size.
    # There is no shell interpolation and no automatic retry after a timeout.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        process = subprocess.Popen(["git", "--no-optional-locks", "-C", cwd, *args], stdout=out, stderr=err,
                                   stdin=subprocess.DEVNULL, start_new_session=True,
                                   env={**{k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
                                        "GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat", "LC_ALL": "C"})
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            # Killing the process group is best effort, not a process-tree proof.
            try:
                os.killpg(process.pid, 9)
            except ProcessLookupError:
                pass
            process.wait()
            fail("REMOTE_GIT_OUTCOME_UNKNOWN", "Git timed out; reconcile the operation before retrying.")
        if max(out.tell(), err.tell()) > LIMIT:
            fail("REMOTE_OUTPUT_LIMIT", "Git output exceeded the response limit.")
        if process.returncode not in allowed:
            # Hooks and SSH remote helpers can emit secrets to stderr.
            fail("REMOTE_GIT_FAILED", "Remote Git rejected the operation (exit %d)." % process.returncode)
        out.seek(0)
        return out.read().decode("utf-8", errors="strict")


def inventory(repo):
    result = []
    current = {}
    for field in git(repo, "worktree", "list", "--porcelain", "-z").split("\0"):
        if not field:
            if current:
                result.append(current)
                current = {}
            continue
        key, _, value = field.partition(" ")
        if key == "worktree":
            current["path"] = value
        elif key == "HEAD":
            current["headOid"] = value
        elif key == "branch":
            current["branchRef"] = value
        elif key in ("locked", "prunable", "bare"):
            current[key] = value or True
        elif key == "detached":
            current["detached"] = True
    if current:
        result.append(current)
    return result


def worktree(repo, path):
    path = absolute(path)
    trees = inventory(repo)
    tree = next((item for item in trees if absolute(item["path"]) == path), None)
    if not tree or tree.get("bare"):
        fail("REMOTE_WORKTREE_NOT_REGISTERED", "The requested Worktree is not registered in this repository.")
    if not os.path.isdir(path):
        fail("REMOTE_WORKTREE_UNAVAILABLE", "The registered Worktree is unavailable; its binding is retained.")
    return {**tree, "path": path, "isMain": absolute(trees[0]["path"]) == path}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def snapshot(path):
    return {"headOid": git(path, "rev-parse", "HEAD").strip(),
            "status": git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
            "diff": git(path, "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--")}


def require_clean(path):
    if git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all"):
        fail("REMOTE_WORKTREE_DIRTY", "The Worktree contains staged, modified, or untracked files.")


def require_no_processes(path):
    try:
        result = subprocess.run(["lsof", "-t", "+D", path], capture_output=True, timeout=10, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        fail("REMOTE_PROCESS_STATE_UNKNOWN", "Process inventory is unavailable; cleanup is blocked.")
    if result.stdout.strip():
        fail("REMOTE_WORKTREE_PROCESS_ACTIVE", "An open file or process working directory prevents cleanup.")
    if result.returncode != 1 or result.stderr.strip():
        fail("REMOTE_PROCESS_STATE_UNKNOWN", "Process inventory is incomplete; cleanup is blocked.")


def expected_head(path, expected):
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{40,64}", expected):
        fail("REMOTE_EXPECTED_HEAD_REQUIRED", "The observed full HEAD object id is required.")
    if git(path, "rev-parse", "HEAD").strip() != expected:
        fail("REMOTE_HEAD_CHANGED", "HEAD changed since the operation was reviewed.")


def scoped_file(tree, relative):
    if not isinstance(relative, str) or not relative or os.path.isabs(relative) or "\0" in relative:
        fail("REMOTE_FILE_PATH_INVALID", "A Worktree-relative file path is required.")
    lexical = os.path.normpath(os.path.join(tree, relative))
    target = os.path.realpath(lexical)
    if os.path.commonpath([target, tree]) != tree or ".git" in os.path.relpath(lexical, tree).split(os.sep):
        fail("REMOTE_FILE_OUTSIDE_WORKTREE", "The file is outside the bound Worktree or targets Git metadata.")
    return target


def load(path, default):
    try:
        with open(path, "r", encoding="utf-8") as file:
            return json.load(file)
    except FileNotFoundError:
        return default


def save(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix=".receipt-", dir=os.path.dirname(path))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(value, file, ensure_ascii=True, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        parent = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def state_directory(common):
    directory = os.path.join(common, "corptie-ssh-workspace-v1")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        fail("REMOTE_STATE_PERMISSIONS", "Remote Workspace receipt directory must be privately owned (0700).")
    return directory


def assert_binding(bindings, request, path):
    binding = bindings.get(request["sessionId"])
    if not binding or binding.get("path") != path or binding.get("taskId") != request.get("taskId"):
        fail("REMOTE_SESSION_BINDING_MISMATCH", "The Session is not explicitly bound to this Task and Worktree.")


def operate(request, repo, common, bindings):
    action = request["action"]
    data = request.get("input", {})
    if action == "inspect":
        return {"rootPath": repo, "commonGitDir": common, "worktrees": inventory(repo),
                "connectionState": "connected", "cwdIsSandbox": False,
                "capabilities": {"worktrees": True, "files": True, "processSupervision": False}}
    if action == "create":
        target = absolute(data.get("path"))
        if os.path.lexists(target):
            fail("REMOTE_TARGET_EXISTS", "The target path already exists; it will not be reused or overwritten.")
        branch = data.get("branch")
        if not isinstance(branch, str) or branch.startswith("-"):
            fail("REMOTE_BRANCH_INVALID", "A new branch name is required.")
        git(repo, "check-ref-format", "--branch", branch)
        base = data.get("baseOid")
        if not isinstance(base, str) or not re.fullmatch(r"[a-f0-9]{40,64}", base):
            fail("REMOTE_BASE_INVALID", "Creation requires a reviewed full base object id.")
        git(repo, "worktree", "add", "-b", branch, "--", target, base)
        return {"worktree": worktree(repo, target), "bound": False}

    tree = worktree(repo, request.get("worktreePath"))
    path = tree["path"]
    if action == "bind":
        if tree["isMain"]:
            fail("REMOTE_MAIN_BIND_FORBIDDEN", "A writable Task must bind an isolated Worktree.")
        previous = bindings.get(request["sessionId"])
        proposed = {"path": path, "taskId": request.get("taskId")}
        if previous and previous != proposed:
            fail("REMOTE_SESSION_ALREADY_BOUND", "Explicitly unbind the previous Worktree before binding another.")
        if any(key != request["sessionId"] and value["path"] == path for key, value in bindings.items()):
            fail("REMOTE_WORKTREE_BUSY", "Another Session is bound to this Worktree.")
        bindings[request["sessionId"]] = proposed
        return {"binding": proposed}
    if action == "remove":
        if tree["isMain"] or tree.get("locked"):
            fail("REMOTE_WORKTREE_PROTECTED", "The main or locked Worktree cannot be removed.")
        if any(value["path"] == path for value in bindings.values()):
            fail("REMOTE_WORKTREE_BUSY", "Explicit Session bindings prevent cleanup.")
        expected_head(path, data.get("expectedHeadOid"))
        require_clean(path)
        if git(path, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"):
            fail("REMOTE_IGNORED_FILES_PRESENT", "Ignored files must be preserved; cleanup is blocked.")
        require_no_processes(path)
        # No --force, no branch deletion, and no prune on connection failure.
        git(repo, "worktree", "remove", "--", path)
        return {"removed": True, "branchPreserved": True}
    assert_binding(bindings, request, path)
    if action == "unbind":
        del bindings[request["sessionId"]]
        return {"unbound": True}
    if action == "status":
        return {**tree, **snapshot(path)}
    if action == "read":
        target = scoped_file(path, data.get("path"))
        with open(target, "rb") as file:
            content = file.read(LIMIT + 1)
        if len(content) > LIMIT:
            fail("REMOTE_FILE_TOO_LARGE", "File exceeds the text-file limit.")
        return {"content": content.decode("utf-8"), "sha256": digest(content)}
    if action == "search":
        query = data.get("query")
        if not isinstance(query, str) or "\0" in query:
            fail("REMOTE_SEARCH_INVALID", "A text search expression is required.")
        return {"output": git(path, "grep", "--no-color", "-n", "-I", "-e", query, "--", ".", allowed=(0, 1)), "scope": "trackedFiles"}
    if action == "write":
        target = scoped_file(path, data.get("path"))
        if not isinstance(data.get("content"), str):
            fail("REMOTE_CONTENT_INVALID", "UTF-8 text content is required.")
        content = data["content"].encode("utf-8")
        if len(content) > LIMIT:
            fail("REMOTE_FILE_TOO_LARGE", "File exceeds the text-file limit.")
        existing = None
        mode = 0o644
        try:
            with open(target, "rb") as file:
                existing = file.read(LIMIT + 1)
                mode = stat.S_IMODE(os.fstat(file.fileno()).st_mode)
        except FileNotFoundError:
            pass
        if "expectedSha256" not in data or data["expectedSha256"] != (digest(existing) if existing is not None else None):
            fail("REMOTE_FILE_CHANGED", "File changed since it was read; edit was not applied.")
        descriptor, temporary = tempfile.mkstemp(prefix=".corptie-edit-", dir=os.path.dirname(target))
        try:
            with os.fdopen(descriptor, "wb") as file:
                os.fchmod(file.fileno(), mode)
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {"sha256": digest(content)}
    if action == "commit":
        expected_head(path, data.get("expectedHeadOid"))
        current = snapshot(path)
        fingerprint = digest(json.dumps(current, sort_keys=True, separators=(",", ":")).encode())
        if fingerprint != data.get("expectedSnapshotHash"):
            fail("REMOTE_CHANGES_CHANGED", "Changes differ from the reviewed snapshot.")
        message = data.get("message")
        if not isinstance(message, str) or not message.strip() or "\0" in message:
            fail("REMOTE_COMMIT_MESSAGE_INVALID", "A commit message is required.")
        # Only already-staged files are committed. No implicit git add -A.
        git(path, "commit", "-m", message, "--")
        return {"headOid": git(path, "rev-parse", "HEAD").strip()}
    if action == "stage":
        files = data.get("files")
        if not isinstance(files, list) or not files or len(files) > 100:
            fail("REMOTE_STAGE_INPUT_INVALID", "An explicit list of at most 100 reviewed files is required.")
        paths = []
        for item in files:
            target = scoped_file(path, item.get("path"))
            with open(target, "rb") as file:
                content = file.read(LIMIT + 1)
            if len(content) > LIMIT or digest(content) != item.get("sha256"):
                fail("REMOTE_FILE_CHANGED", "A file differs from the reviewed staging input.")
            paths.append(os.path.relpath(target, path))
        git(path, "add", "--", *paths)
        return {"staged": paths}
    if action == "merge":
        # Publish into the Work's primary repository through an explicit
        # authorized action; the worker Session stays in its isolated Worktree.
        expected_head(repo, data.get("expectedHeadOid"))
        require_clean(repo)
        source = data.get("sourceOid")
        if not isinstance(source, str) or not re.fullmatch(r"[a-f0-9]{40,64}", source):
            fail("REMOTE_MERGE_SOURCE_INVALID", "A reviewed full source object id is required.")
        expected_head(path, source)
        git(repo, "merge", "--ff-only", "--", source)
        return {"headOid": git(repo, "rev-parse", "HEAD").strip(), "strategy": "fastForwardOnly"}
    fail("REMOTE_CAPABILITY_UNSUPPORTED", "This remote operation is not supported.")


def main(request):
    if request.get("version") != VERSION:
        fail("REMOTE_PROTOCOL_MISMATCH", "Workspace protocol version mismatch.")
    # Native Workspace configuration can discover repository resources before
    # a Work/Task exists. Every operation on a bound tree still needs a Session.
    resource_inspection = request.get("action") == "inspect" and request.get("resourceInspection") is True
    if not resource_inspection and (not isinstance(request.get("sessionId"), str) or not request["sessionId"]):
        fail("REMOTE_SESSION_REQUIRED", "A Session authorization context is required.")
    repo = absolute(request.get("repositoryRoot"))
    actual = absolute(git(repo, "rev-parse", "--show-toplevel").rstrip("\n"))
    if actual != repo:
        fail("REMOTE_REPOSITORY_ROOT_INVALID", "The configured directory must be the repository root.")
    common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").rstrip("\n")
    action = request.get("action")
    directory = os.path.join(common, "corptie-ssh-workspace-v1")
    if action not in MUTATIONS:
        bindings = load(os.path.join(directory, "bindings.json"), {})
        result = operate(request, repo, common, bindings)
        if action == "status":
            fields = {key: result[key] for key in ("headOid", "status", "diff")}
            result["snapshotHash"] = digest(json.dumps(fields, sort_keys=True, separators=(",", ":")).encode())
        return result
    key = request.get("operationId")
    if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key):
        fail("REMOTE_OPERATION_ID_REQUIRED", "A stable operation id is required for mutations.")
    directory = state_directory(common)
    lock_descriptor = os.open(os.path.join(directory, "lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_descriptor, "r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("REMOTE_REPOSITORY_BUSY", "Another client is changing this repository.")
        receipt_path = os.path.join(directory, key + ".json")
        fingerprint = digest(json.dumps(request, sort_keys=True, separators=(",", ":")).encode())
        previous = load(receipt_path, None)
        if previous:
            if previous["fingerprint"] != fingerprint:
                fail("REMOTE_IDEMPOTENCY_CONFLICT", "Operation id was used for different input.")
            if previous["state"] != "completed":
                fail("REMOTE_OPERATION_OUTCOME_UNKNOWN", "A previous attempt may have changed files; it will not be replayed.")
            return {**previous["result"], "replayedReceipt": True}
        save(receipt_path, {"fingerprint": fingerprint, "state": "started", "startedAt": time.time()})
        bindings_path = os.path.join(directory, "bindings.json")
        bindings = load(bindings_path, {})
        result = operate(request, repo, common, bindings)
        if action in ("bind", "unbind"):
            save(bindings_path, bindings)
        save(receipt_path, {"fingerprint": fingerprint, "state": "completed", "result": result})
        return result


try:
    raw = sys.stdin.buffer.read(2 * LIMIT + 1)
    if len(raw) > 2 * LIMIT:
        fail("REMOTE_INPUT_LIMIT", "Workspace request exceeded its size limit.")
    response = {"version": VERSION, "ok": True, "result": main(json.loads(raw))}
except Failure as error:
    response = {"version": VERSION, "ok": False, "error": {"code": error.code, "message": str(error)}}
except Exception:
    response = {"version": VERSION, "ok": False, "error": {"code": "REMOTE_OPERATION_FAILED", "message": "Remote Workspace operation failed; no automatic retry was attempted."}}
print(json.dumps(response, ensure_ascii=True, separators=(",", ":")))
