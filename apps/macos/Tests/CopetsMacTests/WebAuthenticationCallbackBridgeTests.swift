import AuthenticationServices
import Foundation
import Testing
@testable import CorptieMac

private struct SendableWebAuthenticationCompletion: @unchecked Sendable {
    let call: ASWebAuthenticationSession.CompletionHandler
}

private enum CallbackTestError: Error, Equatable {
    case cancelled
}

@Suite("Web authentication callback bridge")
struct WebAuthenticationCallbackBridgeTests {
    @Test("background success returns to MainActor exactly once")
    @MainActor
    func backgroundSuccessIsDeliveredOnce() async throws {
        let expected = try #require(URL(string: "corptie://oauth/callback?code=first"))
        let duplicate = try #require(URL(string: "corptie://oauth/callback?code=duplicate"))
        let received = await withCheckedContinuation { continuation in
            let bridge = WebAuthenticationCallbackBridge { callbackURL, error in
                MainActor.preconditionIsolated()
                #expect(error == nil)
                continuation.resume(returning: callbackURL)
            }
            let completion = SendableWebAuthenticationCompletion(call: bridge.makeCompletionHandler())
            DispatchQueue.global(qos: .userInitiated).async {
                completion.call(expected, nil)
                completion.call(duplicate, nil)
            }
        }

        #expect(received == expected)
    }

    @Test("background cancellation returns to MainActor exactly once")
    @MainActor
    func backgroundCancellationIsDeliveredOnce() async {
        let receivedError = await withCheckedContinuation { continuation in
            let bridge = WebAuthenticationCallbackBridge { callbackURL, error in
                MainActor.preconditionIsolated()
                #expect(callbackURL == nil)
                continuation.resume(returning: error as? CallbackTestError)
            }
            let completion = SendableWebAuthenticationCompletion(call: bridge.makeCompletionHandler())
            DispatchQueue.global(qos: .userInitiated).async {
                completion.call(nil, CallbackTestError.cancelled)
                completion.call(nil, CallbackTestError.cancelled)
            }
        }

        #expect(receivedError == .cancelled)
    }

    @Test("start failure and a later system callback cannot resume twice")
    @MainActor
    func startFailureWinsOverLaterCallback() async throws {
        let lateCallback = try #require(URL(string: "corptie://oauth/callback?code=late"))
        let receivedError = await withCheckedContinuation { continuation in
            let bridge = WebAuthenticationCallbackBridge { callbackURL, error in
                MainActor.preconditionIsolated()
                #expect(callbackURL == nil)
                continuation.resume(returning: error as? CallbackTestError)
            }
            bridge.complete(callbackURL: nil, error: CallbackTestError.cancelled)
            let completion = SendableWebAuthenticationCompletion(call: bridge.makeCompletionHandler())
            DispatchQueue.global(qos: .userInitiated).async {
                completion.call(lateCallback, nil)
            }
        }

        #expect(receivedError == .cancelled)
    }
}
