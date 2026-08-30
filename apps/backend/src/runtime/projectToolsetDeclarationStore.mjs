import { lstat, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, contractError, sha256 } from "./projectToolsetCanonical.mjs";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_DEPTH = 5;
const TOP_LEVEL = new Set(["declaration.json", "generated", "active.json"]);
const EXECUTABLES_BY_KIND = Object.freeze({
  build: new Set(["swift", "cargo", "go", "dotnet"]),
  test: new Set(["swift", "cargo", "go", "dotnet", "pytest"]),
  lint: new Set(["eslint", "ruff", "swiftlint"]),
  typecheck: new Set(["tsc", "mypy", "pyright"]),
  service_validation: new Set(["corptie-service-health"])
});

export class ProjectToolsetDeclarationStore {
  constructor(options = {}) { this.fsRoot = options.fsRoot ?? ".corptie/project-toolset"; }

  async read(projectRoot) {
    const root = rootPath(projectRoot, this.fsRoot);
    await this.validateTree(root, { missing: true });
    const declaration = await readJson(join(root, "declaration.json"));
    const active = await readJson(join(root, "active.json"));
    return { root, declaration, active };
  }

  async writeDeclaration(projectRoot, declaration) {
    validateDeclaration(declaration);
    const root = rootPath(projectRoot, this.fsRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await atomicJson(join(root, "declaration.json"), declaration);
    await this.validateTree(root);
    return { declaration, declarationHash: sha256(canonicalJson(declaration)) };
  }

  async stageGenerated(projectRoot, toolsetVersion, generatedConfigManifest) {
    if (!/^ptv1:[0-9a-f]{64}$/.test(toolsetVersion)) invalid("toolsetVersion is invalid.");
    validateGeneratedManifest(generatedConfigManifest);
    const root = rootPath(projectRoot, this.fsRoot);
    const directory = join(root, "generated", toolsetVersion);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicJson(join(directory, "manifest.json"), generatedConfigManifest);
    await this.validateTree(root);
    return { directory, generatedConfigManifest };
  }

  async activate(projectRoot, input) {
    const fields = ["schemaVersion", "toolsetVersion", "validationPlanIdentity", "receiptId", "receiptHash", "resourceVersion"];
    if (!input || Object.keys(input).sort().join() !== fields.sort().join()) invalid("active declaration must be closed.");
    const root = rootPath(projectRoot, this.fsRoot);
    const generated = await readJson(join(root, "generated", input.toolsetVersion, "manifest.json"));
    if (!generated) invalid("generated manifest is missing.");
    await atomicJson(join(root, "active.json"), input);
    await this.validateTree(root);
    return input;
  }

  async validateTree(root, options = {}) {
    let rootInfo;
    try { rootInfo = await lstat(root); }
    catch (error) { if (options.missing && error.code === "ENOENT") return; throw error; }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) invalid("project-toolset root must be a real directory.");
    const entries = await readdir(root);
    if (entries.some((name) => !TOP_LEVEL.has(name))) invalid("project-toolset has an unknown top-level entry.");
    let files = 0; let bytes = 0;
    const visit = async (directory, depth) => {
      if (depth > MAX_DEPTH) invalid("project-toolset exceeds the maximum depth.");
      for (const name of await readdir(directory)) {
        const path = join(directory, name); const value = await lstat(path);
        if (value.isSymbolicLink() || (!value.isFile() && !value.isDirectory())) invalid("project-toolset contains a forbidden file type.");
        if (value.isFile()) {
          if (value.nlink !== 1 || value.size > MAX_FILE_BYTES) invalid("project-toolset file violates limits.");
          files += 1; bytes += value.size;
        } else await visit(path, depth + 1);
      }
    };
    await visit(root, 1);
    if (files > MAX_FILES || bytes > MAX_BYTES) invalid("project-toolset exceeds storage limits.");
  }
}

export class ExternalValidationCacheStore {
  constructor(options) {
    if (!options?.dataRoot) throw contractError("TOOLSET_DATA_ROOT_UNAVAILABLE", "An external dataRoot is required.");
    this.dataRoot = resolve(options.dataRoot); this.environment = options.environment ?? "development";
    this.maximumReceiptBytes = options.maximumReceiptBytes ?? 256 * 1024;
  }
  path(key) { if (!/^tvck1:[0-9a-f]{64}$/.test(key)) invalid("cache key is invalid."); return join(this.dataRoot, this.environment, "project-toolset", "validation-cache", key.slice(6, 8), `${key}.json`); }
  async get(key) { try { return JSON.parse(await readFile(this.path(key), "utf8")); } catch (error) { if (error.code === "ENOENT") return null; return { corrupt: true, errorCode: "TOOLSET_CACHE_REJECTED" }; } }
  async put(key, receipt) { const text = canonicalJson(receipt); if (Buffer.byteLength(text) > this.maximumReceiptBytes) invalid("receipt exceeds 256KiB."); await atomicText(this.path(key), `${text}\n`); return receipt; }
  async invalidate(key) { await atomicJson(this.path(key), { invalidated: true, key }); }
}

