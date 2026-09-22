import XCTest
import CorptieConversation
@testable import CorptieMac

/// `ThreadMetaView` semantics shared with the iPad: quota window choice, colour
/// bands and not-ready wording must keep producing the desktop values.
final class SessionMetaPolicyTests: XCTestCase {
    func testDesktopUsagePresentationDelegatesToSharedPolicy() {
        let window = CodexRateLimitWindow(usedPercent: 12.345, windowDurationMins: 10_080, resetsAt: nil)
        XCTAssertEqual(SessionUsagePresentation.remainingRateLimitPercent(window), 87.655)
        XCTAssertEqual(SessionUsagePolicy.remainingRateLimitPercent(.init(usedPercent: 125, windowDurationMins: nil, resetsAt: nil)), 0)
        XCTAssertNil(SessionUsagePolicy.remainingRateLimitPercent(.init(usedPercent: .nan, windowDurationMins: nil, resetsAt: nil)))
        XCTAssertNil(SessionUsagePolicy.remainingRateLimitPercent(.init(usedPercent: -0.1, windowDurationMins: nil, resetsAt: nil)))
    }

    func testCodexPrefersModelScopedBucketThenDefaultBucket() {
        let canonical = SessionUsagePolicy.Snapshot(limitName: nil,
            primary: .init(usedPercent: 16, windowDurationMins: 10_080, resetsAt: 100), secondary: nil)
        let spark = SessionUsagePolicy.Snapshot(limitName: "gpt-5.3-codex-spark",
            primary: .init(usedPercent: 9, windowDurationMins: 10_080, resetsAt: 100), secondary: nil)
        let scoped = SessionUsagePolicy.Account(provider: "codex", model: "gpt-5.3-codex-spark",
            rateLimits: canonical, rateLimitsByLimitId: ["codex": canonical, "codex_spark": spark])
        XCTAssertEqual(SessionUsagePolicy.preferredRateLimitWindow(scoped)?.usedPercent, 9)
        let unscoped = SessionUsagePolicy.Account(provider: "codex", model: "o3-mini",
            rateLimits: canonical, rateLimitsByLimitId: ["codex": canonical, "codex_spark": spark])
        XCTAssertEqual(SessionUsagePolicy.preferredRateLimitWindow(unscoped)?.usedPercent, 16)
        let longest = SessionUsagePolicy.Account(provider: "claude", model: nil,
            rateLimits: .init(limitName: nil,
                primary: .init(usedPercent: 40, windowDurationMins: 300, resetsAt: 50),
                secondary: .init(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 200)),
            rateLimitsByLimitId: nil)
        XCTAssertEqual(SessionUsagePolicy.preferredRateLimitWindow(longest)?.windowDurationMins, 10_080)
        XCTAssertNil(SessionUsagePolicy.preferredRateLimitWindow(.init(provider: "codex", model: nil, rateLimits: nil, rateLimitsByLimitId: nil)))
    }

    func testUsageColourBandsAndContextMathMatchDesktop() {
        XCTAssertEqual(SessionUsagePolicy.contextTone(usedPercent: 50), .normal)
        XCTAssertEqual(SessionUsagePolicy.contextTone(usedPercent: 50.5), .warning)
        XCTAssertEqual(SessionUsagePolicy.contextTone(usedPercent: 71), .critical)
        XCTAssertEqual(SessionUsagePolicy.quotaTone(remainingPercent: 50), .warning)
        XCTAssertEqual(SessionUsagePolicy.quotaTone(remainingPercent: 51), .normal)
        XCTAssertEqual(SessionUsagePolicy.quotaTone(remainingPercent: 29.9), .critical)
        XCTAssertEqual(SessionUsagePolicy.contextUsed(usedTokens: nil, contextWindow: 200_000, remainingTokens: 150_000), 50_000)
        XCTAssertEqual(SessionUsagePolicy.contextUsed(usedTokens: 12, contextWindow: 200_000, remainingTokens: 150_000), 12)
        XCTAssertEqual(SessionUsagePolicy.contextUsedPercent(reported: nil, used: 50_000, contextWindow: 200_000), 25)
        XCTAssertEqual(SessionUsagePolicy.contextUsedPercent(reported: 130, used: 0, contextWindow: 1), 100)
        XCTAssertEqual(SessionUsagePolicy.exactTokens(1234567), "1,234,567")
        XCTAssertEqual(SessionUsagePolicy.percent(87.655), "87.7")
        XCTAssertEqual(SessionUsagePolicy.percent(87.655, maximumFractionDigits: 2), "87.66")
        XCTAssertEqual(SessionUsagePolicy.quotaLabel(provider: "claude"), "Claude quota")
        XCTAssertEqual(SessionUsagePolicy.quotaLabel(provider: nil), "Codex quota")
    }

    func testNotReadyWordingIsKeyedByHostCode() {
        XCTAssertEqual(SessionReadinessPresentation.title(code: "PROVIDER_INITIALIZING"), "Starting Provider Runtime")
        XCTAssertEqual(SessionReadinessPresentation.title(code: "PROVIDER_BINDING_RECOVERY_REQUIRED"), "Session Recovery Required")
        XCTAssertEqual(SessionReadinessPresentation.title(code: "SOMETHING_ELSE"), "Session Not Ready")
        XCTAssertEqual(SessionReadinessPresentation.title(code: nil), "Session Not Ready")
        XCTAssertEqual(SessionReadinessPresentation.message(code: "UNKNOWN", fallback: "host text"), "host text")
        XCTAssertEqual(SessionReadinessPresentation.message(code: "UNKNOWN", fallback: ""), "This Session cannot accept messages right now.")
        XCTAssertTrue(SessionReadinessPresentation.message(code: "PROVIDER_SESSION_UNAVAILABLE", fallback: nil).hasPrefix("The Provider Session no longer exists"))
    }

    @MainActor func testDesktopReasonPresentationStillResolvesThroughLocalization() {
        let reason = SessionNotReadyReason(code: "BINDING_RUNTIME_VERIFYING", message: "raw", retryable: true)
        XCTAssertEqual(reason.presentationTitle, L10n("Reconnecting Existing Session"))
        XCTAssertEqual(reason.presentationMessage,
                       L10n("Corptie is reconnecting the existing Provider Thread. No new Thread or context rebuild is being created."))
        let unknown = SessionNotReadyReason(code: "X", message: "raw", retryable: nil)
        XCTAssertEqual(unknown.presentationTitle, L10n("Session Not Ready"))
        XCTAssertEqual(unknown.presentationMessage, "raw")
    }
}
