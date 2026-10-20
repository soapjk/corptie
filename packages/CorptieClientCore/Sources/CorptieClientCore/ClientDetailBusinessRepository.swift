import Foundation
import Observation

/// Direct equality over public identity and owner lifetime, not a digest of a
/// token/private key. A token refresh does not change this display identity.
public struct ClientDetailBusinessScope: Equatable, Sendable {
    public let serverID: String
    public let ownerID: String
    public let principalID: String
    public let sessionID: String
    public let taskID: String?
    public let workID: String?
    public init(serverID: String, ownerID: String, principalID: String, sessionID: String, taskID: String?, workID: String?) {
        self.serverID = serverID; self.ownerID = ownerID; self.principalID = principalID
        self.sessionID = sessionID; self.taskID = taskID; self.workID = workID
    }
}

@MainActor @Observable public final class ClientDetailBusinessHandle {
    public let store = ClientDetailBusinessStore()
    public let turn = ClientDetailTurnState()
    public let worktree = ClientDetailWorktreeState()
    public let scope: ClientDetailBusinessScope
    public private(set) var retired = false
    public fileprivate(set) var legacy = false
    @ObservationIgnored fileprivate var consumers: [(UUID, AsyncStream<Void>.Continuation)] = []
    @ObservationIgnored fileprivate var producer: Task<Void, Never>?
    @ObservationIgnored fileprivate var producerID: UUID?
    @ObservationIgnored fileprivate var lastUsed: UInt64 = 0
    fileprivate init(_ scope: ClientDetailBusinessScope) { self.scope = scope }
    fileprivate func notify() { for (_, listener) in consumers { listener.yield(()) } }
    fileprivate func retire() {
        retired = true; producer?.cancel(); producer = nil; producerID = nil
        store.contentChanged = nil; store.canRetainPage = nil
        turn.contentChanged = nil; worktree.contentChanged = nil
        store.fail("访问或绑定已失效", disposition: .accessRevoked)
        turn.retire()
        worktree.retire()
        for (_, listener) in consumers { listener.finish() }; consumers = []
    }
}

@MainActor public final class ClientDetailBusinessRepository {
    public struct Lease {
        fileprivate let id: UUID
        public let updates: AsyncStream<Void>
    }
    private var entries: [ClientDetailBusinessHandle] = []
    private var clock: UInt64 = 0
    private let feed = ClientDetailBusinessFeedPool()
    private let byteLimit = 32 * 1024 * 1024
    public init() {}

