import assert from "node:assert/strict";
import test from "node:test";
import { isClearCommand } from "../src/commands/unifiedCommands.mjs";

test("/clear is recognized as a unified command", () => {
  assert.equal(isClearCommand("/clear"), true);
  assert.equal(isClearCommand("  /CLEAR  "), true);
  assert.equal(isClearCommand("clear"), false);
  assert.equal(isClearCommand("/clear now"), false);
});
