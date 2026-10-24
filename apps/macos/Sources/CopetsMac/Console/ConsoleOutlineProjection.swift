import Combine
import CorptieConversation

struct ConsoleOutlineProjectionKey: Equatable {
    let entityRevision: UInt64
    let sessionRevision: UInt64
    let search: String
    let sort: WorkOutlineSort
}

struct ConsoleOutlineProjection {
    let tasksByWorkID: [String: [CorptieTask]]
    let works: [Work]
    let processingWorkIDs: Set<String>
}

/// Selection and viewport changes never invalidate this bounded projection.
@MainActor
final class ConsoleOutlineProjectionStore: ObservableObject {
    private var key: ConsoleOutlineProjectionKey?
    private var cached: ConsoleOutlineProjection?
    private(set) var computationCount = 0

    func value(for key: ConsoleOutlineProjectionKey, make: () -> ConsoleOutlineProjection) -> ConsoleOutlineProjection {
        if self.key == key, let cached { return cached }
        let result = make()
        self.key = key
        cached = result
        computationCount += 1
        return result
    }
}
