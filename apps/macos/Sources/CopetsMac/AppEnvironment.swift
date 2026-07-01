import Foundation

@MainActor
enum CopetsAppEnvironment {
    static let rawName: String = {
        let value = ProcessInfo.processInfo.environment["COPETS_ENV"]?.lowercased() ?? "production"
        return ["dev", "development"].contains(value) ? "development" : "production"
    }()

    static let isDevelopment = rawName == "development"
    static let displayName = isDevelopment ? "Development" : "Production"
    static let appName = isDevelopment ? "Copets Dev" : "Copets"
    static let appSupportFolderName = isDevelopment ? "Copets Development" : "Copets"

    static let backendPort: Int = {
        if let value = ProcessInfo.processInfo.environment["COPETS_BACKEND_PORT"],
           let port = Int(value) {
            return port
        }
        return isDevelopment ? 47322 : 47321
    }()

    static let backendBaseURL = URL(string: "http://127.0.0.1:\(backendPort)")!

    static let userDefaults: UserDefaults = {
        UserDefaults(suiteName: isDevelopment ? "com.copets.mac.development" : "com.copets.mac.production") ?? .standard
    }()
}
