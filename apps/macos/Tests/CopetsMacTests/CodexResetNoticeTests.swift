import Foundation
import Testing
@testable import CorptieMac

struct CodexResetNoticeTests {
    @Test
    func firstManualTapPresentsANoticeThatIsNotAlreadyRequested() {
        #expect(CodexResetNoticePresentation.manualAction(isPresented: false) == .present)
    }

    @Test
    func manualTapRearmsAStalePresentedBinding() {
        #expect(CodexResetNoticePresentation.manualAction(isPresented: true) == .rearm)
    }

    @Test
    func acknowledgedFingerprintCannotBePresentedByADelayedTask() {
        #expect(!CodexResetNoticePresentation.shouldPresent(
            fingerprint: "same-notice",
            acknowledgedFingerprint: "same-notice"
        ))
    }

    @Test
    func changedFingerprintCanPresentANewNotice() {
        #expect(CodexResetNoticePresentation.shouldPresent(
            fingerprint: "new-notice",
            acknowledgedFingerprint: "old-notice"
        ))
    }

    @Test
    func closingAnAutomaticNoticeDoesNotImmediatelyPresentItAgain() {
        #expect(!CodexResetNoticePresentation.shouldAutomaticallyPresent(
            fingerprint: "same-notice",
            lastAutomaticallyPresentedFingerprint: "same-notice",
            acknowledgedFingerprints: []
        ))
    }

    @Test
    func aNewNoticeMayAutomaticallyPresentOnce() {
        #expect(CodexResetNoticePresentation.shouldAutomaticallyPresent(
            fingerprint: "new-notice",
            lastAutomaticallyPresentedFingerprint: "old-notice",
            acknowledgedFingerprints: []
        ))
    }

    @Test
    func planQuotaUsesTheLongestAvailableRateLimitWindow() {
        let account = CodexAccountUsage(
            available: true,
            provider: "codex",
            model: nil,
            rateLimits: CodexRateLimitSnapshot(
                limitId: "codex",
                limitName: nil,
                primary: CodexRateLimitWindow(usedPercent: 50, windowDurationMins: 300, resetsAt: 100),
                secondary: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 200)
            ),
            rateLimitsByLimitId: nil
        )
        #expect(SessionUsagePresentation.preferredRateLimitWindow(account)?.windowDurationMins == 10_080)
    }

    @Test
    func planQuotaCanUseASecondaryOnlyWindow() {
        let account = CodexAccountUsage(
            available: true,
            provider: "codex",
            model: nil,
            rateLimits: CodexRateLimitSnapshot(
                limitId: "codex",
                limitName: nil,
                primary: nil,
                secondary: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 200)
            ),
            rateLimitsByLimitId: nil
        )
        #expect(SessionUsagePresentation.preferredRateLimitWindow(account)?.resetsAt == 200)
    }

    @Test
    func fingerprintChangesWhenTheOfficialResetChanges() {
        let first = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 100),
            forecast: nil
        )
        let second = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 200),
            forecast: nil
        )
        #expect(first != second)
    }

    @Test
    func fingerprintIgnoresChangingQuotaPercentage() {
        let first = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 100),
            forecast: nil
        )
        let second = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 90, windowDurationMins: 10_080, resetsAt: 100),
            forecast: nil
        )
        #expect(first == second)
    }

    @Test
    func fingerprintChangesWhenTiboForecastChanges() {
        let window = CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 100)
        let first = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: window,
            forecast: CodexResetForecast(
                postId: "one",
                text: "will reset",
                url: nil,
                publishedAt: "2026-08-11T00:00:00Z",
                estimateLabel: "预计未来几小时内",
                expiresAt: "2026-08-11T08:00:00Z"
            )
        )
        let second = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: window,
            forecast: CodexResetForecast(
                postId: "two",
                text: "will reset soon",
                url: nil,
                publishedAt: "2026-08-11T01:00:00Z",
                estimateLabel: "预计未来1小时内",
                expiresAt: "2026-08-11T04:00:00Z"
            )
        )
        #expect(first != second)
    }

    @Test
    func resetTimeDriftWithinFiveMinutesDoesNotCreateANewNotice() {
        let acknowledged = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 100_000),
            forecast: nil
        )!
        let current = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 25, windowDurationMins: 10_080, resetsAt: 100_299),
            forecast: nil
        )!
        #expect(!CodexResetNoticePresentation.shouldPresent(
            fingerprint: current,
            acknowledgedFingerprints: [acknowledged]
        ))
    }

    @Test
    func meaningfulResetTimeChangeCreatesANewNotice() {
        let acknowledged = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 100_000),
            forecast: nil
        )!
        let current = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 100_600),
            forecast: nil
        )!
        #expect(CodexResetNoticePresentation.shouldPresent(
            fingerprint: current,
            acknowledgedFingerprints: [acknowledged]
        ))
    }

    @Test
    func forecastExpiryDoesNotCreateANewActiveNotice() {
        let window = CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 100_000)
        let acknowledged = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: window,
            forecast: forecast(postId: "one", text: "Codex limits will reset tomorrow")
        )!
        let current = CodexResetNoticeIdentity.fingerprint(provider: "codex", window: window, forecast: nil)!
        #expect(!CodexResetNoticePresentation.shouldPresent(
            fingerprint: current,
            acknowledgedFingerprints: [acknowledged]
        ))
    }

    @Test
    func aChangedForecastPostCreatesANewNotice() {
        let window = CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 100_000)
        let acknowledged = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: window,
            forecast: forecast(postId: "one", text: "Codex limits will reset tomorrow")
        )!
        let current = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: window,
            forecast: forecast(postId: "two", text: "Codex limits will reset tonight")
        )!
        #expect(CodexResetNoticePresentation.shouldPresent(
            fingerprint: current,
            acknowledgedFingerprints: [acknowledged]
        ))
    }

    @Test
    func anAcknowledgedSnapshotRemainsReadAfterABAToggling() {
        let a = "v=2|resetMinute=100|duration=10080|post=one|content=a"
        let b = "v=2|resetMinute=200|duration=10080|post=two|content=b"
        let encoded = CodexResetNoticeAcknowledgements.adding(
            a,
            to: CodexResetNoticeAcknowledgements.adding(b, to: "")
        )
        let acknowledgements = CodexResetNoticeAcknowledgements.decoded(encoded)
        #expect(acknowledgements.count == 2)
        #expect(!CodexResetNoticePresentation.shouldPresent(
            fingerprint: a,
            acknowledgedFingerprints: acknowledgements
        ))
    }

    @Test
    func legacyAcknowledgementMigratesWithoutPresentingAgain() {
        let legacy = "reset=100000|duration=10080|post=one|estimate=soon|expires=tomorrow"
        let current = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: 100_000),
            forecast: forecast(postId: "one", text: "Codex limits will reset tomorrow")
        )!
        #expect(!CodexResetNoticePresentation.shouldPresent(
            fingerprint: current,
            acknowledgedFingerprints: CodexResetNoticeAcknowledgements.decoded("", legacy: legacy)
        ))
    }

    @Test @MainActor
    func acknowledgementIsImmediatelyVisibleThroughTheSharedDefaultsSource() {
        let suite = "CodexResetNoticeTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let fingerprint = "v=2|resetMinute=100|duration=10080|post=one|content=a"
        CodexResetNoticeAcknowledgements.record(fingerprint, in: defaults)
        #expect(CodexResetNoticeAcknowledgements.load(from: defaults) == [fingerprint])
        #expect(!CodexResetNoticePresentation.shouldPresent(
            fingerprint: fingerprint,
            acknowledgedFingerprints: CodexResetNoticeAcknowledgements.load(from: defaults)
        ))
    }

    @Test
    func ClaudeDoesNotCreateACodexResetNotice() {
        #expect(CodexResetNoticeIdentity.fingerprint(
            provider: "claude",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 300, resetsAt: 100),
            forecast: nil
        ) == nil)
    }

    private func forecast(postId: String, text: String) -> CodexResetForecast {
        CodexResetForecast(
            postId: postId,
            text: text,
            url: nil,
            publishedAt: "2026-08-11T00:00:00Z",
            estimateLabel: "预计明天",
            expiresAt: "2026-08-13T00:00:00Z"
        )
    }
}
