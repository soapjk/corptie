import AuthenticationServices
import UIKit

@MainActor
final class CloudSignInSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var requestID: UUID?

    func start(url: URL, completion: @escaping @MainActor (Result<URL, Error>) -> Void) {
        session?.cancel()
        let requestID = UUID()
        self.requestID = requestID
        let bridge = CloudSignInCallbackBridge { [weak self] callback, error in
            guard self?.requestID == requestID else { return }
            self?.requestID = nil
            self?.session = nil
            if let callback { completion(.success(callback)) }
            else { completion(.failure(error ?? CloudSignInError.missingCallback)) }
        }
        let next = ASWebAuthenticationSession(
            url: url, callbackURLScheme: "corptie", completionHandler: bridge.makeCompletionHandler()
        )
        next.presentationContextProvider = self
        next.prefersEphemeralWebBrowserSession = false
        session = next
        if !next.start() {
            bridge.complete(callback: nil, error: CloudSignInError.couldNotStart)
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

private enum CloudSignInError: Error { case missingCallback, couldNotStart }
