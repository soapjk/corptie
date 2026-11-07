import assert from "node:assert/strict";
import test from "node:test";
import { logCloudError } from "../src/errorDiagnostics.js";

function capture(run: () => void): string {
  const original = console.error;
  const output: string[] = [];
  console.error = (...args: unknown[]) => { output.push(args.join(" ")); };
  try { run(); } finally { console.error = original; }
  return output.join("\n");
}

test("cloud logs original native stacks and system causes without mutating the error", () => {
  const cause = Object.freeze(Object.assign(new Error("socket refused"), { code: "ECONNREFUSED", syscall: "connect" }));
  const failure = Object.freeze(new Error("fetch failed", { cause }));
  const output = capture(() => logCloudError("cloud.test", failure));
  assert.match(output, /ECONNREFUSED/);
  assert.match(output, /connect/);
  assert.match(output, /\\n\s+at /);
  assert.equal(failure.cause, cause);
});

test("cloud omits parser payloads and strips credentials and URL queries", () => {
  const output = capture(() => {
    try { JSON.parse("private-cloud-payload-canary"); } catch (error) { logCloudError("cloud.parse", error); }
    logCloudError("cloud.auth", new Error("Authorization: Basic dXNlcjpwYXNz https://user:pass@host.test/path?token=hidden password=hidden"));
  });
  for (const secret of ["private-cloud-payload-canary", "dXNlcjpwYXNz", "user:pass", "?token", "hidden"]) assert.ok(!output.includes(secret), secret);
  assert.match(output, /SyntaxError/);
});

test("cloud logging handles cyclic causes and hostile metadata or sink failures", () => {
  const failure = new Error("cycle"); Object.assign(failure, { cause: failure });
  assert.match(capture(() => logCloudError("cloud.cycle", failure)), /circular/);
  let invoked = false;
  capture(() => logCloudError("cloud.getter", { get message() { invoked = true; throw new Error("getter"); } }));
  assert.equal(invoked, false);
  const original = console.error; console.error = () => { throw new Error("sink failed"); };
  try { assert.doesNotThrow(() => logCloudError("cloud.sink", failure)); } finally { console.error = original; }
});
