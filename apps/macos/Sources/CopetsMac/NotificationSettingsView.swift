import AppKit
import SwiftUI
@preconcurrency import UserNotifications

struct NotificationSettingsView: View {
    @ObservedObject private var preferences = SessionNotificationPreferences.shared
    @State private var authorizationStatus: UNAuthorizationStatus?
    @State private var systemNotificationsUnavailable = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(L10n("Task Notifications"))
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text(L10n("Choose which task-state changes should notify you."))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }

                VStack(alignment: .leading, spacing: 12) {
                    notificationToggle(
                        L10n("计划任务通知"),
                        description: L10n("计划任务完成、终态失败、取消或过期时通知；周期完成会自动覆盖，避免刷屏。"),
                        isOn: $preferences.notifyOnAutomations
                    )
                    Divider()
                    notificationToggle(
                        L10n("All sessions are waiting for interaction"),
                        description: L10n("Notify once when at least one session was running and no sessions remain running."),
                        isOn: $preferences.notifyWhenAllSessionsWaiting
                    )
                    Divider()
                    notificationToggle(
                        L10n("A session completes"),
                        description: L10n("Notify when a session changes from Running to Complete."),
                        isOn: $preferences.notifyOnComplete
                    )
                    notificationToggle(
                        L10n("A session needs interaction"),
                        description: L10n("Notify when a session changes from Running to Blocked."),
                        isOn: $preferences.notifyOnBlocked
                    )
                    notificationToggle(
                        L10n("A session fails"),
                        description: L10n("Notify when a session changes from Running to Failed."),
                        isOn: $preferences.notifyOnFailed
                    )
                }
                .padding(14)
                .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Label(authorizationLabel, systemImage: authorizationSymbol)
                            .font(.system(size: 12, weight: .semibold))
                        Spacer()
                        if systemNotificationsUnavailable {
                            EmptyView()
                        } else if authorizationStatus == .notDetermined {
                            Button(L10n("Allow Notifications")) {
                                requestAuthorization()
                            }
                        } else if authorizationStatus == .denied {
                            Button(L10n("Open System Settings")) {
                                openSystemNotificationSettings()
                            }
                        }
                    }
                    Text(L10n("If the final session event also makes every session wait, Corptie sends only the combined notification."))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button(L10n("Send Test Notification")) {
                            SessionCompletionSoundManager.sendTestNotification()
                            Task { await refreshAuthorizationStatus() }
                        }
                        .disabled(systemNotificationsUnavailable)
                        Spacer()
                        Text(L10n("Per-session sounds are configured in Session Settings."))
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .padding(.horizontal, 2)
        .task {
            await refreshAuthorizationStatus()
        }
    }

    private func notificationToggle(
        _ title: String,
        description: String,
        isOn: Binding<Bool>
    ) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                Text(description)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)
            }
        }
        .toggleStyle(.checkbox)
    }

    private var authorizationLabel: String {
        if systemNotificationsUnavailable {
            return L10n("System notifications require the packaged app")
        }
        return switch authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            L10n("System notifications allowed")
        case .denied:
            L10n("System notifications denied")
        case .notDetermined:
            L10n("System notification permission not requested")
        case nil:
            L10n("Checking notification permission…")
        @unknown default:
            L10n("System notification status unavailable")
        }
    }

    private var authorizationSymbol: String {
        if systemNotificationsUnavailable {
            return "shippingbox"
        }
        return switch authorizationStatus {
        case .authorized, .provisional, .ephemeral: "checkmark.circle.fill"
        case .denied: "exclamationmark.triangle.fill"
        default: "bell.badge"
        }
    }

    private func requestAuthorization() {
        guard let center = SystemNotificationCenter.currentIfAvailable() else { return }
        Task {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            await refreshAuthorizationStatus()
        }
    }

    private func refreshAuthorizationStatus() async {
        guard let center = SystemNotificationCenter.currentIfAvailable() else {
            systemNotificationsUnavailable = true
            authorizationStatus = nil
            return
        }
        systemNotificationsUnavailable = false
        let settings = await center.notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    private func openSystemNotificationSettings() {
        let bundleID = Bundle.main.bundleIdentifier ?? "com.corptie.mac"
        let urls = [
            URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?bundleIdentifier=\(bundleID)"),
            URL(string: "x-apple.systempreferences:com.apple.preference.notifications")
        ].compactMap { $0 }
        for url in urls where NSWorkspace.shared.open(url) {
            break
        }
    }
}
