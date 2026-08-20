import Foundation

struct AgentCreationSubmission: Equatable {
    private(set) var idempotencyKey: String
    private(set) var isSubmitting = false

    init(idempotencyKey: String = UUID().uuidString) {
        self.idempotencyKey = idempotencyKey
    }

    mutating func begin() -> String? {
        guard !isSubmitting else { return nil }
        isSubmitting = true
        return idempotencyKey
    }

    mutating func finishAfterFailure() {
        isSubmitting = false
    }
}

@MainActor
enum CorptieInstallationIdentity {
    private static let defaultsKey = "corptie.installation-id"

    static func id(defaults: UserDefaults = CorptieAppEnvironment.userDefaults) -> String {
        if let existing = defaults.string(forKey: defaultsKey), !existing.isEmpty {
            return existing
        }
        let created = UUID().uuidString
        defaults.set(created, forKey: defaultsKey)
        return created
    }
}
