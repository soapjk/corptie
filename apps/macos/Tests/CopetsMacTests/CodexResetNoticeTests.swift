import Foundation
import Testing
@testable import CorptieMac

struct CodexResetNoticeTests {
    @Test
    func acknowledgedFingerprintCannotSendASystemNotification() {
        #expect(!CodexResetNotificationPolicy.shouldNotify(
            fingerprint: "same-notice",
            acknowledgedFingerprint: "same-notice"
        ))
    }

    @Test
    func changedFingerprintCanPresentANewNotice() {
        #expect(CodexResetNotificationPolicy.shouldNotify(
            fingerprint: "new-notice",
            acknowledgedFingerprint: "old-notice"
        ))
    }

    @Test
    func chatUsageBarOffersAManualResetPopoverWithoutAutomaticPresentation() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/FloatingRootView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)
        #expect(contents.contains("resetNoticePopover"))
        #expect(contents.contains("isResetNoticePresented.toggle()"))
        #expect(contents.contains(".popover(isPresented: $isResetNoticePresented"))
        #expect(!contents.contains("scheduleResetNoticeIfNeeded"))
        #expect(!contents.contains("automaticPresentationDelay"))
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
    func resetTimeDriftWithinTheSameDayDoesNotCreateANewNotice() {
        let acknowledged = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: resetTime(day: 20, hour: 1)),
            forecast: nil
        )!
        let current = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 25, windowDurationMins: 300, resetsAt: resetTime(day: 20, hour: 23)),
            forecast: nil
        )!
        #expect(!CodexResetNotificationPolicy.shouldNotify(
            fingerprint: current,
            acknowledgedFingerprints: [acknowledged]
        ))
    }

    @Test
    func resetDateChangeCreatesANewNotice() {
        let acknowledged = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: resetTime(day: 20, hour: 23)),
            forecast: nil
        )!
        let current = CodexResetNoticeIdentity.fingerprint(
            provider: "codex",
            window: CodexRateLimitWindow(usedPercent: 20, windowDurationMins: 10_080, resetsAt: resetTime(day: 21, hour: 0)),
            forecast: nil
        )!
        #expect(CodexResetNotificationPolicy.shouldNotify(
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
        #expect(!CodexResetNotificationPolicy.shouldNotify(
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
        #expect(CodexResetNotificationPolicy.shouldNotify(
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
        #expect(!CodexResetNotificationPolicy.shouldNotify(
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
        #expect(!CodexResetNotificationPolicy.shouldNotify(
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
        #expect(!CodexResetNotificationPolicy.shouldNotify(
            fingerprint: fingerprint,
            acknowledgedFingerprints: CodexResetNoticeAcknowledgements.load(from: defaults)
        ))
    }

    @Test @MainActor
    func identicalUsageSnapshotSendsExactlyOneSystemNotification() {
        let suite = "CodexResetSystemNotificationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let client = BackendClient()
        var delivered: [CodexResetSystemNotification] = []
        let manager = CodexResetSystemNotificationManager(
            client: client,
            defaults: defaults,
            delivery: { delivered.append($0) }
        )
        let usage = usageSnapshot(forecast: forecast(postId: "one", text: "Codex limits will reset tomorrow"))

        manager.handle(usage)
        manager.handle(usage)

        #expect(delivered.count == 1)
        #expect(delivered[0].body.contains("Tibo"))
        #expect(delivered[0].body.contains("Codex limits will reset tomorrow"))
        #expect(CodexResetNoticeAcknowledgements.load(from: defaults) == [delivered[0].fingerprint])
    }

    @Test @MainActor
    func changedTiboPostSendsOneNewSystemNotification() {
        let suite = "CodexResetSystemNotificationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let client = BackendClient()
        var delivered: [CodexResetSystemNotification] = []
        let manager = CodexResetSystemNotificationManager(
            client: client,
            defaults: defaults,
            delivery: { delivered.append($0) }
        )

        manager.handle(usageSnapshot(forecast: forecast(postId: "one", text: "reset tomorrow")))
        manager.handle(usageSnapshot(forecast: forecast(postId: "two", text: "reset tonight")))
        manager.handle(usageSnapshot(forecast: forecast(postId: "two", text: "reset tonight")))

        #expect(delivered.count == 2)
    }

    @Test @MainActor
    func systemNotificationIgnoresSameDayResetChangesButSendsOnDateChange() {
        let suite = "CodexResetSystemNotificationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let client = BackendClient()
        var delivered: [CodexResetSystemNotification] = []
        let manager = CodexResetSystemNotificationManager(
            client: client,
            defaults: defaults,
            delivery: { delivered.append($0) }
        )

        manager.handle(usageSnapshot(forecast: nil, resetsAt: resetTime(day: 20, hour: 1)))
        manager.handle(usageSnapshot(forecast: nil, resetsAt: resetTime(day: 20, hour: 23)))
        manager.handle(usageSnapshot(forecast: nil, resetsAt: resetTime(day: 21, hour: 0)))

        #expect(delivered.count == 2)
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

    private func resetTime(day: Int, hour: Int) -> Double {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .autoupdatingCurrent
        return calendar.date(from: DateComponents(
            year: 2026,
            month: 8,
            day: day,
            hour: hour
        ))!.timeIntervalSince1970
    }

    private func usageSnapshot(
        forecast: CodexResetForecast?,
        resetsAt: Double = 200_000
    ) -> SessionUsageResponse {
        SessionUsageResponse(
            account: CodexAccountUsage(
                available: true,
                provider: "codex",
                model: nil,
                rateLimits: CodexRateLimitSnapshot(
                    limitId: "codex",
                    limitName: nil,
                    primary: nil,
                    secondary: CodexRateLimitWindow(
                        usedPercent: 20,
                        windowDurationMins: 10_080,
                        resetsAt: resetsAt
                    )
                ),
                rateLimitsByLimitId: nil
            ),
            context: nil,
            resetForecast: CodexResetForecastSnapshot(
                forecast: forecast,
                checkedAt: nil,
                sourceHealthy: true,
                sourceError: nil,
                sourceUrl: nil
            )
        )
    }
}
