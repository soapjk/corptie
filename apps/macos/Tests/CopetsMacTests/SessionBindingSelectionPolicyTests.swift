import Testing
@testable import CorptieMac

struct SessionBindingSelectionPolicyTests {
    @Test
    func readySelectionReusesCachedBindingReadiness() {
        #expect(
            !BackendClient.selectionRequiresProviderBindingVerification(
                sessionIsReady: true
            )
        )
    }

    @Test
    func notReadySelectionStillRequestsBindingRecoveryProbe() {
        #expect(
            BackendClient.selectionRequiresProviderBindingVerification(
                sessionIsReady: false
            )
        )
    }
}
