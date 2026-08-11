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
    func ClaudeDoesNotCreateACodexResetNotice() {
        #expect(CodexResetNoticeIdentity.fingerprint(
            provider: "claude",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 300, resetsAt: 100),
            forecast: nil
        ) == nil)
    }
}
