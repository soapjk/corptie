import Foundation

enum BackendLaunchAgentConfiguration {
    static func data(template: Data, home: URL, bundle: URL) throws -> Data {
        guard var plist = try PropertyListSerialization.propertyList(from: template, format: nil) as? [String: Any] else {
            throw CocoaError(.propertyListReadCorrupt)
        }
        var environment = plist["EnvironmentVariables"] as? [String: String] ?? [:]
        environment["CORPTIE_DEFAULT_WORKSPACE"] = home.appendingPathComponent("corptie").path
        plist["EnvironmentVariables"] = environment
        plist["ProgramArguments"] = [bundle.appendingPathComponent("Contents/Resources/corptie-backend-launch.sh").path]
        let logs = home.appendingPathComponent("Library/Logs/Corptie")
        plist["StandardOutPath"] = logs.appendingPathComponent("backend.out.log").path
        plist["StandardErrorPath"] = logs.appendingPathComponent("backend.err.log").path
        return try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    }
}
