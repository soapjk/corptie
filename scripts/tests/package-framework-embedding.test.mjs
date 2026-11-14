import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, "..", "..");
const source = readFileSync(path.join(root, "scripts", "package-macos-installer.sh"), "utf8");

test("packaging removes external RPATHs from both Swift executables before signing", {
  skip: process.platform !== "darwin"
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "corptie-rpath-"));
  try {
    const app = path.join(directory, "Corptie.app");
    const main = path.join(app, "Contents/MacOS/Corptie");
    const helper = path.join(app, "Contents/Helpers/CorptieComputerUse");
    mkdirSync(path.dirname(main), { recursive: true });
    mkdirSync(path.dirname(helper), { recursive: true });
    const cFile = path.join(directory, "main.c");
    writeFileSync(cFile, "int main(void) { return 0; }\n");
    const run = (command, args, options = {}) => {
      const result = spawnSync(command, args, { encoding: "utf8", ...options });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const retained = ["/usr/lib/swift", "/System/Library/Frameworks", "@loader_path", "@executable_path/../Frameworks"];
    const external = ["/build machine/Xcode.app/usr/lib/swift", "/private/tmp/swift-build"];
    for (const binary of [main, helper]) {
      run("xcrun", ["clang", cFile, "-o", binary,
        ...[...retained, ...external].flatMap(value => ["-Xlinker", "-rpath", "-Xlinker", value])]);
    }
    const block = source.slice(source.indexOf("for swift_binary in"), source.indexOf("RESOURCE_BUNDLE="));
    assert.ok(block.includes("Contents/Helpers/CorptieComputerUse"));
    assert.ok(source.indexOf(block) < source.indexOf('codesign "${SIGN_FLAGS[@]}" --identifier com.corptie.computer-use'));
    run("bash", ["-euc", block], { env: { ...process.env, APP_DIR: app, PRODUCT_NAME: "Corptie" } });
    for (const binary of [main, helper]) {
      const commands = run("otool", ["-l", binary]);
      const paths = [...commands.matchAll(/cmd LC_RPATH\n\s*cmdsize \d+\n\s*path (.+) \(offset \d+\)/g)].map(match => match[1]);
      assert.deepEqual(paths, retained);
      run("codesign", ["--force", "--sign", "-", binary]);
      run("codesign", ["--verify", "--strict", binary]);
      run(binary, []);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("packaging embeds every @rpath framework next to the executable", () => {
  assert.match(source, /otool -L "\$\{BUILD_BIN\}"[\s\S]*?sub\(\/\^@rpath\\\//,
    "the framework list must be derived from the linked binary's @rpath dependencies");
  assert.match(source, /\/usr\/bin\/ditto "\$\{source_framework\}" "\$\{APP_DIR\}\/Contents\/MacOS\/\$\{framework_name\}"/,
    "linked frameworks must be copied into Contents/MacOS");
  assert.match(source, /Linked framework is missing from the build directory/,
    "a missing framework must fail the build instead of producing a broken app");
});

test("embedded frameworks are re-signed with the app identity before sealing", () => {
  const signBlock = source.match(/for framework in "\$\{APP_DIR\}\/Contents\/MacOS"\/\*\.framework; do[\s\S]*?\ndone/);
  assert.ok(signBlock, "packaging must iterate over embedded frameworks for signing");
  assert.match(signBlock[0], /codesign "\$\{SIGN_FLAGS\[@\]\}" --deep "\$\{framework\}"/,
    "upstream vendor signatures have a different Team ID and are rejected under the hardened runtime");
});

test("the build fails when a linked @rpath dependency is absent from the package", () => {
  assert.match(source, /Packaged app is missing a linked @rpath dependency/,
    "a dyld-time launch crash must be caught before the package is written");
  assert.match(source, /otool -L "\$\{APP_DIR\}\/Contents\/MacOS\/\$\{PRODUCT_NAME\}"/,
    "the check must run against the packaged binary, not the build artifact");
});

test("the @rpath parser extracts the framework name from dyld dependency strings", () => {
  const block = source.match(/# SwiftPM can link binary targets[\s\S]*?(?=# SwiftPM can embed)/);
  assert.ok(block, "the embedding block must be present");
  // Run the shipped awk program itself so this is a behaviour check, not a
  // copy of the parsing logic.
  const parser = block[0].split("\n").find((line) => line.includes("awk '$1 ~ /^@rpath"));
  assert.ok(parser, "the framework parser must be an awk expression in the embedding pipeline");
  const program = parser.slice(parser.indexOf("awk '") + 5, parser.lastIndexOf("' "));
  const result = spawnSync("awk", [program], {
    input: [
      "\t@rpath/Sparkle.framework/Versions/B/Sparkle (compatibility version 1.6.0, current version 2.10.1)",
      "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)",
      "\t@rpath/Other.framework/Versions/A/Other (compatibility version 1.0.0, current version 1.0.0)"
    ].join("\n") + "\n",
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").sort(),
    ["Other.framework", "Sparkle.framework"]);
});
