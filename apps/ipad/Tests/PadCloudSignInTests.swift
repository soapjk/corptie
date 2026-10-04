import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@MainActor
struct PadCloudSignInTests {
    @Test func authenticationCallbackFromBackgroundQueueReturnsToMainActorOnce() async throws {
        let expected = URL(string: "corptie://oauth/callback?code=fixture")!
        var deliveries: [URL?] = []
        let bridge = CloudSignInCallbackBridge { callback, _ in
            deliveries.append(callback)
        }
        let callback = bridge.makeCompletionHandler()
        await Task.detached {
            callback(expected, nil)
            callback(nil, CloudOAuthError.invalidCallback)
        }.value
        for _ in 0..<100 where deliveries.isEmpty {
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(deliveries == [expected])
    }

    @Test func authenticationFailureFromBackgroundQueueReturnsOnce() async throws {
        var errors: [CloudOAuthError?] = []
        let bridge = CloudSignInCallbackBridge { _, error in
            errors.append(error as? CloudOAuthError)
        }
        let callback = bridge.makeCompletionHandler()
        await Task.detached {
            callback(nil, CloudOAuthError.authorizationDenied("access_denied"))
            callback(URL(string: "corptie://oauth/callback?code=late"), nil)
        }.value
        for _ in 0..<100 where errors.isEmpty {
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(errors == [.authorizationDenied("access_denied")])
    }

    @Test func cloudLoginErrorsAreDistinguishableFromMacConnectionErrors() {
        #expect(PadConnection.explainCloudSignIn(CloudOAuthError.stateMismatch).contains("登录状态"))
        #expect(PadConnection.explainCloudSignIn(ClientConnectionError.httpStatus(401)).contains("授权"))
        #expect(PadConnection.explainCloudSignIn(ClientConnectionError.httpStatus(503)).contains("503"))
    }
}
