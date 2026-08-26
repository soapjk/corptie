import Foundation

enum StateStreamLivenessPolicy {
    static let inactivityTimeout: TimeInterval = 45

    static func hasExpired(
        lastActivityAt: Date,
        now: Date = Date(),
        timeout: TimeInterval = inactivityTimeout
    ) -> Bool {
        now.timeIntervalSince(lastActivityAt) >= timeout
    }
}

@MainActor
final class AppStateSyncController {
    static let shared = AppStateSyncController()

    private let store = AppStateStore.shared
    private let baseURL = CorptieAppEnvironment.backendBaseURL
    private var streamTask: Task<Void, Never>?
    private var streamWatchdogTask: Task<Void, Never>?
    private var streamGeneration: UInt64 = 0
    private var streamLastActivityAt = Date()
    private var snapshotRequestGeneration: UInt64 = 0
    private var backgroundActivity: NSObjectProtocol?
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    private init() {}

    func start() {
        guard streamTask == nil else { return }
        beginBackgroundActivityIfNeeded()
        snapshotRequestGeneration &+= 1
        restartStream(refreshSnapshotFirst: true)
    }

    /// Foreground activation is a liveness hint, not a correctness trigger.
    /// Preserve a healthy stream so clicking the window cannot be what makes a
    /// backend Session reach terminal state. Only a missing/stale stream gets a
    /// snapshot-backed recovery.
    func recoverAfterActivation(now: Date = Date()) {
        guard streamTask != nil else {
            start()
            return
        }
        guard StateStreamLivenessPolicy.hasExpired(
            lastActivityAt: streamLastActivityAt,
            now: now
        ) else { return }
        restartStream(refreshSnapshotFirst: true)
    }

    func recoverAfterWake() {
        beginBackgroundActivityIfNeeded()
        restartStream(refreshSnapshotFirst: true)
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        streamWatchdogTask?.cancel()
        streamWatchdogTask = nil
        streamGeneration &+= 1
        snapshotRequestGeneration &+= 1
        if let backgroundActivity {
            ProcessInfo.processInfo.endActivity(backgroundActivity)
            self.backgroundActivity = nil
        }
    }

    func refreshSnapshot() async {
        snapshotRequestGeneration &+= 1
        let requestGeneration = snapshotRequestGeneration
        do {
            let (data, response) = try await URLSession.shared.data(
                from: baseURL.appending(path: "state/snapshot")
            )
            try Self.requireSuccess(response)
            let snapshot = try decoder.decode(StateSnapshotEnvelope.self, from: data)
            guard requestGeneration == snapshotRequestGeneration else { return }
            store.apply(snapshot: snapshot)
        } catch {
            guard requestGeneration == snapshotRequestGeneration else { return }
            store.reportSyncError(Self.syncErrorMessage(error))
        }
    }

    func hydrateSession(_ id: String) async -> TaskSession? {
        if let session = store.session(id) { return session }
        await refreshSnapshot()
        return store.session(id)
    }

    private func restartStream(refreshSnapshotFirst: Bool) {
        beginBackgroundActivityIfNeeded()
        streamTask?.cancel()
        streamWatchdogTask?.cancel()
        streamGeneration &+= 1
        let generation = streamGeneration
        streamLastActivityAt = Date()

        streamTask = Task { [weak self] in
            guard let self else { return }
            if refreshSnapshotFirst { await refreshSnapshot() }
            while !Task.isCancelled, generation == streamGeneration {
                await consumeStream(generation: generation)
                guard !Task.isCancelled, generation == streamGeneration else { return }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        streamWatchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled, let self, generation == self.streamGeneration else { return }
                guard StateStreamLivenessPolicy.hasExpired(lastActivityAt: self.streamLastActivityAt) else {
                    continue
                }
                self.store.reportSyncError("Session state stream stopped receiving heartbeats.")
                self.restartStream(refreshSnapshotFirst: true)
                return
            }
        }
    }

    private func beginBackgroundActivityIfNeeded() {
        guard backgroundActivity == nil else { return }
        backgroundActivity = ProcessInfo.processInfo.beginActivity(
            options: [.background],
            reason: "Keep Corptie Session state and completion notifications current"
        )
    }

    private func consumeStream(generation: UInt64) async {
        do {
            var components = URLComponents(
                url: baseURL.appending(path: "state/events"),
                resolvingAgainstBaseURL: false
            )!
            components.queryItems = [URLQueryItem(name: "after", value: String(store.revision))]
            var request = URLRequest(url: components.url!)
            request.timeoutInterval = .infinity
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            try Self.requireSuccess(response)
            guard generation == streamGeneration else { return }
            store.reportStateStreamConnected()
            streamLastActivityAt = Date()
            for try await event in ServerSentEventStream.events(from: bytes) {
                guard !Task.isCancelled, generation == streamGeneration else { return }
                streamLastActivityAt = Date()
                if event.isComment { continue }
                await applyFrame(eventName: event.name, data: event.data)
            }
        } catch {
            guard !Task.isCancelled else { return }
            store.reportSyncError(Self.syncErrorMessage(error))
        }
    }

    private func applyFrame(eventName: String, data: String) async {
        guard let payload = data.data(using: .utf8), !payload.isEmpty else { return }
        do {
            switch eventName {
            case "state-snapshot":
                store.apply(snapshot: try decoder.decode(StateSnapshotEnvelope.self, from: payload))
            case "state-change-set":
                let changes = try decoder.decode(StateChangeSetEnvelope.self, from: payload)
                if case .revisionGap = store.apply(changeSet: changes) {
                    await refreshSnapshot()
                }
            default:
                break
            }
        } catch {
            store.reportSyncError(Self.syncErrorMessage(error))
            await refreshSnapshot()
        }
    }

    static func syncErrorMessage(_ error: Error) -> String {
        switch error {
        case let DecodingError.keyNotFound(key, context):
            return "状态数据缺少字段 \(codingPath(context.codingPath + [key]))：\(context.debugDescription)"
        case let DecodingError.typeMismatch(_, context):
            return "状态数据字段类型错误 \(codingPath(context.codingPath))：\(context.debugDescription)"
        case let DecodingError.valueNotFound(_, context):
            return "状态数据缺少必需值 \(codingPath(context.codingPath))：\(context.debugDescription)"
        case let DecodingError.dataCorrupted(context):
            return "状态数据格式错误 \(codingPath(context.codingPath))：\(context.debugDescription)"
        default:
            return error.localizedDescription
        }
    }

    private static func codingPath(_ path: [any CodingKey]) -> String {
        let rendered = path.map { key in
            key.intValue.map { "[\($0)]" } ?? key.stringValue
        }.joined(separator: ".")
        return rendered.isEmpty ? "<root>" : rendered.replacingOccurrences(of: ".[", with: "[")
    }

    private static func requireSuccess(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }
}
