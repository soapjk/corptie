import Foundation

enum ChatTimelineRenderer: String, CaseIterable, Sendable {
    case swiftUIVStack = "swiftuiVStack"
    case appKitTable
    case appKitNativeText
}

enum ChatPerformanceFixtureMode: String, Sendable {
    case disabled
    case standard
}

struct ChatTimelineFeatureFlags: Equatable, Sendable {
    let renderer: ChatTimelineRenderer
    let fixtureMode: ChatPerformanceFixtureMode
    let replaysStreamingUpdates: Bool
    let sseHealthEnabled: Bool
    let uiBatchingEnabled: Bool
    let markdownCacheEnabled: Bool
    let boundedWindowEnabled: Bool
    let deltaTimelineEnabled: Bool
    let initialDisplayWeight: Int
    let uiBatchIntervalMilliseconds: Int
    let fixtureStreamSteps: Int
    let fixtureStreamIntervalMilliseconds: Int

    var rendererIndex: Int {
        ChatTimelineRenderer.allCases.firstIndex(of: renderer) ?? 0
    }

    @MainActor
    static var current: ChatTimelineFeatureFlags {
        resolve(
            environment: ProcessInfo.processInfo.environment,
            defaults: CorptieAppEnvironment.userDefaults
        )
    }

    static func resolve(
        environment: [String: String],
        defaults: UserDefaults? = nil
    ) -> ChatTimelineFeatureFlags {
        let rendererValue = stringValue(
            environment: environment,
            environmentKey: "CORPTIE_CHAT_RENDERER",
            defaults: defaults,
            defaultsKey: "chat.renderer"
        )
        let isDevelopment = ["dev", "development"].contains(
            environment["CORPTIE_ENV"]?.lowercased() ?? ""
        )
        let renderer = ChatTimelineRenderer(rawValue: rendererValue ?? "")
            ?? (isDevelopment ? .appKitNativeText : .swiftUIVStack)
        let fixtureValue = stringValue(
            environment: environment,
            environmentKey: "CORPTIE_CHAT_PERFORMANCE_FIXTURE",
            defaults: defaults,
            defaultsKey: "chat.performanceFixture"
        )
        let fixtureMode = ChatPerformanceFixtureMode(rawValue: fixtureValue ?? "") ?? .disabled

        return ChatTimelineFeatureFlags(
            renderer: renderer,
            fixtureMode: fixtureMode,
            replaysStreamingUpdates: boolValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_PERFORMANCE_STREAM",
                defaults: defaults,
                defaultsKey: "chat.performanceStream"
            ),
            sseHealthEnabled: boolValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_SSE_HEALTH",
                defaults: defaults,
                defaultsKey: "chat.sseHealth.enabled",
                defaultValue: isDevelopment
            ),
            uiBatchingEnabled: boolValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_UI_BATCHING",
                defaults: defaults,
                defaultsKey: "chat.uiBatching.enabled",
                defaultValue: isDevelopment
            ),
            markdownCacheEnabled: boolValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_MARKDOWN_CACHE",
                defaults: defaults,
                defaultsKey: "chat.markdownCache.enabled"
            ),
            boundedWindowEnabled: boolValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_BOUNDED_WINDOW",
                defaults: defaults,
                defaultsKey: "chat.boundedWindow.enabled"
            ),
            deltaTimelineEnabled: boolValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_DELTA_TIMELINE",
                defaults: defaults,
                defaultsKey: "chat.deltaTimeline.enabled",
                defaultValue: isDevelopment
            ),
            initialDisplayWeight: integerValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_INITIAL_DISPLAY_WEIGHT",
                defaults: defaults,
                defaultsKey: "chat.initialDisplayWeight",
                defaultValue: 7,
                range: 1...500
            ),
            uiBatchIntervalMilliseconds: integerValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_UI_BATCH_INTERVAL_MS",
                defaults: defaults,
                defaultsKey: "chat.uiBatchIntervalMilliseconds",
                defaultValue: 100,
                range: 16...500
            ),
            fixtureStreamSteps: integerValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_PERFORMANCE_STREAM_STEPS",
                defaults: nil,
                defaultsKey: "",
                defaultValue: 200,
                range: 1...100_000
            ),
            fixtureStreamIntervalMilliseconds: integerValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_PERFORMANCE_STREAM_INTERVAL_MS",
                defaults: nil,
                defaultsKey: "",
                defaultValue: 50,
                range: 1...1_000
            )
        )
    }

    private static func stringValue(
        environment: [String: String],
        environmentKey: String,
        defaults: UserDefaults?,
        defaultsKey: String
    ) -> String? {
        if let value = environment[environmentKey]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty {
            return value
        }
        guard let value = defaults?.string(forKey: defaultsKey)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }

    private static func boolValue(
        environment: [String: String],
        environmentKey: String,
        defaults: UserDefaults?,
        defaultsKey: String,
        defaultValue: Bool = false
    ) -> Bool {
        if let value = environment[environmentKey] {
            return ["1", "true", "yes", "on"].contains(value.lowercased())
        }
        guard let defaults, defaults.object(forKey: defaultsKey) != nil else {
            return defaultValue
        }
        return defaults.bool(forKey: defaultsKey)
    }

    private static func integerValue(
        environment: [String: String],
        environmentKey: String,
        defaults: UserDefaults?,
        defaultsKey: String,
        defaultValue: Int,
        range: ClosedRange<Int>
    ) -> Int {
        let rawValue = environment[environmentKey].flatMap(Int.init)
            ?? defaults.flatMap { defaults in
                defaults.object(forKey: defaultsKey) == nil ? nil : defaults.integer(forKey: defaultsKey)
            }
            ?? defaultValue
        return min(range.upperBound, max(range.lowerBound, rawValue))
    }
}
