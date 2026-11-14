// Executed by the migration worker before runtime readiness, never lazily on a
// user message. Additive indexes preserve compatibility with the prior runtime.
export function migrateDispatchReadIndexes(db) {
  db.run(`CREATE INDEX IF NOT EXISTS idx_session_mailbox_dispatch_candidates
    ON session_mailbox_messages(sequence,operation_id,recipient_session_id)
    WHERE disposition='pending' AND operation_id IS NOT NULL
      AND (manual_requested=1 OR intent IN ('action_required','response_required','notification'));
    CREATE INDEX IF NOT EXISTS idx_session_events_memory_window
      ON session_events(session_id,sequence)
      WHERE type IN ('SessionUserMessageCreated','user.message.accepted');
    CREATE INDEX IF NOT EXISTS idx_provider_event_inbox_cleanup_session ON provider_event_inbox(session_id);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_cleanup_session ON event_outbox(session_id);`);
}
