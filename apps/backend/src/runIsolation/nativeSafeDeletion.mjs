import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contractError } from "./receiptContracts.mjs";

const require = createRequire(import.meta.url);
const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../native/corptie_native.node");

export function loadNativeSafeDeletion() {
  let native;
  try {
    native = require(nativePath);
  } catch (cause) {
    const error = contractError("RUN_NATIVE_SAFETY_UNAVAILABLE", "The native openat/O_NOFOLLOW safety module is unavailable.");
    error.cause = cause;
    throw error;
  }
  if (typeof native.inspectTreeOpenat !== "function" || typeof native.safeRemoveTreeOpenat !== "function" || typeof native.safeDeleteTreeOpenat !== "function") {
    throw contractError("RUN_NATIVE_SAFETY_UNAVAILABLE", "The native safety module does not expose the required contract.");
  }
  return Object.freeze({
    inspect: (root, relativePath) => native.inspectTreeOpenat(root, relativePath),
    remove: (root, sourceRelativePath, trashRelativePath, identity) => native.safeRemoveTreeOpenat(
      root,
      sourceRelativePath,
      trashRelativePath,
      identity.rootDeviceId,
      identity.rootInode,
      identity.targetDeviceId,
      identity.targetInode
    ),
    delete: (root, relativePath, identity) => native.safeDeleteTreeOpenat(
      root,
      relativePath,
      identity.rootDeviceId,
      identity.rootInode,
      identity.targetDeviceId,
      identity.targetInode
    )
  });
}
