import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextReleaseVersion, readNextRelease, commitRelease } from "../release-version.mjs";

test("CLI runs through both physical and symlinked project paths", async t => {
  const temporary = await mkdtemp(join(tmpdir(), "corptie-version-cli-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "project");
  const alias = join(temporary, "alias");
  await mkdir(root);
  await copyFile(new URL("../release-version.mjs", import.meta.url), join(root, "release-version.mjs"));
  await writeFile(join(root, "release-version.json"), JSON.stringify({ version: "0.5.6", buildNumber: 1 }));
  await symlink(root, alias, "dir");
  const run = promisify(execFile);
  for (const path of [root, alias]) {
    const { stdout, stderr } = await run(process.execPath, [join(path, "release-version.mjs"), "next", path]);
    assert.equal(stdout, "0.5.7 2\n");
    assert.equal(stderr, "");
  }
  await writeFile(join(root, "release-version.json"), JSON.stringify({ version: "invalid", buildNumber: 1 }));
  await assert.rejects(run(process.execPath, [join(alias, "release-version.mjs"), "next", alias]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Invalid or exhausted release version/);
    return true;
  });
});

test("patch and build increment from the single version source", () => {
  assert.deepEqual(nextReleaseVersion({ version: "0.5.6", buildNumber: 1 }), {
    version: "0.5.7", buildNumber: 2,
  });
  assert.deepEqual(nextReleaseVersion({ version: "1.2.99", buildNumber: 99 }), {
    version: "1.2.100", buildNumber: 100,
  });
});

test("reject malformed versions and invalid or exhausted build numbers", () => {
  for (const version of ["v0.5.6", "0.05.6", "0.5.6-beta", "0.5", "-1.2.3", "1.2.9007199254740991"]) {
    assert.throws(() => nextReleaseVersion({ version, buildNumber: 1 }));
  }
  for (const buildNumber of [0, -1, "1", 1.5, 9999, Infinity]) {
    assert.throws(() => nextReleaseVersion({ version: "0.5.6", buildNumber }));
  }
});

test("failed/uncommitted builds keep the version; successful commits advance it", async t => {
  const root = await mkdtemp(join(tmpdir(), "corptie-version-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".corptie/release-version.lock"), { recursive: true });
  const file = join(root, "release-version.json");
  const original = JSON.stringify({ version: "0.5.6", buildNumber: 1 });
  await writeFile(file, original);
  const next = await readNextRelease(root);
  assert.equal(await readFile(file, "utf8"), original);
  assert.deepEqual(await readNextRelease(root), next);
  await commitRelease(root, next);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), next);
  await assert.rejects(commitRelease(root, next), /changed during packaging/);
  assert.deepEqual(await readNextRelease(root), { version: "0.5.8", buildNumber: 3 });
});

test("do not overwrite a version edited while packaging", async t => {
  const root = await mkdtemp(join(tmpdir(), "corptie-version-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".corptie/release-version.lock"), { recursive: true });
  await writeFile(join(root, "release-version.json"), JSON.stringify({ version: "0.6.0", buildNumber: 7 }));
  await assert.rejects(commitRelease(root, { version: "0.5.7", buildNumber: 2 }), /changed during packaging/);
  assert.deepEqual(await readNextRelease(root), { version: "0.6.1", buildNumber: 8 });
});

test("packaging uses one version for plist, installer and names; commits after DMG", async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const script = await readFile(join(root, "scripts/package-macos-installer.sh"), "utf8");
  assert.match(script, /mkdir "\$\{VERSION_LOCK\}"/);
  assert.match(script, /trap release_version_lock EXIT/);
  assert.match(script, /CFBundleShortVersionString<\/key>\s*<string>\$\{APP_VERSION\}/);
  assert.match(script, /CFBundleVersion<\/key>\s*<string>\$\{APP_BUILD_NUMBER\}/);
  assert.match(script, /--version "\$\{APP_VERSION\}"/);
  assert.match(script, /Corptie-Production-\$\{APP_VERSION\}-\$\{TIMESTAMP\}\.pkg/);
  assert.match(script, /Corptie-Production-\$\{APP_VERSION\}-\$\{TIMESTAMP\}\.dmg/);
  assert.ok(script.indexOf('hdiutil create "${DMG_NAME}"') < script.indexOf('release-version.mjs" commit'));
});
