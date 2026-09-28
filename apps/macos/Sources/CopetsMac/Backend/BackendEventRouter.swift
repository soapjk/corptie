import Foundation
import UserNotifications

private struct AutomationClientActionEnvelope: Decodable {
    let payload: Payload
    struct Payload: Decodable {
        let sessionId: String
        let runId: String
        let title: String?
        let body: String?
    }
}

private struct SessionTimelineChangedEventEnvelope: Decodable {
    let payload: Payload
    struct Payload: Decodable {
        let sessionId: String
        let timelineRevision: Int
    }
}

/// Decodes the single Backend event stream and routes wakes to their domain owners.
@MainActor
final class BackendEventRouter {
    struct Ports {
        let channelMessage: (TaskCollaborationFlowEvent.Envelope) -> Void
        let loadSettings: () async -> Void
        let syncNewSessionDefaults: () async -> Void
        let loadProviders: () async -> Void
        let reconcileTimelineRevisions: () async -> Void
        let loadAutomations: () async -> Void
        let selectedSession: () -> TaskSession?
        let loadScheduledTasks: (TaskSession) async -> Void
        let scheduleTimelineSync: (TaskSession, Int) -> Void
        let timelineRevision: (String, Int) -> Void
        let projectStatus: (String) -> Void
        let terminalAutomation: (AutomationTerminalNotificationEvent) -> Void
        let automationRefresh: (String?) -> Void
        let workspaceSwitched: (TaskSession) -> Void
        let workspaceSwitchFailed: (String) -> Void
        let usageEvent: (String) -> Void
        let inventoryEvent: (String) -> Void
        let sessionCleared: (SessionReplacement) -> Void
    }

    private let ports: Ports
    init(ports: Ports) { self.ports = ports }

    func handle(_ eventName: String, data: String) async {
        if eventName == "SessionChannelMessageSent", let bytes = data.data(using: .utf8),
           let envelope = try? JSONDecoder().decode(TaskCollaborationFlowEvent.Envelope.self, from: bytes) {
            ports.channelMessage(envelope)
        }
        if eventName == "BackendStoreReady" {
            // Startup requests are allowed to receive a retryable 503 while the
            // migration Worker is running. Reissue their authoritative reads as
            // soon as the Store crosses its independent readiness boundary.
            await AppStateSyncController.shared.refreshSnapshot()
            await ports.loadSettings()
            await ports.syncNewSessionDefaults()
            await ports.loadProviders()
            await ports.reconcileTimelineRevisions()
            await ports.loadAutomations()
            if let selectedSession = ports.selectedSession() { await ports.loadScheduledTasks(selectedSession) }
            return
        }
        if eventName == "EventReplayRequired" {
            // The bounded wake-event buffer cannot cover this cursor. State and
            // timelines have their own durable authorities, so repair those
            // directly instead of replaying ambiguous side effects.
            await AppStateSyncController.shared.refreshSnapshot()
            await ports.reconcileTimelineRevisions()
            await ports.loadAutomations()
            if let selectedSession = ports.selectedSession() {
                await ports.loadScheduledTasks(selectedSession)
                ports.scheduleTimelineSync(selectedSession, selectedSession.timelineRevision ?? 0)
            }
            return
        }
        if eventName == "SessionTimelineChanged" {
            guard let payload = data.data(using: .utf8),
                  let event = try? JSONDecoder().decode(
                    SessionTimelineChangedEventEnvelope.self,
                    from: payload
                  ) else { return }
            ports.timelineRevision(event.payload.sessionId, event.payload.timelineRevision)
            return
        }
        if eventName == "ProjectWorkspaceChanged"
            || eventName == "ProjectWorktreeIntegrationStarted"
            || eventName == "ProjectWorktreeIntegrationCompleted" {
            ports.projectStatus(data)
            return
        }
        if eventName == "AutomationSessionActivationRequested" {
            // Background activation must never mutate foreground navigation.
            // The queued message wakes the Session; only an explicit user
            // action (for example clicking its notification) may open it.
            return
        }
        if eventName == "AutomationLocalNotificationRequested" {
            guard let payload = data.data(using: .utf8),
                  let event = try? JSONDecoder().decode(AutomationClientActionEnvelope.self, from: payload),
                  let center = SystemNotificationCenter.currentIfAvailable() else { return }
            let content = UNMutableNotificationContent()
            content.title = event.payload.title ?? L10n("Corptie Automation")
            content.body = event.payload.body ?? L10n("Automation completed.")
            content.userInfo = ["sessionId": event.payload.sessionId]
            try? await center.add(UNNotificationRequest(
                identifier: "automation:\(event.payload.runId)",
                content: content,
                trigger: nil
            ))
            return
        }
        if ScheduledSessionEventMapping.authoritativeEventNames.contains(eventName) {
            if ScheduledSessionEventMapping.terminalNotificationEventNames.contains(eventName),
               let event = AutomationTerminalNotificationEvent.decode(eventName: eventName, data: data) {
                ports.terminalAutomation(event)
            }
            let payload = data.data(using: .utf8)
            ports.automationRefresh(payload.flatMap(ScheduledSessionEventMapping.sessionId))
            // Timeline projection and its revision event are emitted by the
            // backend mutation; selected state never pulls detail here.
            return
        }
        if eventName == "SessionWorkspaceSwitched" {
            if let payload = data.data(using: .utf8),
               let event = try? JSONDecoder().decode(SessionWorkspaceSwitchedEventEnvelope.self, from: payload) {
                ports.workspaceSwitched(event.payload.session)
            }
            if let selectedSession = ports.selectedSession() { await ports.loadScheduledTasks(selectedSession) }
            ports.projectStatus(data)
            return
        }
        if eventName == "SessionWorkspaceSwitchFailed" {
            if let payload = data.data(using: .utf8),
               let event = try? JSONDecoder().decode(SessionTransitionEventEnvelope.self, from: payload),
               let sessionId = event.payload.sessionId {
                ports.workspaceSwitchFailed(sessionId)
            }
            return
        }
        if eventName == "ProviderSwitchPending" {
            return
        }
        if eventName == "ProviderSwitched" {
            return
        }
        if eventName == "ProviderSessionChanged" {
            return
        }
        if eventName == "SessionUsageUpdated" {
            ports.usageEvent(data)
            return
        }
        if eventName == "WorkspaceInventoryChanged" {
            ports.inventoryEvent(data)
            return
        }
        if eventName == "SessionCleared" {
            if let payload = data.data(using: .utf8),
               let event = try? JSONDecoder().decode(SessionClearedEventEnvelope.self, from: payload) {
                ports.sessionCleared(event.payload)
                return
            }
            return
        }
    }
}
