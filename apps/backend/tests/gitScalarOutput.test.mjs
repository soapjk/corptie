import assert from "node:assert/strict";
import test from "node:test";
import { gitScalarOutput } from "../src/utils/gitScalarOutput.mjs";

test("Git scalar parsing removes one record terminator, never path whitespace", () => {
  for (const end of ["\n", "\r\n", ""]) {
    assert.equal(gitScalarOutput(` /tmp/with spaces/.git ${end}`), " /tmp/with spaces/.git ");
    assert.equal(gitScalarOutput(`hash${end}`), "hash");
  }
  assert.equal(gitScalarOutput("/tmp/name\n\n"), "/tmp/name\n");
  assert.equal(gitScalarOutput(""), "");
});
