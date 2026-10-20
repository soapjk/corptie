import Foundation
import Observation

/// Retained display data only. All Git actions still obtain a fresh server plan.
@MainActor @Observable public final class ClientDetailWorktreeState {
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
