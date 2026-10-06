import AuthenticationServices
import UIKit
import OSLog

@MainActor
final class CloudSignInSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var requestID: UUID?
    private weak var window: UIWindow?
    private static let log = Logger(subsystem: "com.corptie.mobile", category: "CloudSignIn")

    func start(url: URL, completion: @escaping @MainActor (Result<URL, Error>) -> Void) {
        session?.cancel()
        guard let anchor = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .filter({ $0.activationState == .foregroundActive })
            .flatMap(\.windows).first(where: \.isKeyWindow) else {
            Self.log.error("Cloud login presentation: result=no-active-window")
            completion(.failure(CloudSignInError.noActiveWindow))
            return
        }
        window = anchor
        let requestID = UUID()
        self.requestID = requestID
        let bridge = CloudSignInCallbackBridge { [weak self] callback, error in
            guard self?.requestID == requestID else { return }
            self?.requestID = nil
            self?.session = nil
            self?.window = nil
            Self.log.info("Cloud login completion: callbackReceived=\(callback != nil) errorPresent=\(error != nil)")
            if let callback { completion(.success(callback)) }
            else { completion(.failure(error ?? CloudSignInError.missingCallback)) }
        }
        let next = ASWebAuthenticationSession(
            url: url, callbackURLScheme: "corptie", completionHandler: bridge.makeCompletionHandler()
        )
        next.presentationContextProvider = self
        next.prefersEphemeralWebBrowserSession = false
        session = next
        Self.log.info("Cloud login presentation: result=starting")
        if !next.start() {
            bridge.complete(callback: nil, error: CloudSignInError.couldNotStart)
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        window ?? UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

private enum CloudSignInError: Error { case missingCallback, couldNotStart, noActiveWindow }
