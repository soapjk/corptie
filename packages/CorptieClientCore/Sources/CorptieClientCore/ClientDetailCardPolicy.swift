import Foundation

/// Native presentation policy, shared by every Detail rail. This is not an
/// authorization decision: the host still controls data and every operation.
public struct ClientDetailContext: Equatable, Sendable {
    public let kind: ConversationInspectorKind
    public let taskID: String?
    public let workID: String?
    public init(sessionKind: String?, taskID: String?, workID: String?) {
        kind = .resolve(sessionKind: sessionKind, taskID: taskID, workID: workID)
        self.taskID = taskID; self.workID = workID
    }
}

public enum ClientDetailCardKind: String, Sendable {
    case sessionInfo, chatSummary, workOverview, taskInfo, focusTasks, provider, worktree
    case artifacts, contextReferences, memoryHits, memoryResources, schedules, turnMetrics
}

public enum ClientDetailCardPolicy {
    private static let chat: [ClientDetailCardKind] = [.sessionInfo, .chatSummary, .provider, .worktree, .contextReferences, .memoryHits, .schedules, .turnMetrics]
    private static let work: [ClientDetailCardKind] = [.sessionInfo, .workOverview, .focusTasks, .provider, .worktree, .artifacts, .contextReferences, .memoryHits, .memoryResources, .schedules, .turnMetrics]
    private static let task: [ClientDetailCardKind] = [.sessionInfo, .taskInfo, .provider, .worktree, .artifacts, .contextReferences, .memoryHits, .memoryResources, .schedules, .turnMetrics]
    private static func order(_ context: ClientDetailContext) -> [ClientDetailCardKind] {
        switch context.kind { case .chat: chat; case .work: work; case .task: task; case .legacy: [] }
    }
    public static func isVisible(_ card: ClientDetailBusinessCard, context: ClientDetailContext) -> Bool {
        guard let kind = ClientDetailCardKind(rawValue: card.kind), order(context).contains(kind) else { return false }
        if ["workOverview", "focusTasks", "artifacts"].contains(card.kind), context.workID == nil { return false }
        if card.kind == "taskInfo", context.taskID == nil { return false }
        if card.kind == "memoryResources", context.taskID == nil && context.workID == nil { return false }
        // Failure is not proof of emptiness or a missing Worktree binding.
        if card.loadState == "error" { return true }
        switch card.payload {
        case .summary(let value): return !value.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .artifacts(let value): return !value.items.isEmpty || value.hasMore
        case .focus(let value): return !value.items.isEmpty || value.hasMore
        case .references: return true // This card is also the creation entry point.
        case .memories(let value), .hits(let value): return !value.items.isEmpty || value.hasMore
        case .schedules(let value): return !value.items.isEmpty || value.hasMore
        case .worktree(let value): return value.attached
        case .turn(let value): return value.turnId != nil
        case .unsupported: return false
        default: return true
        }
    }
    @MainActor public static func orderedCards(in store: ClientDetailBusinessStore, context: ClientDetailContext) -> [ClientDetailBusinessCardState] {
        let cards = store.orderedCards
        // Bounded native directory, no payload copying or dynamic layout.
        return order(context).flatMap { kind in cards.filter { $0.card.kind == kind.rawValue && isVisible($0.card, context: context) } }
    }
}
