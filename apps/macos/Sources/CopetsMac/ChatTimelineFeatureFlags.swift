import Foundation

enum ChatPerformanceFixtureMode: String, Sendable {
    case disabled
    case standard
}

struct ChatTimelineFeatureFlags: Equatable, Sendable {
    let fixtureMode: ChatPerformanceFixtureMode
    let replaysStreamingUpdates: Bool
    let initialDisplayWeight: Int
    let uiBatchIntervalMilliseconds: Int
    let fixtureStreamSteps: Int
    let fixtureStreamIntervalMilliseconds: Int

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
        let fixtureValue = stringValue(
            environment: environment,
            environmentKey: "CORPTIE_CHAT_PERFORMANCE_FIXTURE",
            defaults: defaults,
            defaultsKey: "chat.performanceFixture"
        )
        let fixtureMode = ChatPerformanceFixtureMode(rawValue: fixtureValue ?? "") ?? .disabled

        return ChatTimelineFeatureFlags(
            fixtureMode: fixtureMode,
            replaysStreamingUpdates: boolValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_PERFORMANCE_STREAM",
                defaults: defaults,
                defaultsKey: "chat.performanceStream"
            ),
            initialDisplayWeight: integerValue(
                environment: environment,
                environmentKey: "CORPTIE_CHAT_INITIAL_DISPLAY_WEIGHT",
                defaults: defaults,
                defaultsKey: "chat.initialDisplayWeight",
                defaultValue: 20,
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
