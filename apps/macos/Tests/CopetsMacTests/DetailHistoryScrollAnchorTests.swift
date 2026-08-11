import Testing
@testable import CorptieMac

struct DetailHistoryScrollAnchorTests {
    @Test
    func preservesTheOldestPreviouslyRenderedEntry() {
        let anchor = DetailHistoryScrollAnchor.resolve(
            orderedEntryIds: ["oldest-rendered", "newer", "latest"]
        )

        #expect(anchor?.entryId == "oldest-rendered")
    }

    @Test
    func emptyHistoryHasNoRestorationAnchor() {
        #expect(DetailHistoryScrollAnchor.resolve(orderedEntryIds: []) == nil)
    }
}
