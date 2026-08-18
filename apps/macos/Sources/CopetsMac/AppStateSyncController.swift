import Foundation

@MainActor
final class AppStateSyncController {
    static let shared = AppStateSyncController()

    private let store = AppStateStore.shared
    private let baseURL = CorptieAppEnvironment.backendBaseURL
    private var streamTask: Task<Void, Never>?
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    private init() {}

    func start() {
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            guard let self else { return }
            await refreshSnapshot()
            while !Task.isCancelled {
                await consumeStream()
                guard !Task.isCancelled else { return }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    func refreshSnapshot() async {
        do {
            let (data, response) = try await URLSession.shared.data(
                from: baseURL.appending(path: "state/snapshot")
            )
            try Self.requireSuccess(response)
            let snapshot = try decoder.decode(StateSnapshotEnvelope.self, from: data)
            store.apply(snapshot: snapshot)
        } catch {
            store.reportSyncError(Self.syncErrorMessage(error))
        }
    }

    func hydrateSession(_ id: String) async -> TaskSession? {
        if let session = store.session(id) { return session }
        await refreshSnapshot()
        return store.session(id)
    }

    private func consumeStream() async {
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
            var eventName = ""
            var dataLines: [String] = []
            for try await line in bytes.lines {
                guard !Task.isCancelled else { return }
                if line.isEmpty {
                    await applyFrame(eventName: eventName, data: dataLines.joined(separator: "\n"))
                    eventName = ""
                    dataLines.removeAll(keepingCapacity: true)
                } else if line.hasPrefix("event:") {
                    eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                } else if line.hasPrefix("data:") {
                    dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                }
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
