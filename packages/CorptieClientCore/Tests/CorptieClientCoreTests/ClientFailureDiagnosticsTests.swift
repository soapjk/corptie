import Foundation
import Testing
@testable import CorptieClientCore

struct ClientFailureDiagnosticsTests {
    @Test func preservesSystemCauseCodesWithoutDescriptionsOrPayloads() {
        let underlying = NSError(domain: NSPOSIXErrorDomain, code: 61,
                                 userInfo: [NSLocalizedDescriptionKey: "private-password-canary"])
        let failure = NSError(domain: NSURLErrorDomain, code: -1004,
                              userInfo: [NSUnderlyingErrorKey: underlying, "body": "private-payload-canary"])
        let summary = ClientFailureDiagnostics.summary(failure)
        #expect(summary.contains("-1004"))
        #expect(summary.contains("61"))
        #expect(!summary.contains("canary"))
    }

    @Test func preservesServiceStatusAndCodeWithoutMessage() {
        let failure = ClientServiceFailure(statusCode: 503, code: "BACKEND_UNAVAILABLE", message: "private-message-canary")
        let summary = ClientFailureDiagnostics.summary(failure)
        #expect(summary.contains("503"))
        #expect(summary.contains("BACKEND_UNAVAILABLE"))
        #expect(!summary.contains("canary"))
    }
}