    public func entry(for scope: ClientDetailBusinessScope) -> ClientDetailBusinessHandle {
        clock &+= 1
        if let entry = entries.first(where: { !$0.retired && $0.scope == scope }) {
            entry.lastUsed = clock; return entry
        }
        // A changed Task/Work binding retires, rather than aliases, old data.
        for old in entries where old.scope.serverID == scope.serverID && old.scope.ownerID == scope.ownerID
            && old.scope.sessionID == scope.sessionID && old.scope != scope { old.retire() }
        entries.removeAll { $0.retired }
        let entry = ClientDetailBusinessHandle(scope); entry.lastUsed = clock; entries.append(entry)
        entry.store.contentChanged = { [weak self] in self?.trim() }
        entry.turn.contentChanged = { [weak self] in self?.trim() }
        entry.worktree.contentChanged = { [weak self] in self?.trim() }
        entry.store.canRetainPage = { [weak self] in
            guard let self else { return false }
            return self.entries.reduce(0) { $0 + $1.store.estimatedRetainedBytes + $1.turn.estimatedRetainedBytes + $1.worktree.estimatedRetainedBytes } + ClientDetailProtocol.maxDocumentBytes <= self.byteLimit
        }
        trim(); return entry
    }
    public func acquire(_ handle: ClientDetailBusinessHandle, api: @escaping @Sendable () async throws -> ClientDetailAPI) -> Lease {
        let pair = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1)), id = UUID()
        guard !handle.retired, handle.consumers.count < 8 else { pair.continuation.finish(); return Lease(id: id, updates: pair.stream) }
        pair.continuation.onTermination = { @Sendable [weak self, weak handle] _ in
            Task { @MainActor in if let handle { self?.releaseID(id, handle) } }
        }
        handle.consumers.append((id, pair.continuation)); pair.continuation.yield(())
        startProducer(handle, api: api)
        return Lease(id: id, updates: pair.stream)
    }
    /// A manual refresh may repair the baseline after a terminal feed failure.
    /// Existing window leases stay attached; no duplicate live feed is created.
    public func resumeIfNeeded(_ handle: ClientDetailBusinessHandle, api: @escaping @Sendable () async throws -> ClientDetailAPI) {
        startProducer(handle, api: api, markRefreshing: false)
    }
    private func startProducer(_ handle: ClientDetailBusinessHandle, api: @escaping @Sendable () async throws -> ClientDetailAPI,
                               markRefreshing: Bool = true) {
        guard !handle.retired, !handle.legacy, !handle.consumers.isEmpty else { return }
        if handle.producer == nil {
            if markRefreshing { handle.store.markRefreshing() }
            let producerID = UUID(); handle.producerID = producerID
            handle.producer = Task { [weak self, weak handle] in
                guard let self, let handle else { return }
                defer {
                    if handle.producerID == producerID { handle.producer = nil; handle.producerID = nil }
                }
                guard !Task.isCancelled, handle.producerID == producerID else { return }
                let stream = await feed.subscribe(scope: handle.scope, api: api)
                for await event in stream {
                    guard !Task.isCancelled, !handle.retired, handle.producerID == producerID else { break }
                    switch event {
                    case .snapshot(let document):
                        do {
                            let previousGeneration = handle.store.generation
                            try handle.store.receive(document)
                            if let previousGeneration, previousGeneration != document.generation {
                                handle.turn.retire(); handle.worktree.retire()
                            }
                            let hasTurn = document.cards.contains { card in
                                if case .turn(let value) = card.payload { return card.loadState != "error" && value.turnId != nil }
                                return false
                            }
                            if !hasTurn { handle.turn.retire() }
                            let worktree = document.cards.first { $0.kind == "worktree" }
                            if worktree == nil { handle.worktree.retire() }
                            else if let card = worktree, case .worktree(let value) = card.payload,
                                    !value.attached || value.worktreeId == nil { handle.worktree.retire() }
                        }
                        catch {
                            handle.store.fail("详情数据不合法，请重试；已保留上次内容", disposition: .temporary)
                            handle.notify(); return
                        }
                    case .failure(let status, let code):
                        if [401, 403, 404].contains(status) { handle.retire(); break }
                        let retired = ["DETAIL_BINDING_CHANGED", "DETAIL_SCOPE_RETIRED"].contains(code)
                        let terminal = ClientDetailBusinessFailurePolicy.requiresManualRetry(code)
                        let message = terminal ? "详情加载失败，请重试；已有内容已保留" : "详情更新失败，正在重试；已有内容已保留"
                        handle.store.fail(message, disposition: retired ? .bindingRetired : .temporary)
                    case .unsupported: handle.legacy = true
                    }
                    handle.notify(); trim()
                }
            }
        }
    }
    public func release(_ lease: Lease, from handle: ClientDetailBusinessHandle) { releaseID(lease.id, handle) }
    private func releaseID(_ id: UUID, _ handle: ClientDetailBusinessHandle) {
        let removed = handle.consumers.filter { $0.0 == id }
        handle.consumers.removeAll { $0.0 == id }
        for (_, listener) in removed { listener.finish() }
        if handle.consumers.isEmpty {
            handle.producer?.cancel(); handle.producer = nil; handle.producerID = nil
            handle.store.markRefreshing(); trim()
        }
    }
    public func invalidateAll() {
        let old = entries; entries = []
        for entry in old { entry.retire() }
    }
    private func trim() {
        while entries.count > 32 || entries.reduce(0, { $0 + $1.store.estimatedRetainedBytes + $1.turn.estimatedRetainedBytes + $1.worktree.estimatedRetainedBytes }) > byteLimit {
            guard let oldest = entries.filter({ $0.consumers.isEmpty }).min(by: { $0.lastUsed < $1.lastUsed }) else { return }
            entries.removeAll { $0 === oldest }; oldest.retire()
        }
    }
}
