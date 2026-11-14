// Global queue discovery only reads the small, live partial index. Ineligible
// candidates still advance the cursor, so a batch has bounded work even when
// every pending operation is blocked or already settled.
export const mailboxCandidatePageSql = `SELECT sequence,operation_id,recipient_session_id
  FROM session_mailbox_messages INDEXED BY idx_session_mailbox_dispatch_candidates
  WHERE disposition='pending' AND operation_id IS NOT NULL
    AND (manual_requested=1 OR intent IN ('action_required','response_required','notification'))
    AND sequence > ? ORDER BY sequence LIMIT ?`;

export function readMailboxDispatchPage(database, { after = 0, limit = 100 } = {}) {
  limit = Math.max(1, Math.min(500, Number(limit) || 100));
  const candidates = database.all(mailboxCandidatePageSql, [after, limit], 'mailboxDispatchCandidates');
  const rows = candidates.filter(row => database.get(
    "SELECT 1 FROM agent_operations WHERE task_id=? AND status='queued'", [row.operation_id], 'mailboxDispatchEligibility'));
  return { rows, nextCursor: candidates.length === limit ? candidates.at(-1).sequence : 0 };
}

export function readMemoryExtractionWindow(database, { sessionId }) {
  const row = database.get(`SELECT
    (SELECT COUNT(*) FROM session_events AS events
     WHERE events.session_id=? AND events.sequence>COALESCE(progress.last_event_sequence,0)
       AND events.type IN ('SessionUserMessageCreated','user.message.accepted')) AS user_messages,
    progress.updated_at AS last_extracted_at
    FROM (SELECT 1) AS singleton
    LEFT JOIN memory_extraction_progress AS progress ON progress.session_id=?`, [sessionId, sessionId], 'memoryExtractionWindow');
  return { userMessages: Number(row?.user_messages ?? 0), lastExtractedAt: row?.last_extracted_at ?? null };
}
