import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexExecutableCandidates, controlledCodexCommand, resolveCodexCommand } from "../src/utils/codexCommand.mjs";
import { ProviderExecutableDiscovery } from "../src/application/providerExecutableDiscovery.mjs";

const currentLayout = name => join(`${name}.app`, "Contents", "Resources", "codex-cli", "bin", "codex");
const legacyLayout = name => join(`${name}.app`, "Contents", "Resources", "codex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "corptie-codex-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shim = async (relative, version) => {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`, { mode: 0o700 });
    return path;
  };
  return { root, shim };
}

test("desktop-only installs are found at the current nested CLI layout without dropping the legacy layout", async t => {
  const { root, shim } = await fixture(t);
  const bundled = await shim(currentLayout("ChatGPT"), "0.166.0-alpha.5.1");
  const legacy = await shim(legacyLayout("ChatGPT"), "0.155.0");
  const codexBundle = await shim(currentLayout("Codex"), "0.166.0-alpha.5.1");

  const candidates = codexExecutableCandidates({ roots: [root] });
  const paths = candidates.map(entry => entry.path);
  assert.ok(paths.includes(bundled), "ChatGPT.app/.../codex-cli/bin/codex must be a candidate");
  assert.ok(paths.includes(codexBundle), "Codex.app bundles must be probed too");
  assert.ok(paths.includes(legacy), "the older .../Resources/codex layout must stay a candidate");
  assert.ok(paths.indexOf(bundled) < paths.indexOf(legacy), "within one app, current layout outranks legacy layout");

  const firstBundle = candidates.findIndex(entry => entry.source !== "cli");
  assert.ok(firstBundle > 0, "PATH-installed CLI candidates must precede desktop bundles");
  assert.ok(candidates.slice(0, firstBundle).every(entry => entry.source === "cli"));
  const bundleSources = new Set(candidates.slice(firstBundle).map(entry => entry.source));
  assert.deepEqual([...bundleSources].sort(), ["ChatGPT", "Codex"]);
});

test("a bundled prerelease CLI is usable alone yet never outranks a release CLI", async t => {
  const { root, shim } = await fixture(t);
  const releaseCli = await shim(join("bin", "codex"), "0.166.0");
  const bundled = await shim(currentLayout("ChatGPT"), "0.166.0-alpha.5.1");
  const appCandidates = codexExecutableCandidates({ roots: [root] })
    .filter(entry => entry.path.startsWith(root));

  const discovery = new ProviderExecutableDiscovery({
    candidates: () => [{ path: releaseCli, source: "cli" }, ...appCandidates]
  });
  const result = await discovery.scan();
  assert.equal(result.recommendedPath, releaseCli, "release CLI stays the recommendation");

  const entry = result.candidates.find(candidate => candidate.path === bundled);
  assert.ok(entry, "desktop-only CLI must still appear in the selectable inventory");
  assert.equal(entry.version, "0.166.0-alpha.5.1");
  assert.equal(entry.prerelease, true, "bundled alpha build is flagged in the setup UI");
  assert.ok(entry.sources.includes("ChatGPT"));
});

test("controlled CORPTIE_CODEX_PATH still wins over any bundled executable", async t => {
  const { shim } = await fixture(t);
  const controlled = await shim(join("controlled", "codex"), "0.166.0");
  const previous = process.env.CORPTIE_CODEX_PATH;
  process.env.CORPTIE_CODEX_PATH = controlled;
  t.after(() => {
    if (previous === undefined) delete process.env.CORPTIE_CODEX_PATH;
    else process.env.CORPTIE_CODEX_PATH = previous;
  });
  assert.equal(controlledCodexCommand(), controlled);
  assert.equal(resolveCodexCommand(), controlled);
});

test("resolveCodexCommand keeps desktop bundles in its fallback chain", async () => {
  const source = await readFile(new URL("../src/utils/codexCommand.mjs", import.meta.url), "utf8");
  assert.match(source, /codex-cli/);
  assert.match(source, /appBundleCandidates\(defaultAppBundleRoots\(\)\)/);
});
