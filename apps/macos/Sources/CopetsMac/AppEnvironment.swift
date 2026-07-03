import Foundation

@MainActor
enum CorptieAppEnvironment {
    static let rawName: String = {
        let value = ProcessInfo.processInfo.environment["CORPTIE_ENV"]?.lowercased() ?? "production"
        return ["dev", "development"].contains(value) ? "development" : "production"
    }()

    static let isDevelopment = rawName == "development"
    static let displayName = isDevelopment ? "Development" : "Production"
    static let appName = isDevelopment ? "Corptie Dev" : "Corptie"
    static let appSupportFolderName = isDevelopment ? "Corptie Development" : "Corptie"

    static let backendPort: Int = {
        if let value = ProcessInfo.processInfo.environment["CORPTIE_BACKEND_PORT"],
           let port = Int(value) {
            return port
        }
        return isDevelopment ? 47322 : 47321
    }()

    static let backendBaseURL = URL(string: "http://127.0.0.1:\(backendPort)")!

    static let userDefaults: UserDefaults = {
        UserDefaults(suiteName: isDevelopment ? "com.corptie.mac.development" : "com.corptie.mac.production") ?? .standard
    }()
}