export function validateDeclaration(value) {
  const fields = ["schemaVersion", "projectType", "actions", "assertions", "generatorPolicyVersion", "validationPolicyVersion"];
  if (!value || Object.keys(value).sort().join() !== fields.sort().join() || value.schemaVersion !== 1) invalid("declaration schema is invalid.");
  if (!["node", "swift", "mixed", "generic"].includes(value.projectType)) invalid("unknown project type.");
  if (!Array.isArray(value.actions) || value.actions.length > 64 || !Array.isArray(value.assertions) || value.assertions.length > 256) invalid("declaration plan limits exceeded.");
  value.actions.forEach(validateAction);
  const actionIds = new Set(value.actions.map((action) => action.id));
  value.assertions.forEach((assertion) => validateAssertion(assertion, actionIds));
  return value;
}

function validateAction(action) {
  const fields = ["id", "kind", "argv", "relativeCwd", "required", "timeoutMs"];
  if (!action || Object.keys(action).sort().join() !== fields.sort().join()) invalid("action must be a closed object.");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(action.id) || !["build", "test", "lint", "typecheck", "service_validation"].includes(action.kind)) invalid("action identity is invalid.");
  if (!Array.isArray(action.argv) || action.argv.length < 1 || action.argv.length > 64 || action.argv.some((item) => typeof item !== "string" || !item || /[$`\n\r]/.test(item))) invalid("action argv is unsafe.");
  if (isAbsolute(action.argv[0]) || action.argv[0].includes("/") || !EXECUTABLES_BY_KIND[action.kind].has(action.argv[0])) invalid("action executable is not allowed for this action kind.");
  if (action.argv.slice(1).some((item) => isAbsolute(item) || /^https?:\/\//i.test(item) || /^@/.test(item)
    || /(?:^|[-_])(install|download|fetch|update|upgrade|add)(?:$|[-_])/i.test(item)
    || /\.(?:sh|bash|zsh|fish|js|mjs|cjs|ts|py|rb|pl|ps1)$/i.test(item))) invalid("action argv may not install, download, or execute a script.");
  if (typeof action.relativeCwd !== "string" || isAbsolute(action.relativeCwd) || action.relativeCwd.split(/[\\/]/).includes("..")) invalid("action cwd is unsafe.");
  if (typeof action.required !== "boolean" || !Number.isInteger(action.timeoutMs) || action.timeoutMs < 1 || action.timeoutMs > 3_600_000) invalid("action policy is invalid.");
}

function validateAssertion(assertion, actionIds) {
  const fields = ["id", "actionId", "assertionType", "required"];
  if (!assertion || Object.keys(assertion).sort().join() !== fields.sort().join()) invalid("assertion must be a closed object.");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(assertion.id) || !actionIds.has(assertion.actionId)
    || !["exit_code", "output_schema", "artifact_exists", "service_health", "diagnostic_absence", "custom_declarative"].includes(assertion.assertionType)
    || typeof assertion.required !== "boolean") invalid("assertion is invalid.");
}

function validateGeneratedManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("generated manifest is invalid.");
  if (Object.keys(value).some((key) => !["schemaVersion", "adapter", "configuration"].includes(key)) || value.schemaVersion !== 1) invalid("generated manifest is not closed.");
  const text = canonicalJson(value); if (Buffer.byteLength(text) > MAX_FILE_BYTES) invalid("generated manifest is too large.");
}
function rootPath(projectRoot, relativeRoot) { if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) invalid("project root must be canonical."); const root = resolve(projectRoot, relativeRoot); const rel = relative(resolve(projectRoot), root); if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) invalid("project-toolset root escaped the project."); return root; }
async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; invalid("project-toolset JSON is invalid."); } }
async function atomicJson(path, value) { return atomicText(path, `${canonicalJson(value)}\n`); }
async function atomicText(path, text) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, text, { mode: 0o600 }); await rename(temp, path); }
function invalid(message) { throw contractError("TOOLSET_DECLARATION_INVALID", message); }
