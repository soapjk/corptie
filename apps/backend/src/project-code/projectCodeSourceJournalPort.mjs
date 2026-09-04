import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../native/corptie_native.node");

export function loadProjectCodeSourceJournalPort() {
  let native;
  try { native = require(nativePath); } catch { return null; }
  if (typeof native.sourceJournalStart !== "function"
    || typeof native.sourceJournalReset !== "function"
    || typeof native.sourceJournalBarrier !== "function"
    || typeof native.sourceJournalStop !== "function") return null;
  return Object.freeze({
    capability: "native-journal-barrier/v1",
    open(root) {
      const result = native.sourceJournalStart(root);
      return Object.freeze({ handle: result.handle, trusted: result.trusted === true });
    },
    barrier(journal) {
      const result = native.sourceJournalBarrier(journal.handle);
      return Object.freeze({
        epoch: String(result.epoch),
        eventId: String(result.eventId),
        trusted: result.trusted === true,
        errorCode: result.errorCode ?? null
      });
    },
    reset(journal, paths) {
      const result = native.sourceJournalReset(journal.handle, paths);
      return Object.freeze({ epoch: String(result.epoch), eventId: String(result.eventId),
        trusted: result.trusted === true, errorCode: result.errorCode ?? null });
    },
    close(journal) { native.sourceJournalStop(journal.handle); }
  });
}
