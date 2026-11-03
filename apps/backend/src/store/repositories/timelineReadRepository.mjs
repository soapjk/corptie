import { parseJson } from "../storedJson.mjs";
import { sessionEventFromRow } from "../sessionEventRow.mjs";
import { isAgentNoise, normalizeStoredItem, normalizeStoredText } from "../storedTimelinePresentation.mjs";

export class TimelineReadRepository {
  constructor({ selectAll, selectOne, getSession }) {
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.getSession = getSession;
  }

  // Bounded keyset scan using the existing latest index. No schema changes,
  // provider history, raw metadata, or unbounded COUNT/OFFSET query.
  readUserMessageNavigationPage(sessionId, { cursor = null, direction = "older" } = {}) {
    let anchor = null;
    if (cursor !== null) {
      try {
        if (typeof cursor !== "string" || cursor.length > 4096) throw new Error();
        anchor = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (anchor.s !== sessionId || typeof anchor.t !== "string" || anchor.t.length > 128
          || typeof anchor.i !== "string" || !anchor.i || anchor.i.length > 2048) throw new Error();
      } catch { throw Object.assign(new Error("Invalid navigation cursor."), { statusCode: 400, code: "INVALID_NAVIGATION_CURSOR" }); }
    }
    if (!["older", "newer"].includes(direction) || (!anchor && direction === "newer")) {
      throw Object.assign(new Error("Invalid navigation direction."), { statusCode: 400, code: "INVALID_NAVIGATION_DIRECTION" });
    }
    const ascending = direction === "newer";
    const rows = this.selectAll(`SELECT id, created_at, type, turn_id, presentation_role,
        CASE WHEN type IN ('userMessage', 'agentMessage') AND COALESCE(presentation_role, '') NOT IN ('commentary', 'reasoning')
          THEN substr(COALESCE(presentation_text, text, ''), 1, 180) ELSE '' END AS preview
      FROM session_items WHERE session_id = ?
        ${anchor ? `AND (created_at, id) ${ascending ? ">" : "<"} (?, ?)` : ""}
      ORDER BY created_at ${ascending ? "ASC" : "DESC"}, id ${ascending ? "ASC" : "DESC"} LIMIT 1024`,
      [sessionId, ...(anchor ? [anchor.t, anchor.i] : [])]);
    // Resolve reply excerpts only from this bounded read, by Session-owned turn
    // identity. Never issue one extra query per marker or scan a full transcript.
    const replies = new Map();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[ascending ? rows.length - index - 1 : index];
      if (row.type === "agentMessage" && row.turn_id && row.preview && !replies.has(row.turn_id)) {
        replies.set(row.turn_id, { index, text: row.preview.replace(/\s+/gu, " ").trim() });
      }
    }
    const entries = [];
    let scanned = 0, bytes = 0;
    for (const [index, row] of rows.entries()) {
      const reply = replies.get(row.turn_id);
      const position = ascending ? rows.length - index - 1 : index;
      const item = row.type === "userMessage" ? { id: row.id, createdAt: row.created_at,
        preview: row.preview.replace(/\s+/gu, " ").trim(),
        replyPreview: reply && reply.index < position ? reply.text : null } : null;
      if (item && Buffer.byteLength(item.id) > 2048) throw Object.assign(new Error("Message identity exceeds navigation limits."), { statusCode: 503, code: "NAVIGATION_ITEM_TOO_LARGE" });
      const size = item ? Buffer.byteLength(JSON.stringify(item)) : 0;
      if (item && entries.length && bytes + size > 100000) break;
      scanned += 1;
      if (item) { entries.push(item); bytes += size; }
      if (entries.length === 128) break;
    }
    const used = rows.slice(0, scanned);
    const newest = ascending ? used.at(-1) : used[0];
    const oldest = ascending ? used[0] : used.at(-1);
    const encode = row => row ? Buffer.from(JSON.stringify({ s: sessionId, t: row.created_at, i: row.id })).toString("base64url") : null;
    const exists = (row, comparator) => row && this.selectOne(
      `SELECT 1 AS found FROM session_items WHERE session_id = ? AND (created_at, id) ${comparator} (?, ?) LIMIT 1`,
      [sessionId, row.created_at, row.id]);
    return { schemaVersion: 1, items: ascending ? entries.reverse() : entries,
      olderCursor: exists(oldest, "<") ? encode(oldest) : null,
      newerCursor: exists(newest, ">") ? encode(newest) : null, scannedCount: scanned };
  }

  getItems(sessionId, limit = 240, provider = "") {
    const pageLimit = Math.max(1, Math.min(500, Number.isFinite(limit) && Number(limit) > 0
      ? Math.floor(Number(limit))
      : 240));
    const rows = this.latestTimelineRowsWithConversationBoundaries(sessionId, pageLimit);
    const items = rows
      .map((row) => ({
        id: row.id,
        turnId: row.turn_id,
        turnStatus: row.turn_status,
        type: row.type,
        title: row.title,
        text: normalizeStoredText(row.text, provider),
        options: parseJson(row.options_json, null),
        rawMetadataJSON: row.raw_metadata_json ?? null,
        bindingId: row.binding_id ?? null,
        presentationRole: row.presentation_role ?? null,
        presentationText: row.presentation_text ?? null,
        status: row.status,
        createdAt: row.created_at
      }))
      .filter((item) => !item.text || !isAgentNoise(item.text))
      .map((item) => normalizeStoredItem(item, provider));
    return items;
  }

  // Product conversation only: no Provider transcript, tool payload, or raw metadata.
  readContextConversationPage(sessionId, { before = null, limit = 10, query = null } = {}) {
    const pageLimit = Math.max(1, Math.min(20, Number(limit) || 10));
    const terms = typeof query === "string" ? query.trim().split(/\s+/u).filter(Boolean).slice(0, 8)
      .map((term) => `%${term.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`) : [];
    const rows = this.selectAll(
      `SELECT id, turn_id, type, presentation_role, substr(text, 1, 6001) AS text, created_at
       FROM session_items
       WHERE session_id = ? AND type IN ('userMessage', 'agentMessage')
         AND COALESCE(presentation_role, '') NOT IN ('commentary', 'reasoning')
         ${terms.length ? `AND (${terms.map(() => "text LIKE ? ESCAPE '\\'").join(" OR ")})` : ""}
         ${before ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [sessionId, ...terms, ...(before ? [before.createdAt, before.createdAt, before.id] : []), pageLimit + 1]
    );
    const items = rows.slice(0, pageLimit).map((row) => ({
      id: row.id, turnId: row.turn_id, type: row.type,
      text: row.text ?? "", textTruncated: (row.text?.length ?? 0) > 6000,
      createdAt: row.created_at
    }));
    const tail = items.at(-1);
    return { items, hasMore: rows.length > pageLimit,
      nextCursor: rows.length > pageLimit && tail ? { createdAt: tail.createdAt, id: tail.id } : null };
  }

  readContextMessageChunk(sessionId, itemId, offset = 0, length = 2000) {
    const row = this.selectOne(
      `SELECT id, turn_id, type, created_at, length(text) AS text_length,
              substr(text, ?, ?) AS text
       FROM session_items WHERE session_id = ? AND id = ?
         AND type IN ('userMessage', 'agentMessage')
         AND COALESCE(presentation_role, '') NOT IN ('commentary', 'reasoning')`,
      [offset + 1, length, sessionId, itemId]
    );
    return row ? { id: row.id, turnId: row.turn_id, type: row.type,
      createdAt: row.created_at, text: row.text ?? "", totalCharacters: Number(row.text_length ?? 0) } : null;
  }

  getItemsForTurn(sessionId, turnId, provider = "") {
    const rows = this.selectAll(
      `SELECT id, turn_id, turn_status, type, title, text, options_json,
              raw_metadata_json, binding_id, presentation_role, presentation_text,
              status, created_at
       FROM session_items
       WHERE session_id = ? AND turn_id = ?
       ORDER BY created_at ASC, id ASC`,
      [sessionId, turnId]
    );
    return rows.map((row) => normalizeStoredItem({
      id: row.id,
      turnId: row.turn_id,
      turnStatus: row.turn_status,
      type: row.type,
      title: row.title,
      text: normalizeStoredText(row.text, provider),
      options: parseJson(row.options_json, null),
      rawMetadataJSON: row.raw_metadata_json ?? null,
      bindingId: row.binding_id ?? null,
      presentationRole: row.presentation_role ?? null,
      presentationText: row.presentation_text ?? null,
      status: row.status,
      createdAt: row.created_at
    }, provider));
  }

  getFileChangeItemsForTurn(sessionId, turnId, provider = "", limit = 500) {
    const pageLimit = Math.max(1, Math.min(500, Number(limit) || 500));
    const rows = this.selectAll(
      `SELECT id, turn_id, turn_status, type, title, text, options_json,
              raw_metadata_json, binding_id, presentation_role, presentation_text,
              status, created_at
       FROM session_items
       WHERE session_id = ? AND turn_id = ? AND type = 'fileChange'
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      [sessionId, turnId, pageLimit + 1]
    );
    if (rows.length > pageLimit) {
      const error = new Error("The Turn contains too many file-change records for one safe operation.");
      error.code = "TURN_CHANGE_SET_TOO_LARGE";
      throw error;
    }
    return rows.map((row) => normalizeStoredItem({
      id: row.id,
      turnId: row.turn_id,
      turnStatus: row.turn_status,
      type: row.type,
      title: row.title,
      text: normalizeStoredText(row.text, provider),
      options: parseJson(row.options_json, null),
      rawMetadataJSON: row.raw_metadata_json ?? null,
      bindingId: row.binding_id ?? null,
      presentationRole: row.presentation_role ?? null,
      presentationText: row.presentation_text ?? null,
      status: row.status,
      createdAt: row.created_at
    }, provider));
  }

  latestTimelineRowsWithConversationBoundaries(sessionId, pageLimit) {
    return this.latestTimelineWindowWithConversationBoundaries(sessionId, pageLimit).rows;
  }

  latestTimelineWindowWithConversationBoundaries(sessionId, pageLimit) {
    const columns = `id, turn_id, turn_status, type, title, text, options_json,
                     raw_metadata_json, binding_id, presentation_role, presentation_text,
                     status, created_at`;
    const baseRows = this.selectAll(
      `SELECT id, turn_id, turn_status, type, title, text, options_json,
              raw_metadata_json, binding_id, presentation_role, presentation_text,
              status, created_at
       FROM (
         SELECT id, turn_id, turn_status, type, title, text, options_json,
                raw_metadata_json, binding_id, presentation_role, presentation_text,
                status, created_at
         FROM session_items
         WHERE session_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, id ASC`,
      [sessionId, pageLimit]
    );
    const representedTurns = [...new Set(baseRows
      .filter((row) => row.type !== "userMessage" && row.type !== "agentMessage")
      .map((row) => row.turn_id)
      .filter(Boolean))].slice(-8);
    if (representedTurns.length === 0) {
      return {
        rows: baseRows,
        authoritativeItemIds: baseRows.map((row) => row.id),
        supplementalItemIds: []
      };
    }
    const placeholders = representedTurns.map(() => "?").join(", ");
    const conversationRows = this.selectAll(
      `SELECT rowid AS storage_order, ${columns} FROM session_items
       WHERE session_id = ? AND turn_id IN (${placeholders})
         AND type IN ('userMessage', 'agentMessage')
       ORDER BY rowid ASC`,
      [sessionId, ...representedTurns]
    );
    const boundaryByTurn = new Map();
    for (const turnId of representedTurns) {
      const rows = conversationRows.filter((row) => row.turn_id === turnId);
      boundaryByTurn.set(turnId, {
        user: rows.find((row) => row.type === "userMessage") ?? null,
        agent: rows.findLast((row) => row.type === "agentMessage") ?? null
      });
    }
    const lastIndexByTurn = new Map();
    baseRows.forEach((row, index) => lastIndexByTurn.set(row.turn_id, index));
    const result = [];
    const emitted = new Set();
    for (let index = 0; index < baseRows.length; index += 1) {
      const row = baseRows[index];
      const boundary = boundaryByTurn.get(row.turn_id);
      if (boundary?.user && !emitted.has(boundary.user.id)) {
        result.push(boundary.user);
        emitted.add(boundary.user.id);
      }
      if (!emitted.has(row.id)) {
        result.push(row);
        emitted.add(row.id);
      }
      if (lastIndexByTurn.get(row.turn_id) === index
        && boundary?.agent && !emitted.has(boundary.agent.id)) {
        result.push(boundary.agent);
        emitted.add(boundary.agent.id);
      }
    }
    const authoritativeIDs = new Set(baseRows.map((row) => row.id));
    return {
      rows: result,
      authoritativeItemIds: result.filter((row) => authoritativeIDs.has(row.id)).map((row) => row.id),
      supplementalItemIds: result.filter((row) => !authoritativeIDs.has(row.id)).map((row) => row.id)
    };
  }

  getTimelineItemWindow(
    sessionId,
    { anchorKind = "item", anchorId, before = 40, after = 40, provider = "" } = {}
  ) {
    const beforeLimit = Math.floor(Math.max(1, Math.min(200, Number(before) || 40)));
    const afterLimit = Math.floor(Math.max(1, Math.min(200, Number(after) || 40)));
    const columns = `id, turn_id, turn_status, type, title, text, options_json,
                     raw_metadata_json, binding_id, presentation_role, presentation_text,
                     status, created_at`;
    const anchorRows = anchorKind === "turn"
      ? this.selectAll(
        `SELECT ${columns} FROM session_items
         WHERE session_id = ? AND turn_id = ?
         ORDER BY created_at ASC, id ASC LIMIT 200`,
        [sessionId, anchorId]
      )
      : this.selectAll(
        `SELECT ${columns} FROM session_items
         WHERE session_id = ? AND id = ? LIMIT 1`,
        [sessionId, anchorId]
      );
    if (anchorRows.length === 0) return null;

    const firstAnchor = anchorRows[0];
    const lastAnchor = anchorRows.at(-1);
    const beforeRows = this.selectAll(
      `SELECT ${columns} FROM session_items INDEXED BY idx_session_items_latest
       WHERE session_id = ?
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [sessionId, firstAnchor.created_at, firstAnchor.created_at, firstAnchor.id, beforeLimit]
    ).reverse();
    const afterRows = this.selectAll(
      `SELECT ${columns} FROM session_items
       WHERE session_id = ?
         AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      [sessionId, lastAnchor.created_at, lastAnchor.created_at, lastAnchor.id, afterLimit]
    );
    const rows = [...beforeRows, ...anchorRows, ...afterRows];
    const first = rows[0];
    const last = rows.at(-1);
    const hasEarlier = Boolean(this.selectOne(
      `SELECT 1 FROM session_items INDEXED BY idx_session_items_latest WHERE session_id = ?
       AND (created_at < ? OR (created_at = ? AND id < ?)) LIMIT 1`,
      [sessionId, first.created_at, first.created_at, first.id]
    ));
    const hasLater = Boolean(this.selectOne(
      `SELECT 1 FROM session_items WHERE session_id = ?
       AND (created_at > ? OR (created_at = ? AND id > ?)) LIMIT 1`,
      [sessionId, last.created_at, last.created_at, last.id]
    ));
    return {
      items: rows.map((row) => normalizeStoredItem({
        id: row.id,
        turnId: row.turn_id,
        turnStatus: row.turn_status,
        type: row.type,
        title: row.title,
        text: normalizeStoredText(row.text, provider),
        options: parseJson(row.options_json, null),
        rawMetadataJSON: row.raw_metadata_json ?? null,
        bindingId: row.binding_id ?? null,
        presentationRole: row.presentation_role ?? null,
        presentationText: row.presentation_text ?? null,
        status: row.status,
        createdAt: row.created_at
      }, provider)),
      hasEarlier,
      hasLater
    };
  }

  getSessionTimelineHistoryPage(sessionId, { beforeId = null, limit = 200, provider = "" } = {}) {
    const pageLimit = Math.floor(Math.max(1, Math.min(200, Number(limit) || 200)));
    const columns = `id, turn_id, turn_status, type, title, text, options_json,
                     raw_metadata_json, binding_id, presentation_role, presentation_text,
                     status, created_at`;
    let boundary = null;
    if (beforeId) {
      boundary = this.selectOne(
        "SELECT created_at, id FROM session_items WHERE session_id = ? AND id = ? LIMIT 1",
        [sessionId, beforeId]
      );
      if (!boundary) {
        return { items: [], hasMoreHistory: false, historyItemsCount: 0, cursorStatus: "invalid" };
      }
    }
    const pageRows = this.selectAll(
      `SELECT ${columns} FROM session_items INDEXED BY idx_session_items_latest
       WHERE session_id = ?
         ${boundary ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      boundary
        ? [sessionId, boundary.created_at, boundary.created_at, boundary.id, pageLimit + 1]
        : [sessionId, pageLimit + 1]
    );
    const hasMoreHistory = pageRows.length > pageLimit;
    const rows = pageRows.slice(0, pageLimit).reverse();
    if (rows.length === 0) {
      return { items: [], hasMoreHistory: false, historyItemsCount: 0, cursorStatus: "exhausted" };
    }
    return {
      items: rows.map((row) => normalizeStoredItem({
        id: row.id,
        turnId: row.turn_id,
        turnStatus: row.turn_status,
        type: row.type,
        title: row.title,
        text: normalizeStoredText(row.text, provider),
        options: parseJson(row.options_json, null),
        rawMetadataJSON: row.raw_metadata_json ?? null,
        bindingId: row.binding_id ?? null,
        presentationRole: row.presentation_role ?? null,
        presentationText: row.presentation_text ?? null,
        status: row.status,
        createdAt: row.created_at
      }, provider)),
      hasMoreHistory,
      // Exact remaining counts require a linear history scan and are not used
      // by the client. hasMoreHistory is the authoritative continuation signal.
      historyItemsCount: hasMoreHistory ? null : 0,
      cursorStatus: "found"
    };
  }

  getLatestTimelineItemWindow(sessionId, { limit = 200, provider = "" } = {}) {
    const pageLimit = Math.floor(Math.max(1, Math.min(200, Number(limit) || 200)));
    const timelineWindow = this.latestTimelineWindowWithConversationBoundaries(sessionId, pageLimit);
    const { rows, authoritativeItemIds, supplementalItemIds } = timelineWindow;
    // An existing Session with no Timeline items still has a valid, fully
    // authoritative local window. Returning null used to route the read into
    // the legacy detail/supplementary composer, which performed several
    // unrelated queue, collaboration, and automation queries per active
    // Session. Empty is data, not a cache miss.
    if (rows.length === 0) {
      return { items: [], hasEarlier: false, hasLater: false, historyItemsCount: 0 };
    }
    const authoritativeIDs = new Set(authoritativeItemIds);
    const first = rows.find((row) => authoritativeIDs.has(row.id));
    const hasEarlier = Boolean(this.selectOne(
      `SELECT 1 FROM session_items INDEXED BY idx_session_items_latest
       WHERE session_id = ?
         AND (created_at < ? OR (created_at = ? AND id < ?))
       LIMIT 1`,
      [sessionId, first.created_at, first.created_at, first.id]
    ));
    return {
      items: rows.map((row) => normalizeStoredItem({
        id: row.id,
        turnId: row.turn_id,
        turnStatus: row.turn_status,
        type: row.type,
        title: row.title,
        text: normalizeStoredText(row.text, provider),
        options: parseJson(row.options_json, null),
        rawMetadataJSON: row.raw_metadata_json ?? null,
        bindingId: row.binding_id ?? null,
        presentationRole: row.presentation_role ?? null,
        presentationText: row.presentation_text ?? null,
        status: row.status,
        createdAt: row.created_at
      }, provider)),
      authoritativeItemIds,
      supplementalItemIds,
      hasEarlier,
      hasLater: false,
      historyItemsCount: hasEarlier ? null : 0
    };
  }

  listStoredTimelineEvents(sessionId, { beforeSequence = null, limit = 400 } = {}) {
    const pageLimit = Math.max(1, Math.min(500, Number(limit) || 400));
    const before = Number(beforeSequence);
    const hasBefore = Number.isSafeInteger(before) && before > 0;
    return this.selectAll(
      `SELECT event_id, session_id, log_id, sequence, type, producer, surface,
              source_event_seqs_json, call_id, source_json, payload_json, created_at
       FROM (
         SELECT event_id, session_id, log_id, sequence, type, producer, surface,
                source_event_seqs_json, call_id, source_json, payload_json, created_at
         FROM session_events
         WHERE session_id = ?
           ${hasBefore ? "AND sequence < ?" : ""}
           AND type IN (
             'user/message', 'assistant/message', 'SessionUserMessageCreated',
             'CodexThreadCompleted', 'TaskCompleted', 'AgentTurnCompleted'
           )
         ORDER BY sequence DESC LIMIT ?
       )
       ORDER BY sequence ASC`,
      hasBefore ? [sessionId, before, pageLimit] : [sessionId, pageLimit]
    ).map(sessionEventFromRow);
  }

  getSessionItem(sessionId, itemId) {
    const row = this.selectOne(
      `SELECT id, turn_id, turn_status, type, title, text, options_json,
              raw_metadata_json, binding_id, presentation_role, presentation_text,
              status, created_at
       FROM session_items WHERE session_id = ? AND id = ?`,
      [sessionId, itemId]
    );
    if (!row) return null;
    const provider = this.getSession(sessionId)?.external?.provider ?? "";
    return normalizeStoredItem({
      id: row.id,
      turnId: row.turn_id,
      turnStatus: row.turn_status,
      type: row.type,
      title: row.title,
      text: normalizeStoredText(row.text, provider),
      options: parseJson(row.options_json, null),
      rawMetadataJSON: row.raw_metadata_json ?? null,
      bindingId: row.binding_id ?? null,
      presentationRole: row.presentation_role ?? null,
      presentationText: row.presentation_text ?? null,
      status: row.status,
      createdAt: row.created_at
    }, provider);
  }

  getItemsForBinding(sessionId, bindingId, limit = 20_000) {
    const pageLimit = Math.max(1, Math.min(20_000, Number(limit) || 20_000));
    const provider = this.getSession(sessionId)?.external?.provider ?? "";
    return this.selectAll(
      `SELECT id, turn_id, turn_status, type, title, text, options_json,
              raw_metadata_json, binding_id, presentation_role, presentation_text,
              status, created_at
       FROM session_items
       WHERE session_id = ? AND binding_id = ?
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      [sessionId, bindingId, pageLimit]
    ).map((row) => normalizeStoredItem({
      id: row.id,
      turnId: row.turn_id,
      turnStatus: row.turn_status,
      type: row.type,
      title: row.title,
      text: normalizeStoredText(row.text, provider),
      options: parseJson(row.options_json, null),
      rawMetadataJSON: row.raw_metadata_json ?? null,
      bindingId: row.binding_id ?? null,
      presentationRole: row.presentation_role ?? null,
      presentationText: row.presentation_text ?? null,
      status: row.status,
      createdAt: row.created_at
    }, provider));
  }
}
