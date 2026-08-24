import Foundation
import SQLite3

struct StoredSessionTimelinePosition: Equatable, Sendable {
    let sessionID: String
    let position: AppKitChatTimelinePosition
    let savedAtMilliseconds: Int64
}

struct StoredSessionTimelineWindow: Equatable, Sendable {
    let sessionID: String
    let payload: Data
    let revision: Int64
    let savedAtMilliseconds: Int64
}

enum SessionTimelinePositionRepositoryError: Error, Equatable {
    case invalidSessionID
    case invalidPosition
    case openFailed
    case migrationFailed
    case readFailed
    case writeFailed
}

/// Device-local persistence for semantic Session viewports.
///
/// The repository is intentionally independent from Provider and backend
/// contracts: a viewport belongs to this Mac UI, not to an Agent thread. The
/// actor serializes SQLite access while callers retain only a bounded hot cache.
actor SessionTimelinePositionRepository {
    private static let maximumTimelineWindowBytes = 64 * 1_024 * 1_024
    private static let maximumTimelineWindowCount = 256
    private static let maximumSingleWindowBytes = 8 * 1_024 * 1_024
    @MainActor
    static let shared: SessionTimelinePositionRepository = {
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        let directory = support.appendingPathComponent(
            CorptieAppEnvironment.appSupportFolderName,
            isDirectory: true
        )
        return SessionTimelinePositionRepository(
            databaseURL: directory.appendingPathComponent("presentation.sqlite3")
        )
    }()

    private let databaseURL: URL
    // SQLite is opened with FULLMUTEX and all normal access is actor-isolated.
    // `nonisolated(unsafe)` only permits the Swift 6 nonisolated deinitializer
    // to close the opaque C handle after actor work has drained.
    nonisolated(unsafe) private var database: OpaquePointer?
    private var startupError: SessionTimelinePositionRepositoryError?

    init(databaseURL: URL) {
        self.databaseURL = databaseURL
        do {
            try FileManager.default.createDirectory(
                at: databaseURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            var handle: OpaquePointer?
            let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
            guard sqlite3_open_v2(databaseURL.path, &handle, flags, nil) == SQLITE_OK,
                  let handle else {
                sqlite3_close(handle)
                startupError = .openFailed
                return
            }
            database = handle
            guard sqlite3_exec(handle, "PRAGMA journal_mode=WAL", nil, nil, nil) == SQLITE_OK,
                  sqlite3_exec(handle, "PRAGMA synchronous=NORMAL", nil, nil, nil) == SQLITE_OK,
                  sqlite3_exec(handle, Self.schemaSQL, nil, nil, nil) == SQLITE_OK else {
                sqlite3_close(handle)
                database = nil
                startupError = .migrationFailed
                return
            }
        } catch {
            startupError = .openFailed
        }
    }

    deinit {
        sqlite3_close(database)
    }

    func loadAll() throws -> [StoredSessionTimelinePosition] {
        if let startupError { throw startupError }
        guard let database else { throw SessionTimelinePositionRepositoryError.openFailed }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(
            database,
            """
            SELECT session_id, anchor_row_id, offset_in_row, absolute_scroll_y,
                   follows_latest, saved_at_ms
            FROM timeline_viewport_positions_v1
            ORDER BY saved_at_ms ASC, session_id ASC
            """,
            -1,
            &statement,
            nil
        ) == SQLITE_OK else {
            throw SessionTimelinePositionRepositoryError.readFailed
        }
        defer { sqlite3_finalize(statement) }

        var records: [StoredSessionTimelinePosition] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let sessionCString = sqlite3_column_text(statement, 0),
                  let rowCString = sqlite3_column_text(statement, 1) else { continue }
            let record = StoredSessionTimelinePosition(
                sessionID: String(cString: sessionCString),
                position: AppKitChatTimelinePosition(
                    rowID: String(cString: rowCString),
                    offset: sqlite3_column_double(statement, 2),
                    absoluteScrollY: sqlite3_column_double(statement, 3),
                    followsLatest: sqlite3_column_int(statement, 4) != 0
                ),
                savedAtMilliseconds: sqlite3_column_int64(statement, 5)
            )
            guard Self.isValid(record) else { continue }
            records.append(record)
        }
        guard sqlite3_errcode(database) == SQLITE_OK || sqlite3_errcode(database) == SQLITE_DONE else {
            throw SessionTimelinePositionRepositoryError.readFailed
        }
        return records
    }

    func load(sessionID: String) throws -> StoredSessionTimelinePosition? {
        guard !sessionID.isEmpty, sessionID.utf8.count <= 512 else {
            throw SessionTimelinePositionRepositoryError.invalidSessionID
        }
        if let startupError { throw startupError }
        guard let database else { throw SessionTimelinePositionRepositoryError.openFailed }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(
            database,
            """
            SELECT anchor_row_id, offset_in_row, absolute_scroll_y,
                   follows_latest, saved_at_ms
            FROM timeline_viewport_positions_v1
            WHERE session_id = ?
            LIMIT 1
            """,
            -1,
            &statement,
            nil
        ) == SQLITE_OK else {
            throw SessionTimelinePositionRepositoryError.readFailed
        }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, sessionID, -1, Self.sqliteTransient)
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW,
              let rowCString = sqlite3_column_text(statement, 0) else {
            throw SessionTimelinePositionRepositoryError.readFailed
        }
        let record = StoredSessionTimelinePosition(
            sessionID: sessionID,
            position: AppKitChatTimelinePosition(
                rowID: String(cString: rowCString),
                offset: sqlite3_column_double(statement, 1),
                absoluteScrollY: sqlite3_column_double(statement, 2),
                followsLatest: sqlite3_column_int(statement, 3) != 0
            ),
            savedAtMilliseconds: sqlite3_column_int64(statement, 4)
        )
        return Self.isValid(record) ? record : nil
    }

    func upsert(
        _ position: AppKitChatTimelinePosition,
        for sessionID: String,
        savedAtMilliseconds: Int64 = Int64(Date().timeIntervalSince1970 * 1_000)
    ) throws {
        let record = StoredSessionTimelinePosition(
            sessionID: sessionID,
            position: position,
            savedAtMilliseconds: savedAtMilliseconds
        )
        guard !sessionID.isEmpty, sessionID.utf8.count <= 512 else {
            throw SessionTimelinePositionRepositoryError.invalidSessionID
        }
        guard Self.isValid(record) else {
            throw SessionTimelinePositionRepositoryError.invalidPosition
        }
        if let startupError { throw startupError }
        guard let database else { throw SessionTimelinePositionRepositoryError.openFailed }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(
            database,
            """
            INSERT INTO timeline_viewport_positions_v1 (
              session_id, anchor_row_id, offset_in_row, absolute_scroll_y,
              follows_latest, saved_at_ms, schema_version
            ) VALUES (?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(session_id) DO UPDATE SET
              anchor_row_id = excluded.anchor_row_id,
              offset_in_row = excluded.offset_in_row,
              absolute_scroll_y = excluded.absolute_scroll_y,
              follows_latest = excluded.follows_latest,
              saved_at_ms = excluded.saved_at_ms
            WHERE excluded.saved_at_ms >= timeline_viewport_positions_v1.saved_at_ms
            """,
            -1,
            &statement,
            nil
        ) == SQLITE_OK else {
            throw SessionTimelinePositionRepositoryError.writeFailed
        }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, sessionID, -1, Self.sqliteTransient)
        sqlite3_bind_text(statement, 2, position.rowID, -1, Self.sqliteTransient)
        sqlite3_bind_double(statement, 3, position.offset)
        sqlite3_bind_double(statement, 4, position.absoluteScrollY)
        sqlite3_bind_int(statement, 5, position.followsLatest ? 1 : 0)
        sqlite3_bind_int64(statement, 6, savedAtMilliseconds)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw SessionTimelinePositionRepositoryError.writeFailed
        }
    }

    func loadTimelineWindow(sessionID: String) throws -> StoredSessionTimelineWindow? {
        guard !sessionID.isEmpty, sessionID.utf8.count <= 512 else {
            throw SessionTimelinePositionRepositoryError.invalidSessionID
        }
        if let startupError { throw startupError }
        guard let database else { throw SessionTimelinePositionRepositoryError.openFailed }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(
            database,
            """
            SELECT payload_json, revision, saved_at_ms
            FROM session_timeline_windows_v1
            WHERE session_id = ? LIMIT 1
            """,
            -1,
            &statement,
            nil
        ) == SQLITE_OK else {
            throw SessionTimelinePositionRepositoryError.readFailed
        }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, sessionID, -1, Self.sqliteTransient)
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW,
              let bytes = sqlite3_column_blob(statement, 0) else {
            throw SessionTimelinePositionRepositoryError.readFailed
        }
        let byteCount = Int(sqlite3_column_bytes(statement, 0))
        let record = StoredSessionTimelineWindow(
            sessionID: sessionID,
            payload: Data(bytes: bytes, count: byteCount),
            revision: sqlite3_column_int64(statement, 1),
            savedAtMilliseconds: sqlite3_column_int64(statement, 2)
        )
        touchTimelineWindow(sessionID: sessionID)
        return record
    }

    func storeTimelineWindow(
        _ payload: Data,
        sessionID: String,
        revision: Int64,
        savedAtMilliseconds: Int64 = Int64(Date().timeIntervalSince1970 * 1_000)
    ) throws {
        guard !sessionID.isEmpty, sessionID.utf8.count <= 512 else {
            throw SessionTimelinePositionRepositoryError.invalidSessionID
        }
        guard !payload.isEmpty, payload.count <= Self.maximumSingleWindowBytes,
              revision >= 0, savedAtMilliseconds >= 0 else {
            throw SessionTimelinePositionRepositoryError.invalidPosition
        }
        if let startupError { throw startupError }
        guard let database else { throw SessionTimelinePositionRepositoryError.openFailed }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(
            database,
            """
            INSERT INTO session_timeline_windows_v1 (
              session_id, payload_json, revision, byte_count, saved_at_ms, accessed_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              payload_json = excluded.payload_json,
              revision = excluded.revision,
              byte_count = excluded.byte_count,
              saved_at_ms = excluded.saved_at_ms,
              accessed_at_ms = excluded.accessed_at_ms
            WHERE excluded.revision >= session_timeline_windows_v1.revision
            """,
            -1,
            &statement,
            nil
        ) == SQLITE_OK else {
            throw SessionTimelinePositionRepositoryError.writeFailed
        }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, sessionID, -1, Self.sqliteTransient)
        _ = payload.withUnsafeBytes { buffer in
            sqlite3_bind_blob(statement, 2, buffer.baseAddress, Int32(buffer.count), Self.sqliteTransient)
        }
        sqlite3_bind_int64(statement, 3, revision)
        sqlite3_bind_int64(statement, 4, Int64(payload.count))
        sqlite3_bind_int64(statement, 5, savedAtMilliseconds)
        sqlite3_bind_int64(statement, 6, savedAtMilliseconds)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw SessionTimelinePositionRepositoryError.writeFailed
        }
        try trimTimelineWindowsIfNeeded()
    }

    func delete(sessionID: String) throws {
        if let startupError { throw startupError }
        guard let database else { throw SessionTimelinePositionRepositoryError.openFailed }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(
            database,
            "DELETE FROM timeline_viewport_positions_v1 WHERE session_id = ?",
            -1,
            &statement,
            nil
        ) == SQLITE_OK else {
            throw SessionTimelinePositionRepositoryError.writeFailed
        }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, sessionID, -1, Self.sqliteTransient)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw SessionTimelinePositionRepositoryError.writeFailed
        }
    }

    func flush() throws {
        if let startupError { throw startupError }
        guard let database else { throw SessionTimelinePositionRepositoryError.openFailed }
        guard sqlite3_wal_checkpoint_v2(database, nil, SQLITE_CHECKPOINT_PASSIVE, nil, nil) == SQLITE_OK else {
            throw SessionTimelinePositionRepositoryError.writeFailed
        }
    }

    private static func isValid(_ record: StoredSessionTimelinePosition) -> Bool {
        !record.sessionID.isEmpty
            && record.sessionID.utf8.count <= 512
            && record.position.rowID.utf8.count <= 1_024
            && (record.position.rowID.hasPrefix("message:")
                || record.position.rowID.hasPrefix("process:"))
            && record.position.offset.isFinite
            && record.position.absoluteScrollY.isFinite
            && record.position.offset >= 0
            && record.position.absoluteScrollY >= 0
            && record.savedAtMilliseconds >= 0
    }

    private func touchTimelineWindow(sessionID: String) {
        guard let database else { return }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(
            database,
            "UPDATE session_timeline_windows_v1 SET accessed_at_ms = ? WHERE session_id = ?",
            -1,
            &statement,
            nil
        ) == SQLITE_OK else { return }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int64(statement, 1, Int64(Date().timeIntervalSince1970 * 1_000))
        sqlite3_bind_text(statement, 2, sessionID, -1, Self.sqliteTransient)
        _ = sqlite3_step(statement)
    }

    private func trimTimelineWindowsIfNeeded() throws {
        guard let database else { throw SessionTimelinePositionRepositoryError.openFailed }
        while true {
            guard let totals = try? scalarPair(
                database,
                sql: "SELECT COUNT(*), COALESCE(SUM(byte_count), 0) FROM session_timeline_windows_v1"
            ) else { throw SessionTimelinePositionRepositoryError.readFailed }
            guard totals.0 > Self.maximumTimelineWindowCount
                    || totals.1 > Self.maximumTimelineWindowBytes else { return }
            guard sqlite3_exec(
                database,
                """
                DELETE FROM session_timeline_windows_v1 WHERE session_id = (
                  SELECT session_id FROM session_timeline_windows_v1
                  ORDER BY accessed_at_ms ASC, session_id ASC LIMIT 1
                )
                """,
                nil,
                nil,
                nil
            ) == SQLITE_OK else {
                throw SessionTimelinePositionRepositoryError.writeFailed
            }
        }
    }

    private func scalarPair(_ database: OpaquePointer, sql: String) throws -> (Int, Int) {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
            throw SessionTimelinePositionRepositoryError.readFailed
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else {
            throw SessionTimelinePositionRepositoryError.readFailed
        }
        return (Int(sqlite3_column_int64(statement, 0)), Int(sqlite3_column_int64(statement, 1)))
    }

    private static let schemaSQL = """
    CREATE TABLE IF NOT EXISTS timeline_viewport_positions_v1 (
      session_id TEXT PRIMARY KEY NOT NULL,
      anchor_row_id TEXT NOT NULL,
      offset_in_row REAL NOT NULL DEFAULT 0,
      absolute_scroll_y REAL NOT NULL DEFAULT 0,
      follows_latest INTEGER NOT NULL CHECK (follows_latest IN (0, 1)),
      saved_at_ms INTEGER NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_viewport_positions_saved_at
    ON timeline_viewport_positions_v1(saved_at_ms);
    CREATE TABLE IF NOT EXISTS session_timeline_windows_v1 (
      session_id TEXT PRIMARY KEY NOT NULL,
      payload_json BLOB NOT NULL,
      revision INTEGER NOT NULL,
      byte_count INTEGER NOT NULL,
      saved_at_ms INTEGER NOT NULL,
      accessed_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_timeline_windows_accessed_at
    ON session_timeline_windows_v1(accessed_at_ms);
    """

    private static let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
}
