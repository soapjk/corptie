import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function source(relativePath) {
  return readFile(`${repositoryRoot}/${relativePath}`, "utf8");
}

test("production backend launch agents are registered without daemon semantics", async () => {
  for (const relativePath of [
    "scripts/package-macos-installer.sh",
    "scripts/install-backend-production-launch-agent.sh",
  ]) {
    const contents = await source(relativePath);
    assert.match(contents, /<key>RunAtLoad<\/key>\s*\n\s*<false\/>/u, relativePath);
    assert.match(contents, /<key>KeepAlive<\/key>\s*\n\s*<false\/>/u, relativePath);
    assert.doesNotMatch(contents, /<key>KeepAlive<\/key>\s*\n\s*<true\/>/u, relativePath);
  }

  const standaloneInstaller = await source("scripts/install-backend-production-launch-agent.sh");
  assert.doesNotMatch(standaloneInstaller, /launchctl\s+kickstart/u);
  assert.match(standaloneInstaller, /CorptieMac will start it when the App opens/u);
});

test("development launcher starts one detached App without a process guardian", async () => {
  const contents = await source("scripts/restart-macos-development.sh");
  const detachedLauncher = await source("scripts/launch-development-detached.py");

  assert.doesNotMatch(contents, /launchctl\s+submit/u);
  assert.doesNotMatch(contents, /launchctl\s+(?:bootstrap|kickstart)/u);
  assert.doesNotMatch(contents, /\btmux\b/u);
  assert.doesNotMatch(contents, /<key>(?:RunAtLoad|KeepAlive)<\/key>/u);
  assert.doesNotMatch(contents, /\bnohup\b/u);
  assert.doesNotMatch(contents, /\bopen -n -F/u);
  assert.match(contents, /launch-development-detached\.py/u);
  assert.match(contents, /CORPTIE_DEVELOPMENT_BACKEND_LAUNCHER=/u);
  assert.match(contents, /CORPTIE_DEVELOPMENT_BACKEND_LOG=/u);
  assert.match(detachedLauncher, /os\.setsid\(\)/u);
  assert.match(detachedLauncher, /os\.execve\(executable, \[executable\], os\.environ\)/u);
  assert.doesNotMatch(detachedLauncher, /while|for\s+/u);
});

test("macOS App explicitly starts and stops its owned backend", async () => {
  const contents = await source("apps/macos/Sources/CopetsMac/CopetsMacApp.swift");

  assert.match(contents, /applicationDidFinishLaunching[\s\S]*ensureBackendStarted\(\)/u);
  assert.ok(
    contents.indexOf("CorptieBackendSupervisor.ensureBackendStarted()")
      < contents.indexOf("showWelcomePromptIfNeeded()"),
    "the backend must start before first-run UI can block launch",
  );
  assert.match(contents, /startDevelopmentBackend[\s\S]*process\.executableURL = configuration\.launcherURL/u);
  assert.match(contents, /stopDevelopmentBackend[\s\S]*process\.terminate\(\)[\s\S]*process\.waitUntilExit\(\)/u);
  assert.match(contents, /ensureProductionBackendStarted[\s\S]*\["kickstart"/u);
  assert.match(contents, /applicationShouldTerminate[\s\S]*stopProductionBackend\(\)/u);
});
