import Testing
@testable import CorptieMac

struct SessionConnectionPresentationTests {
    @Test func providerWithoutManualConnectionIsAvailableWhenStatusIsAbsent() {
        #expect(SessionConnectionPresentation.isConnected(status: nil, usesManualConnection: false))
    }

    @Test func manualConnectionStillRequiresAnExplicitConnectedStatus() {
        #expect(!SessionConnectionPresentation.isConnected(status: nil, usesManualConnection: true))
        #expect(SessionConnectionPresentation.isConnected(status: "connected", usesManualConnection: true))
    }

    @Test func explicitDisconnectedStatusAlwaysWins() {
        #expect(!SessionConnectionPresentation.isConnected(status: "disconnected", usesManualConnection: false))
        #expect(!SessionConnectionPresentation.isConnected(status: "connecting", usesManualConnection: false))
    }
}
