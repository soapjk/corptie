import Testing
@testable import CorptieMac

@MainActor
struct MarkdownRenderCacheTests {
    @Test
    func parsedMarkdownIsReusedAcrossMessageReconstruction() {
        let cache = MarkdownRenderCache.shared
        cache.removeAllForTesting()
        let before = ChatPerformanceRecorder.shared.snapshot()[.markdownPreprocesses]

        let first = cache.content(
            text: "See **result** at ./notes.md",
            baseDirectory: "/tmp/workspace"
        )
        let second = cache.content(
            text: "See **result** at ./notes.md",
            baseDirectory: "/tmp/workspace"
        )
        let after = ChatPerformanceRecorder.shared.snapshot()[.markdownPreprocesses]

        #expect(first == second)
        #expect(after - before == 1)
        #expect(cache.contains(
            text: "See **result** at ./notes.md",
            baseDirectory: " /tmp/workspace "
        ))
    }
}
