import AuthenticationServices
import UIKit

@MainActor
final class CloudSignInSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func start(url: URL, completion: @escaping @MainActor (Result<URL, Error>) -> Void) {
        session?.cancel()
        let next = ASWebAuthenticationSession(url: url, callbackURLScheme: "corptie") { callback, error in
            Task { @MainActor [weak self] in
                self?.session = nil
                if let callback { completion(.success(callback)) }
                else { completion(.failure(error ?? CloudSignInError.missingCallback)) }
            }
        }
        next.presentationContextProvider = self
        next.prefersEphemeralWebBrowserSession = false
        session = next
        if !next.start() {
            session = nil
            completion(.failure(CloudSignInError.couldNotStart))
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
