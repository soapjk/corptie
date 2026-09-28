import AppKit
import SwiftUI

struct FeishuSettingsTab: View {
    @ObservedObject var backendClient: BackendClient
    @ObservedObject var feishuStore: FeishuSettingsStore
    @Binding var gateway: GatewaySettings
    @Binding var feishuAddMode: String
    @Binding var newFeishuAppId: String
    @Binding var newFeishuAppSecret: String
    @Binding var newFeishuProfile: String
    @Binding var feishuPairingCodes: [String: FeishuPairingCodeResponse]
    let availableFeishuProfiles: [FeishuProfile]
    let selectDefaultFeishuProfileIfNeeded: () -> Void
    let addTrustedWorkspace: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("IMgateway")
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text(L10n("Connect trusted IM users to sessions on this Mac."))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                if feishuStore.isUpdatingFeishu {
                    ProgressView()
                        .controlSize(.small)
                }
                Button {
                    Task { await feishuStore.loadFeishuBots() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help(L10n("Refresh Feishu bots"))
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(L10n("Trusted Workspaces"))
                                    .font(.system(size: 13, weight: .bold))
                                Text(L10n("These folders appear first when a Feishu user creates a session. Paths used by existing sessions are included automatically."))
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(CorptiePalette.secondaryText)
                            }
                            Spacer()
                            Button(L10n("Add Folder…")) {
                                addTrustedWorkspace()
                            }
                            .controlSize(.small)
                        }

