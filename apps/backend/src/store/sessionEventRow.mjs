import { parseJson } from "./storedJson.mjs";

export function sessionEventFromRow(row) {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    logId: row.log_id,
    sequence: Number(row.sequence),
    type: row.type,
    producer: row.producer,
    surface: Number(row.surface) === 1,
    sourceEventSeqs: parseJson(row.source_event_seqs_json, null),
    callId: row.call_id,
    source: parseJson(row.source_json, null),
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at
  };
}
