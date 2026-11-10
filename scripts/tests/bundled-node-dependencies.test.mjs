import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  libraryDependencies,
  isBundledRuntimeDependency,
} from "../macho-library-dependencies.mjs";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, "..", "..");

const app = "/Applications/Corptie.app";
const autoupdate = `${app}/Contents/MacOS/Sparkle.framework/Versions/B/Autoupdate`;

// Real shape of `otool -L` for Sparkle's universal Autoupdate helper: one
// header per architecture, then tab-indented dylib entries.
const universalOutput = [
  `${autoupdate} (architecture x86_64):`,
  "\t/usr/lib/libz.1.dylib (compatibility version 1.0.0, current version 1.2.12)",
  "\t/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation (compatibility version 300.0.0, current version 5026.5.4)",
  `${autoupdate} (architecture arm64):`,
  "\t@rpath/Sparkle.framework/Versions/B/Sparkle (compatibility version 1.6.0, current version 2.10.1)",
  "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)",
  "",
].join("\n");

test("universal binary architecture headers are not reported as dependencies", () => {
  const dependencies = libraryDependencies(universalOutput);
  assert.deepEqual(dependencies, [
    "/usr/lib/libz.1.dylib",
    "/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation",
    "@rpath/Sparkle.framework/Versions/B/Sparkle",
    "/usr/lib/libSystem.B.dylib",
  ]);
  assert.ok(dependencies.every(isBundledRuntimeDependency));
  assert.ok(!dependencies.some((dependency) => dependency.includes("Autoupdate")));
});

test("a genuine external absolute dependency is still rejected", () => {
  const output = [
    `${app}/Contents/Helpers/node:`,
    "\t/opt/homebrew/opt/openssl@3/lib/libcrypto.dylib (compatibility version 1.0.0, current version 1.0.0)",
    "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)",
  ].join("\n");
  const dependencies = libraryDependencies(output);
  assert.equal(dependencies.length, 2);
  assert.equal(isBundledRuntimeDependency(dependencies[0]), false);
  assert.equal(isBundledRuntimeDependency(dependencies[1]), true);
});

test("the packaged-runtime verifier uses the shared parser", () => {
  const source = readFileSync(path.join(root, "scripts", "verify-bundled-node.mjs"), "utf8");
  assert.match(source, /libraryDependencies\(libraries\)/);
  assert.match(source, /isBundledRuntimeDependency\(dependency\)/);
  assert.doesNotMatch(source, /libraries\.split\('\\n'\)\.slice\(1\)/);
});