                        if gateway.trustedWorkspaces.isEmpty {
                            Text(L10n("No pinned workspaces. Existing and recent session folders remain available in Feishu."))
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(CorptiePalette.secondaryText)
                        } else {
                            ForEach(gateway.trustedWorkspaces, id: \.self) { path in
                                HStack(spacing: 8) {
                                    Image(systemName: "folder.fill")
                                        .foregroundStyle(.blue)
                                    Text(path)
                                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                        .help(path)
                                    Spacer()
                                    Button {
                                        gateway.trustedWorkspaces.removeAll { $0 == path }
                                    } label: {
                                        Image(systemName: "minus.circle")
                                    }
                                    .buttonStyle(.plain)
                                    .help(L10n("Remove trusted workspace"))
                                }
                            }
                        }
                    }
                    .padding(12)
                    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                    if feishuStore.feishuBots.isEmpty {
                        ContentUnavailableView(
                            L10n("No Feishu Bots"),
                            systemImage: "message.badge",
                            description: Text(L10n("Add a lark-cli profile below. A bot stays stopped until you explicitly enable it."))
                        )
                        .frame(maxWidth: .infinity, minHeight: 150)
                    } else {
                        ForEach(feishuStore.feishuBots) { bot in
                            feishuBotCard(bot)
                        }
                    }

                    Divider()

                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(L10n("Add Bot"))
                                .font(.system(size: 13, weight: .bold))
                            Spacer()
                            Link(L10n("Create or configure in Feishu Open Platform"), destination: URL(string: "https://open.feishu.cn/app")!)
                                .font(.system(size: 10, weight: .semibold))
                        }
                        Text(L10n("Feishu requires the enterprise app and bot capability to be created and published in its developer console first. Corptie connects that existing app to local sessions."))
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        Picker(L10n(""), selection: $feishuAddMode) {
                            Text(L10n("App Credentials")).tag("credentials")
                            Text(L10n("Existing CLI Profile")).tag("profile")
                        }
                        .pickerStyle(.segmented)
                        if feishuAddMode == "credentials" {
                            TextField(L10n("Feishu App ID"), text: $newFeishuAppId)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                            SecureField(L10n("Feishu App Secret"), text: $newFeishuAppSecret)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                        } else if availableFeishuProfiles.isEmpty {
                            Text(L10n("No unused lark-cli Profiles are available. Add a Profile in lark-cli or remove its existing Gateway bot first."))
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(CorptiePalette.secondaryText)
                        } else {
                            Picker(L10n("lark-cli Profile"), selection: $newFeishuProfile) {
                                ForEach(availableFeishuProfiles) { profile in
                                    Text(profile.active ? "\(profile.name) (Active)" : profile.name)
                                        .tag(profile.name)
                                }
                            }
                            .pickerStyle(.menu)
                        }
                        HStack {
                            Text(feishuAddMode == "credentials"
                                ? L10n("The App Secret is passed directly to lark-cli encrypted storage and is never saved in the Corptie database.")
                                : L10n("The existing Profile and its credentials remain owned by lark-cli and are never removed by Corptie."))
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(CorptiePalette.secondaryText)
                            Spacer()
                            Button(L10n("Add Bot")) {
                                Task {
                                    let added = if feishuAddMode == "credentials" {
                                        await feishuStore.addFeishuBot(appId: newFeishuAppId, appSecret: newFeishuAppSecret)
                                    } else {
                                        await feishuStore.addFeishuBot(profile: newFeishuProfile)
                                    }
                                    if added {
                                        newFeishuAppId = ""
                                        newFeishuAppSecret = ""
                                        await feishuStore.loadFeishuProfiles()
                                        selectDefaultFeishuProfileIfNeeded()
                                    }
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!canAddFeishuBot || feishuStore.isUpdatingFeishu)
                        }
                    }
                    .padding(12)
                    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .padding(.trailing, 8)
            }

            if let error = backendClient.lastError {
                Text(error)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
        }
    }

    @ViewBuilder
    private func feishuBotCard(_ bot: FeishuBot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if let avatar = bot.remoteAvatarURL.flatMap(URL.init(string:)) {
                    AsyncImage(url: avatar) { image in
                        image
                            .resizable()
                            .scaledToFill()
                    } placeholder: {
                        DefaultInitialAvatarView(
                            seed: bot.remoteName ?? bot.name,
                            initials: DefaultAvatarInitials.make(from: bot.remoteName ?? bot.name),
                            size: 30
                        )
                    }
                    .frame(width: 30, height: 30)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                } else {
                    DefaultInitialAvatarView(
                        seed: bot.remoteName ?? bot.name,
                        initials: DefaultAvatarInitials.make(from: bot.remoteName ?? bot.name),
                        size: 30
                    )
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(bot.remoteName ?? L10n("Loading Feishu bot identity…"))
                        .font(.system(size: 13, weight: .bold))
                    if let remoteName = bot.remoteName {
                        Text(L10nFormat("Search in Feishu: %@", remoteName))
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.blue)
                    }
                    Text(L10nFormat("App ID: %@ · Profile: %@", bot.appId ?? L10n("Unknown"), bot.profile))
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .textSelection(.enabled)
                }
                Spacer()
                Text(feishuConnectionLabel(bot))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(bot.connectionStatus == "connected" ? .green : CorptiePalette.secondaryText)
                Toggle(L10n(""), isOn: Binding(
                    get: { bot.enabled },
                    set: { enabled in
                        Task { await feishuStore.setFeishuBotEnabled(bot, enabled: enabled) }
                    }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
            }

            if let error = bot.lastError, !error.isEmpty {
                Text(error)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.red)
            }

            HStack(spacing: 14) {
                Label(bot.bindings.isEmpty ? L10n("Not paired") : L10n("Paired"), systemImage: bot.bindings.isEmpty ? "person.crop.circle.badge.questionmark" : "person.crop.circle.badge.checkmark")
                if let assignment = bot.assignment {
                    Label(assignment.sessionId, systemImage: "link")
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    Label(L10n("No session selected"), systemImage: "link.badge.plus")
                }
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(CorptiePalette.secondaryText)

            if let pairing = feishuPairingCodes[bot.id] {
                HStack(spacing: 8) {
                    Text(L10n("Pairing code"))
                        .font(.system(size: 11, weight: .semibold))
                    Text(pairing.code)
                        .font(.system(size: 18, weight: .bold, design: .monospaced))
                        .textSelection(.enabled)
                    Text(L10nFormat("expires %@", pairing.expiresAt))
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                .padding(.vertical, 4)
            }

            HStack(spacing: 8) {
                Button(L10n("Generate Pairing Code")) {
                    Task {
                        if case .success(let pairing) = await feishuStore.createFeishuPairingCode(for: bot) {
                            feishuPairingCodes[bot.id] = pairing
                        }
                    }
                }
                .disabled(!bot.enabled)
                if let binding = bot.bindings.first {
                    Button(L10n("Unpair")) {
                        Task { await feishuStore.revokeFeishuBinding(binding) }
                    }
                }
                if bot.assignment != nil {
                    Button(L10n("Release Session")) {
                        Task { await feishuStore.releaseFeishuSession(for: bot) }
                    }
                }
                Spacer()
                Button(L10n("Delete"), role: .destructive) {
                    Task {
                        if await feishuStore.deleteFeishuBot(bot) {
                            feishuPairingCodes.removeValue(forKey: bot.id)
                            selectDefaultFeishuProfileIfNeeded()
                        }
                    }
                }
            }
            .controlSize(.small)
            .disabled(feishuStore.isUpdatingFeishu)
        }
        .padding(12)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func feishuConnectionLabel(_ bot: FeishuBot) -> String {
        switch bot.connectionStatus {
        case "connected": L10n("Connected")
        case "connecting": L10n("Connecting")
        case "error": L10n("Error")
        default: L10n("Stopped")
        }
    }

    private var canAddFeishuBot: Bool {
        if feishuAddMode == "profile" {
            return availableFeishuProfiles.contains { $0.name == newFeishuProfile }
        }
        return !newFeishuAppId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !newFeishuAppSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
