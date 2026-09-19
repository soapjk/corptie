/// Shared authoritative lifecycle mapping for desktop and mobile messages.
public enum UserMessageProcessingState: String, Equatable, Sendable {
    case queued, processing, consumed, failed, cancelled

    public init?(authoritativeValue: String?, legacyStatus: String?) {
        if let authoritativeValue {
            guard let state = Self(rawValue: authoritativeValue.lowercased()) else { return nil }
            self = state
            return
        }
        // Receipt acceptance and timeline position never imply processing.
        switch legacyStatus?.lowercased() {
        case "queued": self = .queued
        case "running", "processing": self = .processing
        default: return nil
        }
    }
}
