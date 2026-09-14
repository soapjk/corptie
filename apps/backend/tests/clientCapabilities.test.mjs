import assert from "node:assert/strict";
import test from "node:test";
import { clientCapabilities } from "../src/application/clientCapabilities.mjs";

test("client bootstrap does not advertise remote access before authentication is implemented", () => {
  const result = clientCapabilities();
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.connection, { mode: "local-only", deviceAuthentication: false, remoteAccess: false });
  assert.deepEqual(Object.keys(result).sort(), ["connection", "resources", "schemaVersion", "service", "synchronization"]);
  assert.equal(result.synchronization.stateEvents, true);
  assert.equal(result.resources.portableFileAccess, false);
  result.connection.remoteAccess = true;
  assert.equal(clientCapabilities().connection.remoteAccess, false);
});
