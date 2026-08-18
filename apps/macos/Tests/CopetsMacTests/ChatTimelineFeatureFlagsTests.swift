import Foundation
import Testing
@testable import CorptieMac

struct ChatTimelineFeatureFlagsTests {
    @Test
    func defaultsUseTheNativeAppKitRendererAndEnableOptimizationPaths() {
        let flags = ChatTimelineFeatureFlags.resolve(environment: [:])

        #expect(flags.renderer == .appKitNativeText)
        #expect(flags.fixtureMode == .disabled)
        #expect(flags.initialDisplayWeight == 7)
        #expect(flags.uiBatchIntervalMilliseconds == 100)
        #expect(flags.sseHealthEnabled)
        #expect(flags.uiBatchingEnabled)
        #expect(flags.markdownCacheEnabled)
        #expect(flags.boundedWindowEnabled)
        #expect(flags.deltaTimelineEnabled)
    }

    @Test
    func developmentAndProductionShareTheSameDefaults() {
        let production = ChatTimelineFeatureFlags.resolve(environment: [:])
        let development = ChatTimelineFeatureFlags.resolve(environment: ["CORPTIE_ENV": "development"])

        #expect(production == development)
        #expect(development.renderer == .appKitNativeText)
        #expect(development.sseHealthEnabled)
        #expect(development.fixtureStreamSteps == 200)
        #expect(development.fixtureStreamIntervalMilliseconds == 50)
    }

    @Test
    func environmentOverridesDefaultsAndClampsTheFixtureWindow() {
        let suiteName = "ChatTimelineFeatureFlagsTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(ChatTimelineRenderer.swiftUIVStack.rawValue, forKey: "chat.renderer")
        defaults.set(false, forKey: "chat.markdownCache.enabled")

        let flags = ChatTimelineFeatureFlags.resolve(
            environment: [
                "CORPTIE_CHAT_RENDERER": "appKitTable",
                "CORPTIE_CHAT_PERFORMANCE_FIXTURE": "standard",
                "CORPTIE_CHAT_PERFORMANCE_STREAM": "true",
                "CORPTIE_CHAT_MARKDOWN_CACHE": "1",
                "CORPTIE_CHAT_UI_BATCH_INTERVAL_MS": "8",
                "CORPTIE_CHAT_INITIAL_DISPLAY_WEIGHT": "900"
            ],
            defaults: defaults
        )

        #expect(flags.renderer == .appKitTable)
        #expect(flags.fixtureMode == .standard)
        #expect(flags.replaysStreamingUpdates)
        #expect(flags.markdownCacheEnabled)
        #expect(flags.initialDisplayWeight == 500)
        #expect(flags.uiBatchIntervalMilliseconds == 16)
    }
}
