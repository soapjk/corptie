import Testing
@testable import CorptieConversation

@Suite("Shared composer input height")
struct ComposerShellMetricsTests {
    @Test("An empty or single-line input uses one row")
    func singleLineMinimum() {
        #expect(ComposerShellMetrics.minimumInputHeight == 30)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 0) == 30)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 28) == 30)
    }

    @Test("Wrapped content grows without exceeding the shared cap")
    func growsWithContent() {
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 30.2) == 31)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 63.2) == 64)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 140) == 96)
    }
}
