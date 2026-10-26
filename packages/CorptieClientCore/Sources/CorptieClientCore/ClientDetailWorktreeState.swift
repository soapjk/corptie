import Foundation
import Observation

/// Retained display data only. All Git actions still obtain a fresh server plan.
@MainActor @Observable public final class ClientDetailWorktreeState {
    public struct PresentationSnapshot: Equatable, Sendable {
        public let detail: ClientSessionWorktreeDetail?
        public let job: ClientWorktreeJob?
        public let loading: Bool
        public let mutating: Bool
        public let error: String?
        public let lastRead: Date?
        public let refreshID: String?
        public let bindingID: String?
        public let generation: UUID
    }
    public var detail: ClientSessionWorktreeDetail? { didSet { contentChanged?() } }
    public var job: ClientWorktreeJob? { didSet { contentChanged?() } }
    @ObservationIgnored var contentChanged: (() -> Void)?
    public var loading = false
    public var mutating = false
    public var error: String?
    public var lastRead: Date?
    public var refreshID: String?
    public private(set) var bindingID: String?
    public private(set) var generation = UUID()
    public init() {}
    public func makePresentationSnapshot() -> PresentationSnapshot {
        .init(detail: detail, job: job, loading: loading, mutating: mutating,
              error: error, lastRead: lastRead, refreshID: refreshID, bindingID: bindingID, generation: generation)
    }
    public func applyPresentationSnapshot(_ value: PresentationSnapshot) {
        if detail != value.detail { detail = value.detail }
        if job != value.job { job = value.job }
        if loading != value.loading { loading = value.loading }
        if mutating != value.mutating { mutating = value.mutating }
        if error != value.error { error = value.error }
        if lastRead != value.lastRead { lastRead = value.lastRead }
        if refreshID != value.refreshID { refreshID = value.refreshID }
        if bindingID != value.bindingID { bindingID = value.bindingID }
        if generation != value.generation { generation = value.generation }
    }
    public var estimatedRetainedBytes: Int {
        let tree = detail?.worktree
        return 16384 + (tree?.path.utf8.count ?? 0) * 2
            + (tree?.changedFiles.reduce(0) { $0 + $1.utf8.count * 2 + 128 } ?? 0)
            + (tree?.conflictFiles.reduce(0) { $0 + $1.utf8.count * 2 + 128 } ?? 0)
            + (job?.plan.items.count ?? 0) * 4096
    }
    public func bind(_ id: String) {
        guard bindingID != id else { return }
        retire(); bindingID = id
    }
    public func retire() {
        guard bindingID != nil || detail != nil || job != nil || loading || mutating || error != nil || refreshID != nil else { return }
        generation = UUID(); detail = nil; job = nil; lastRead = nil; refreshID = nil; bindingID = nil
        loading = false; mutating = false; error = nil
    }
}
