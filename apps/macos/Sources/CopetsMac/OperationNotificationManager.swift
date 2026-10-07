import AppKit
import SwiftUI
import CorptieClientCore
import Foundation
import OSLog
@preconcurrency import UserNotifications

/// App-scoped observer; no dependency on the Worktree window or its polling task.
@MainActor
final class OperationNotificationManager {
    static let shared = OperationNotificationManager()
    let preferences: OperationNotificationPreferences
    private let ledger: OperationNotificationLedger
    private let baseURL: URL
    var visibleRepositoryID: String?
    var visibleJobID: String?
    private var resultWindow: NSWindow?
    private var recovery: Task<Void, Never>?
    private static let logger = Logger(subsystem: "com.corptie.mac", category: "OperationNotifications")

    init(defaults: UserDefaults = CorptieAppEnvironment.userDefaults,
         baseURL: URL = CorptieAppEnvironment.backendBaseURL) {
        self.baseURL = baseURL
        preferences = OperationNotificationPreferences(defaults: defaults)
        ledger = OperationNotificationLedger(defaults: defaults, scope: baseURL.absoluteString)
    }

    func track(jobID: String, resourceName: String? = nil) { ledger.track(jobID: jobID, resourceName: resourceName) }

    func observe(data: String) {
        struct Envelope: Decodable {
            let payload: Payload
            struct Payload: Decodable {
                let job: Job
                struct Job: Decodable { let notification: OperationJobSnapshot? }
            }
        }
        guard let bytes = data.data(using: .utf8),
              let value = try? JSONDecoder().decode(Envelope.self, from: bytes),
              let job = value.payload.job.notification else { return }
        observe(job)
    }

    func observe(_ job: OperationJobSnapshot) {
        if let event = ledger.observe(job) { complete(event) }
    }

    /// One bounded reconciliation on stream start/gap; existing SSE owns live updates.
    func recoverJobs() {
        guard recovery == nil, !ledger.recoverableJobIDs.isEmpty else { return }
        recovery = Task { [weak self] in
            guard let self else { return }
            defer { self.recovery = nil }
            struct Envelope: Decodable {
                let job: Job
                struct Job: Decodable { let notification: OperationJobSnapshot? }
            }
            for id in self.ledger.recoverableJobIDs {
                guard !Task.isCancelled else { return }
                do {
                    let (data, response) = try await URLSession.shared.data(from:
                        self.baseURL.appending(path: "worktree-management/jobs/\(id)"))
                    guard (response as? HTTPURLResponse)?.statusCode == 200,
                          let job = try JSONDecoder().decode(Envelope.self, from: data).job.notification else { continue }
                    self.observe(job)
                } catch { Self.logger.debug("Operation recovery deferred") }
            }
        }
    }

    private func summary(_ event: OperationNotificationEvent) -> String {
        var lines = [event.summary].filter { !$0.isEmpty }
        if let counts = event.counts {
            lines.append(L10nFormat("Completed %d; failed %d; pending %d", counts.completed, counts.failed, counts.pending))
        }
        return lines.joined(separator: "\n")
    }

    func complete(_ event: OperationNotificationEvent) {
        guard ledger.consume(event), preferences.allows(event),
              event.outcome != .succeeded || Date().timeIntervalSince(event.occurredAt) < 86400,
              let center = SystemNotificationCenter.currentIfAvailable() else { return }
        Task {
            let settings = await center.notificationSettings()
            guard [.authorized, .provisional].contains(settings.authorizationStatus),
                  preferences.allows(event) else { return }
            let content = UNMutableNotificationContent()
            content.title = L10n(event.outcome.title)
            content.body = preferences.hideDetails ? L10n(event.category.title)
                : [L10n(event.name), summary(event)].filter { !$0.isEmpty }.joined(separator: "\n")
            if preferences.sound { content.sound = .default }
            var info = ["destination": "operation", "operationEventId": event.id]
            if let id = event.repositoryID { info["repositoryId"] = id }
            if let id = event.worktreeID { info["worktreeId"] = id }
            if let id = event.sessionID { info["sessionId"] = id }
            if let id = event.jobID { info["jobId"] = id }
            info["category"] = event.category.rawValue
            content.userInfo = info
            do {
                try await center.add(UNNotificationRequest(identifier: "operation:\(event.id)", content: content, trigger: nil))
            } catch { Self.logger.error("Operation notification could not be submitted") }
        }
    }

    func presentationOptions(_ info: [AnyHashable: Any]) -> UNNotificationPresentationOptions {
        if !preferences.enabled { return [] }
        if let id = info["operationEventId"] as? String,
           let event = ledger.results.first(where: { $0.id == id }), !preferences.allows(event) { return [] }
        if preferences.suppressWhenVisible, NSApp.isActive,
           AppTabRouter.shared.selectedTab == .worktrees,
           let repository = info["repositoryId"] as? String, repository == visibleRepositoryID,
           (info["jobId"] == nil || info["jobId"] as? String == visibleJobID) { return [] }
        return preferences.sound ? [.banner, .sound] : [.banner]
    }

    func handleResponse(_ info: [AnyHashable: Any]) {
        NSApp.activate(ignoringOtherApps: true)
        if let id = info["operationEventId"] as? String, let event = ledger.results.first(where: { $0.id == id }) {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 200),
                styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = L10n(event.outcome.title)
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: VStack(alignment: .leading, spacing: 12) {
                Text(L10n(event.name)).font(.headline)
                Text(L10n(event.outcome.title))
                if !summary(event).isEmpty { Text(summary(event)).textSelection(.enabled) }
                if let repository = event.repositoryID {
                    Button(L10n("View operation")) {
                        AppDelegate.shared?.openWorktreeManagement(repositoryId: repository,
                            worktreeId: event.worktreeID, worktreePath: nil, jobId: event.jobID)
                    }
                }
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading))
            resultWindow?.close()
            resultWindow = window
            window.center()
            window.makeKeyAndOrderFront(nil)
        }
        if let repository = info["repositoryId"] as? String {
            AppDelegate.shared?.openWorktreeManagement(repositoryId: repository,
                worktreeId: info["worktreeId"] as? String, worktreePath: nil,
                jobId: info["jobId"] as? String)
        } else if let session = info["sessionId"] as? String {
            NotificationCenter.default.post(name: .openSessionConversation, object: nil, userInfo: ["sessionId": session])
        } else {
            AppDelegate.shared?.openSettings()
        }
    }
}
