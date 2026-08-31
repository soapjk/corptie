import Foundation

@MainActor
enum CorptieAppEnvironment {
    private static let environment = ProcessInfo.processInfo.environment
    static let rawName: String = {
        let value = ProcessInfo.processInfo.environment["CORPTIE_ENV"]?.lowercased() ?? "production"
        return ["dev", "development"].contains(value) ? "development" : "production"
    }()

    static let isDevelopment = rawName == "development"
    static let canManageProductionBackend: Bool = {
        guard !isDevelopment,
              Bundle.main.bundleIdentifier == "com.corptie.mac",
              Bundle.main.bundleURL.pathExtension.lowercased() == "app",
              Bundle.main.url(forResource: "com.corptie.backend", withExtension: "plist") != nil else {
            return false
        }
        return true
    }()
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

    static let developmentBackendConfiguration: DevelopmentBackendConfiguration? = {
        CorptieProcessLifecycle.developmentBackendConfiguration(
            environment: environment,
            isDevelopment: isDevelopment
        )
    }()

    static let userDefaults: UserDefaults = {
        let suite = RunIsolationAppPaths.userDefaultsSuite(
            environment: environment,
            isDevelopment: isDevelopment
        )
        guard let defaults = UserDefaults(suiteName: suite) else {
            fatalError("Unable to create isolated UserDefaults suite: \(suite)")
        }
        return defaults
    }()

    static let presentationDatabaseURL: URL = {
        if let dataDirectory = RunIsolationAppPaths.dataDirectory(environment: environment) {
            return dataDirectory.appendingPathComponent("presentation.sqlite3")
        }
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        return support.appendingPathComponent(appSupportFolderName, isDirectory: true)
            .appendingPathComponent("presentation.sqlite3")
    }()
}

struct DevelopmentBackendConfiguration: Equatable {
    let launcherURL: URL
    let logURL: URL
}

enum CorptieProcessLifecycle {
    static func developmentBackendConfiguration(
        environment: [String: String],
        isDevelopment: Bool
    ) -> DevelopmentBackendConfiguration? {
        guard isDevelopment,
              let launcherPath = environment["CORPTIE_DEVELOPMENT_BACKEND_LAUNCHER"],
              let logPath = environment["CORPTIE_DEVELOPMENT_BACKEND_LOG"],
              launcherPath.hasPrefix("/Volumes/"),
              logPath.hasPrefix("/Volumes/"),
              URL(fileURLWithPath: launcherPath).standardizedFileURL.path == launcherPath,
              URL(fileURLWithPath: logPath).standardizedFileURL.path == logPath else {
            return nil
        }
        return DevelopmentBackendConfiguration(
            launcherURL: URL(fileURLWithPath: launcherPath),
            logURL: URL(fileURLWithPath: logPath)
        )
    }
}

enum RunIsolationAppPaths {
    static func userDefaultsSuite(environment: [String: String], isDevelopment: Bool) -> String {
        let isolatedRun = !(environment["CORPTIE_RUN_ID"] ?? "").isEmpty
        if let value = environment["CORPTIE_USER_DEFAULTS_SUITE"] {
            guard (isolatedRun ? value.hasPrefix("com.corptie.run.") : isDevelopment && value.hasPrefix("com.corptie.development.")),
                  value.range(of: #"^[A-Za-z0-9.-]{1,255}$"#, options: .regularExpression) != nil else {
                fatalError("Invalid Corptie UserDefaults isolation suite")
            }
            return value
        }
        if isolatedRun {
            fatalError("Isolated run requires CORPTIE_USER_DEFAULTS_SUITE before App initialization")
        }
        return isDevelopment ? "com.corptie.mac.development" : "com.corptie.mac.production"
    }

    static func dataDirectory(environment: [String: String]) -> URL? {
        let isolatedRun = !(environment["CORPTIE_RUN_ID"] ?? "").isEmpty
        let value = isolatedRun ? environment["CORPTIE_DATA_DIR"] : environment["CORPTIE_PRESENTATION_DATA_DIR"]
        guard let value else {
            if isolatedRun { fatalError("Isolated run requires CORPTIE_DATA_DIR before App initialization") }
            return nil
        }
        guard value.hasPrefix("/Volumes/") else {
            fatalError("Isolated and Worktree Development data requires an external-volume directory")
        }
        return URL(fileURLWithPath: value, isDirectory: true).standardizedFileURL
    }
}
