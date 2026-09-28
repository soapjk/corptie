import AppKit
import Combine
import os
import QuartzCore
import SwiftUI
import UserNotifications

@MainActor
enum CorptieBackendSupervisor {
    private static let label = "com.corptie.backend"
    private static var developmentBackendProcess: Process?
    private static var developmentBackendLogHandle: FileHandle?

    static func ensureBackendStarted() {
        if CorptieAppEnvironment.isDevelopment {
            startDevelopmentBackendBestEffort()
        } else {
            ensureProductionBackendStarted()
        }
    }

    static func ensureProductionBackendStarted() {
        guard CorptieAppEnvironment.canManageProductionBackend else {
            return
        }
        guard let bundledPlist = Bundle.main.url(forResource: label, withExtension: "plist") else {
            return
        }

        do {
            let fileManager = FileManager.default
            let launchAgentsDir = fileManager.homeDirectoryForCurrentUser
                .appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("LaunchAgents", isDirectory: true)
            let backendLogDir = fileManager.homeDirectoryForCurrentUser
                .appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("Logs", isDirectory: true)
                .appendingPathComponent("Corptie", isDirectory: true)
            let installedPlist = launchAgentsDir.appendingPathComponent("\(label).plist")

            try fileManager.createDirectory(at: launchAgentsDir, withIntermediateDirectories: true)
            // launchd opens StandardOutPath/StandardErrorPath before executing
            // the bundled launcher, so the parent directory must already exist.
            try fileManager.createDirectory(at: backendLogDir, withIntermediateDirectories: true)
            let launchAgentData = try BackendLaunchAgentConfiguration.data(
                template: Data(contentsOf: bundledPlist),
                home: fileManager.homeDirectoryForCurrentUser,
                bundle: Bundle.main.bundleURL
            )
            if (try? Data(contentsOf: installedPlist)) != launchAgentData {
                _ = try? runLaunchctl(["bootout", "gui/\(getuid())", installedPlist.path])
                try launchAgentData.write(to: installedPlist, options: .atomic)
            }

            if !isLaunchAgentLoaded() {
                try runLaunchctl(["bootstrap", "gui/\(getuid())", installedPlist.path])
            }
            // The installed job is deliberately neither RunAtLoad nor
            // KeepAlive. Opening Corptie is the sole production start signal.
            try runLaunchctl(["kickstart", "gui/\(getuid())/\(label)"])
        } catch {
            NSLog("Corptie backend startup failed: \(error.localizedDescription)")
        }
    }

    static func stopProductionBackend() throws {
        guard CorptieAppEnvironment.canManageProductionBackend, isLaunchAgentLoaded() else {
            return
        }
        try runLaunchctl(["bootout", "gui/\(getuid())/\(label)"])
    }

    static func stopDevelopmentBackendBestEffort() {
        guard CorptieAppEnvironment.isDevelopment else { return }
        stopDevelopmentBackend()
    }

    private static func startDevelopmentBackendBestEffort() {
        do {
            try startDevelopmentBackend()
        } catch {
            NSLog("Corptie Development backend startup failed: \(error.localizedDescription)")
        }
    }

    private static func startDevelopmentBackend() throws {
        if developmentBackendProcess?.isRunning == true {
            return
        }
        guard let configuration = CorptieAppEnvironment.developmentBackendConfiguration else {
            throw BackendSupervisorError.developmentConfigurationUnavailable
        }

        let fileManager = FileManager.default
        try fileManager.createDirectory(
            at: configuration.logURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if !fileManager.fileExists(atPath: configuration.logURL.path) {
            guard fileManager.createFile(atPath: configuration.logURL.path, contents: nil) else {
                throw BackendSupervisorError.developmentLogUnavailable
            }
        }
        let logHandle = try FileHandle(forWritingTo: configuration.logURL)
        try logHandle.seekToEnd()

        let process = Process()
        process.executableURL = configuration.launcherURL
        process.environment = ProcessInfo.processInfo.environment
        process.standardOutput = logHandle
        process.standardError = logHandle
        do {
            try process.run()
        } catch {
            try? logHandle.close()
            throw error
        }
        developmentBackendProcess = process
        developmentBackendLogHandle = logHandle
    }

    private static func stopDevelopmentBackend() {
        if let process = developmentBackendProcess, process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
        developmentBackendProcess = nil
        try? developmentBackendLogHandle?.close()
        developmentBackendLogHandle = nil
    }

    static func restartBackendForDataRootMigration() async throws {
        var request = URLRequest(
            url: CorptieAppEnvironment.backendBaseURL.appending(path: "internal/backend/data-root-restart")
        )
        request.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 202 else {
            throw BackendSupervisorError.restartNotAccepted
        }
        if CorptieAppEnvironment.canManageProductionBackend {
            try runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(label)"])
            return
        }
        guard CorptieAppEnvironment.isDevelopment else {
            throw BackendSupervisorError.restartUnavailable
        }
        try restartDevelopmentBackend()
    }

    static func ensureBackendRunningForPendingDataRootMigration() async throws {
        if CorptieAppEnvironment.canManageProductionBackend {
            ensureProductionBackendStarted()
            return
        }
        guard CorptieAppEnvironment.isDevelopment else {
            throw BackendSupervisorError.restartUnavailable
        }
        try restartDevelopmentBackend()
    }

    private static func restartDevelopmentBackend() throws {
        stopDevelopmentBackend()
        try startDevelopmentBackend()
    }

    private static func isLaunchAgentLoaded(_ serviceLabel: String = label) -> Bool {
        (try? runLaunchctl(["print", "gui/\(getuid())/\(serviceLabel)"])) != nil
    }

    @discardableResult
    private static func runLaunchctl(_ arguments: [String]) throws -> String {
        let process = Process()
        let output = Pipe()
        let errorOutput = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = errorOutput
        try process.run()
        process.waitUntilExit()

        let stdout = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: errorOutput.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else {
            throw BackendSupervisorError.launchctlFailed(arguments.joined(separator: " "), stderr.isEmpty ? stdout : stderr)
        }
        return stdout
    }

    enum BackendSupervisorError: LocalizedError {
        case launchctlFailed(String, String)
        case restartUnavailable
        case restartNotAccepted
        case developmentConfigurationUnavailable
        case developmentLogUnavailable

        var errorDescription: String? {
            switch self {
            case let .launchctlFailed(command, output):
                return "launchctl \(command) failed: \(output)"
            case .restartUnavailable:
                return "This Corptie host cannot restart the Backend."
            case .restartNotAccepted:
                return "The Backend did not accept the controlled restart."
            case .developmentConfigurationUnavailable:
                return "The App-owned Development backend configuration is unavailable."
            case .developmentLogUnavailable:
                return "The App-owned Development backend log is unavailable."
            }
        }
    }
}

enum CorptiePermissionManager {
    @MainActor
    static func openFullDiskAccessSettings() {
        let candidateURLs: [URL] = [
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!,
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy")!,
            URL(fileURLWithPath: "/System/Library/PreferencePanes/Security.prefPane")
        ]

        for url in candidateURLs {
            if NSWorkspace.shared.open(url) {
                break
            }
        }
    }
}
