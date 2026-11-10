import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, "..", "..");
const packagingScript = path.join(root, "scripts", "package-macos-installer.sh");
const source = readFileSync(packagingScript, "utf8");

// Run the real resolver with a stubbed `df` so the volume-selection policy can
// be verified without filling the machine's system volume.
function resolveTempRoot({ systemFreeKB, checkoutFreeKB, override = "" }) {
  const match = source.match(/^resolve_pkg_temp_root\(\) \{[\s\S]*?^\}$/m);
  assert.ok(match, "package-macos-installer.sh must define resolve_pkg_temp_root()");
  const df = `df() {
  case "\${2:-}" in
    /tmp) printf 'Filesystem 1024-blocks Used Available Capacity\\n/dev/diskX 100 100 ${systemFreeKB} 99% /\\n' ;;
    *) printf 'Filesystem 1024-blocks Used Available Capacity\\n/dev/diskY 100 100 ${checkoutFreeKB} 87% /Volumes/T9\\n' ;;
  esac
}`;
  const script = [
    `ROOT=${JSON.stringify(root)}`,
    "PKG_MIN_FREE_KB=$((3 * 1024 * 1024))",
    match[0],
    df,
    "resolve_pkg_temp_root"
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, CORPTIE_PKG_TEMP_ROOT: override }
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("all packaging temporary directories use the resolved temp root", () => {
  const mktempLines = source.split("\n").filter((line) => line.includes("mktemp"));
  assert.ok(mktempLines.length >= 5, "expected the packaging mktemp call sites");
  for (const line of mktempLines) {
    assert.ok(line.includes("${PKG_TEMP_ROOT}/"),
      `temporary directory is still pinned to the system volume: ${line.trim()}`);
    assert.ok(!line.includes("mktemp -d /tmp/") && !line.includes("mktemp /tmp/"),
      `hard-coded /tmp template remains: ${line.trim()}`);
  }
  assert.ok(source.includes("CORPTIE_PKG_TEMP_ROOT"),
    "callers must be able to force a temporary root explicitly");
});

test("explicit CORPTIE_PKG_TEMP_ROOT wins over volume heuristics", () => {
  assert.equal(
    resolveTempRoot({ systemFreeKB: 100_000, checkoutFreeKB: 900_000, override: "/custom/pkg-tmp" }),
    "/custom/pkg-tmp"
  );
});

test("a nearly full system volume moves staging to the checkout volume", () => {
  // 836 MiB free on /tmp is what broke `make production`: the pkg root and the
  // DMG source each contain a full copy of the app bundle.
  assert.equal(
    resolveTempRoot({ systemFreeKB: 856_000, checkoutFreeKB: 268_676_764 }),
    path.join(root, ".corptie", "package-tmp")
  );
});

test("an ample system volume keeps the historical /tmp behaviour", () => {
  assert.equal(
    resolveTempRoot({ systemFreeKB: 40_000_000, checkoutFreeKB: 268_676_764 }),
    "/tmp"
  );
});
