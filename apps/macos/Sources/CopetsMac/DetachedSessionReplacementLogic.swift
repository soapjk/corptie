import Foundation

enum DetachedSessionReplacementLogic {
    static func shouldRebind(
        previousSessionId: String,
        replacementSessionId: String,
        floatingSessionIds: Set<String>
    ) -> Bool {
        previousSessionId != replacementSessionId
            && floatingSessionIds.contains(previousSessionId)
    }
}
