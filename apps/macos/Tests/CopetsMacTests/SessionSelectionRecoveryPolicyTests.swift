import Testing
@testable import CorptieMac

struct SessionSelectionRecoveryPolicyTests {
    @Test func recordsMostRecentlyOpenedSessionWithoutDuplicates() {
        #expect(SessionSelectionRecoveryPolicy.recording(
            "session:two",
            in: ["session:one", "session:two", "session:three"]
        ) == ["session:two", "session:one", "session:three"])
    }

}
