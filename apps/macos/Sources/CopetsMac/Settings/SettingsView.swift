import AppKit
import Combine
import CorptieConversation
import CorptieClientCore
import os
import QuartzCore
import SwiftUI
import UserNotifications

enum SettingsPageLayout {
    static let sidebarMinimum: CGFloat = 180
    static let sidebarIdeal: CGFloat = 200
    static let sidebarMaximum: CGFloat = 240
}

enum SettingsTab: Hashable, CaseIterable {
    case general
    case provider
    case appearance
    case notifications
    case devices
    case proxy
    case gateway
    case archivedSessions

    var titleKey: String {
        switch self {
        case .general: "General"
        case .provider: "Provider"
        case .appearance: "外观"
        case .notifications: "Notifications"
        case .devices: "设备接入"
        case .proxy: "Proxy"
        case .gateway: "Gateway"
        case .archivedSessions: "Archived Sessions"
        }
    }

    var systemImage: String {
        switch self {
        case .general: "gearshape"
        case .provider: "cpu"
        case .appearance: "paintpalette"
        case .notifications: "bell"
        case .devices: "ipad.and.iphone"
        case .proxy: "network"
        case .gateway: "message.badge.filled.fill"
        case .archivedSessions: "archivebox"
        }
    }
}

private enum DataRootMigrationDialogPhase: Equatable {
    case confirmation
    case migrating
    case completed
    case failed
}

private struct DataRootMigrationDialogState: Equatable {
    let sourceDataRoot: String
    let targetDataRoot: String
    var phase: DataRootMigrationDialogPhase
    var errorCode: String?
    var errorMessage: String?
}

struct SettingsView: View {
    // Resident settings must not redraw for chat selection/streaming updates.
    private let backendClient = BackendClient.shared
    @ObservedObject private var settingsState = BackendClient.shared.settingsController
    @ObservedObject private var feishuStore = BackendClient.shared.feishuStore
    @ObservedObject private var appLanguage = AppLanguageController.shared
    @State private var selectedTab = SettingsTab.general
    @State private var archivedSessionPendingDeletion: TaskSession?
    @State private var dataRoot = ""
    @State private var choiceParser = ChoiceParserSettings.defaults
    @State private var savedChoiceParser = ChoiceParserSettings.defaults
    @State private var codexBackend = CodexBackendSettings.defaults
    @State private var savedCodexBackend = CodexBackendSettings.defaults
    @State private var codeDiff = CodeDiffSettings.defaults
    @State private var savedCodeDiff = CodeDiffSettings.defaults
    @State private var agentProxy = AgentProxySettings.defaults
    @State private var savedAgentProxy = AgentProxySettings.defaults
    @State private var gateway = GatewaySettings.defaults
    @State private var savedGateway = GatewaySettings.defaults
    @State private var choiceParserStatus: ChoiceParserStatus = .idle
    @State private var feishuAddMode = "credentials"
    @State private var newFeishuAppId = ""
    @State private var newFeishuAppSecret = ""
    @State private var newFeishuProfile = ""
    @State private var feishuPairingCodes: [String: FeishuPairingCodeResponse] = [:]
    @State private var dataRootMigrationDialog: DataRootMigrationDialogState?
    @State private var settingsError: String?
    @State private var sessionCreationDraft: TaskCreationDefaults?

    var body: some View {
        HSplitView {
            settingsCategories
                .mainWindowPageCard()
                // Constrain the card, not just its contents: the shared card
                // deliberately expands, which otherwise widens this split pane.
                .frame(minWidth: SettingsPageLayout.sidebarMinimum,
                       idealWidth: SettingsPageLayout.sidebarIdeal,
                       maxWidth: SettingsPageLayout.sidebarMaximum, maxHeight: .infinity)
                .padding(.trailing, MainWindowPageLayoutMetrics.halfColumnSpacing)
            VStack(spacing: 12) {
                HStack {
                    Text(L10n(selectedTab.titleKey)).font(.title2.weight(.semibold))
                    Spacer()
                }
                Divider()
                selectedSettingsTab.frame(maxWidth: .infinity, maxHeight: .infinity)
                if backendClient.settings != nil || sessionCreationDraft != nil {
                    Divider()
                    HStack {
                        if let settingsError { Text(settingsError).font(.caption).foregroundStyle(.red).lineLimit(2) }
                        Spacer()
                        Button(L10n("Save")) {
                            Task { await saveAllSettings() }
                        }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(backendClient.isUpdatingSettings
                            || dataRoot.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("settings.save")
                    }
                }
            }
            .padding(20)
            .frame(minWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
            .mainWindowPageCard()
            .padding(.leading, MainWindowPageLayoutMetrics.halfColumnSpacing)
        }
        .padding(MainWindowPageLayoutMetrics.outerPadding)
        .accessibilityIdentifier("settings.page")
        .environmentObject(backendClient)
        .onReceive(backendClient.$lastError.removeDuplicates()) { settingsError = $0 }
        .task {
            await backendClient.loadSettings()
            await feishuStore.loadFeishuBots()
            await feishuStore.loadFeishuProfiles()
            selectDefaultFeishuProfileIfNeeded()
            dataRoot = backendClient.settings?.dataRoot
                ?? (dataRoot.isEmpty ? defaultDataRoot : dataRoot)
            choiceParser = backendClient.settings?.choiceParser ?? .defaults
            savedChoiceParser = choiceParser
            codexBackend = backendClient.settings?.codexBackend ?? .defaults
            savedCodexBackend = codexBackend
            codeDiff = backendClient.settings?.codeDiff ?? .defaults
            savedCodeDiff = codeDiff
            agentProxy = backendClient.settings?.agentProxy ?? .defaults
            savedAgentProxy = agentProxy
            gateway = backendClient.settings?.gateway ?? .defaults
            savedGateway = gateway
        }
        .onChange(of: backendClient.settings) { _, settings in
            if let settings {
                dataRoot = settings.dataRoot
                choiceParser = settings.choiceParser ?? .defaults
                savedChoiceParser = choiceParser
                codexBackend = settings.codexBackend ?? .defaults
                savedCodexBackend = codexBackend
                codeDiff = settings.codeDiff ?? .defaults
                savedCodeDiff = codeDiff
                agentProxy = settings.agentProxy ?? .defaults
                savedAgentProxy = agentProxy
                gateway = settings.gateway ?? .defaults
                savedGateway = gateway
                choiceParserStatus = .idle
            }
        }
        .onChange(of: selectedTab) { _, tab in
            guard tab == .archivedSessions else { return }
            Task { await backendClient.refreshArchivedSessions(sessionKind: .assistantChat) }
        }
        .sheet(
            isPresented: Binding(
                get: { dataRootMigrationDialog != nil },
                set: { if !$0 && !backendClient.isUpdatingSettings { dataRootMigrationDialog = nil } }
            )
        ) {
            dataRootMigrationDialogContent
                .interactiveDismissDisabled(backendClient.isUpdatingSettings)
        }
        .confirmationDialog(
            L10n("Delete this archived session permanently?"),
            isPresented: Binding(
                get: { archivedSessionPendingDeletion != nil },
                set: { if !$0 { archivedSessionPendingDeletion = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n("Delete"), role: .destructive) {
                guard let session = archivedSessionPendingDeletion else { return }
                archivedSessionPendingDeletion = nil
                backendClient.delete(session: session)
            }
            Button(L10n("Cancel"), role: .cancel) {
                archivedSessionPendingDeletion = nil
            }
        } message: {
            Text(L10n("This action cannot be undone."))
        }
        .environment(\.locale, appLanguage.locale)
    }

    @ViewBuilder
    private var dataRootMigrationDialogContent: some View {
        if let dialog = dataRootMigrationDialog {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    Image(systemName: dataRootMigrationDialogIcon(dialog.phase))
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundStyle(dataRootMigrationDialogColor(dialog.phase))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(dataRootMigrationDialogTitle(dialog.phase))
                            .font(.system(size: 17, weight: .bold))
                        Text(dialog.targetDataRoot)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(CorptiePalette.secondaryText)
                            .lineLimit(2)
                    }
                }

                switch dialog.phase {
                case .confirmation:
                    VStack(alignment: .leading, spacing: 8) {
                        Text(L10n("Changing the Data Root starts a controlled migration and Backend restart."))
                            .font(.system(size: 13, weight: .semibold))
                        Text(L10n("Corptie will temporarily stop new commands and persistent writes, copy and verify all data, restart the Backend, and reconnect automatically. Active work may block the migration. Do not disconnect the target drive or quit Corptie while migration is running."))
                            .font(.system(size: 12))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        Text(L10n("If migration fails, the original Data Root remains authoritative. The old directory is retained after success and is never deleted automatically."))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                case .migrating:
                    let phase = backendClient.dataRootMigrationPresentationPhase ?? "preflight"
                    VStack(alignment: .leading, spacing: 9) {
                        ProgressView(value: DataRootMigrationPresentation.progress(for: phase), total: 1)
                            .progressViewStyle(.linear)
                        HStack {
                            Text(dataRootMigrationPhaseLabel(phase))
                                .font(.system(size: 12, weight: .semibold))
                            Spacer()
                            Text("\(Int(DataRootMigrationPresentation.progress(for: phase) * 100))%")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(CorptiePalette.secondaryText)
                        }
                        Text(L10n("The Backend may disconnect briefly during restart. This is expected; Corptie will reconnect automatically."))
                            .font(.system(size: 11))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                case .completed:
                    Text(L10n("Migration completed. All new writes now use the new Data Root. The previous directory has been retained."))
                        .font(.system(size: 12))
                        .foregroundStyle(CorptiePalette.secondaryText)
                case .failed:
                    VStack(alignment: .leading, spacing: 8) {
                        if let code = dialog.errorCode {
                            Text(code)
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                .foregroundStyle(.red)
                        }
                        Text(dialog.errorMessage ?? L10n("The migration failed before activation."))
                            .font(.system(size: 12, weight: .medium))
                        if let blockers = backendClient.dataRootMigration?.error?.details?.blockers,
                           !blockers.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(blockers) { blocker in
                                    Text("• \(dataRootMigrationBlockerLabel(blocker.kind)): \(blocker.count)")
                                        .font(.system(size: 11, weight: .medium))
                                }
                            }
                            .padding(.vertical, 2)
                        }
                        if let details = backendClient.dataRootMigration?.error?.details,
                           let artifactId = details.artifactId {
                            Text(L10nFormat(
                                "Affected Artifact: %@ v%lld",
                                artifactId,
                                details.version ?? 0
                            ))
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                        }
                        Text(L10n("The Data Root setting was restored to the original directory. No new root was activated."))
                            .font(.system(size: 11))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                }

                HStack {
                    Spacer()
                    switch dialog.phase {
                    case .confirmation:
                        Button(L10n("Cancel"), role: .cancel) {
                            dataRootMigrationDialog = nil
                        }
                        Button(L10n("Migrate and Restart")) {
                            Task { await confirmDataRootMigration() }
                        }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                    case .migrating:
                        EmptyView()
                    case .completed:
                        Button(L10n("Done")) {
                            dataRootMigrationDialog = nil
                        }
                        .keyboardShortcut(.defaultAction)
                    case .failed:
                        Button(L10n("Close")) {
                            dataRootMigrationDialog = nil
                        }
                        .keyboardShortcut(.defaultAction)
                    }
                }
            }
            .padding(22)
            .frame(width: 500)
        }
    }

    private var settingsCategories: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("Settings")).font(.title2.weight(.semibold)).padding(.bottom, 12)
                ForEach(SettingsTab.allCases, id: \.self) { tab in
                    Button {
                        selectedTab = tab
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: tab.systemImage)
                                .frame(width: 20)
                            Text(L10n(tab.titleKey))
                                .font(.body)
                                .lineLimit(2)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10)
                        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                        .contentShape(Rectangle())
                        .background {
                            if selectedTab == tab {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(Color.accentColor.opacity(0.12))
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings.tab.\(tab)")
                    .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
                }
            }
            .padding(16)
        }
        .accessibilityIdentifier("settings.categories")
    }

    @ViewBuilder
    private var selectedSettingsTab: some View {
        switch selectedTab {
        case .general:
            generalSettingsTab
        case .provider:
            providerSettingsTab
        case .appearance:
            AppearanceSettingsView()
        case .notifications:
            NotificationSettingsView()
        case .devices:
            ClientDevicesSettingsView()
        case .proxy:
            proxySettingsTab
        case .gateway:
            feishuSettingsTab
        case .archivedSessions:
            archivedSessionsTab
        }
    }

    private var generalSettingsTab: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n("Storage"))
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text(L10nFormat(
                        "%@ environment on port %lld.",
                        L10n(CorptieAppEnvironment.displayName),
                        CorptieAppEnvironment.backendPort
                    ))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                if backendClient.isUpdatingSettings {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(L10n("Data Root"))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                HStack(spacing: 8) {
                    TextField(L10n("Choose a data root"), text: $dataRoot)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))

                    Button {
                        chooseDataRoot()
                    } label: {
                        Image(systemName: "folder")
                    }
                    .help(L10n("Choose data root"))
                }
                Text(L10n("Database, configuration, logs, Artifacts, Provider runtimes, Skills, cache, state, and backups are migrated and verified before a controlled Backend restart. The old Data Root is retained and is never deleted automatically."))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)

                if let migration = backendClient.dataRootMigration {
                    let presentedPhase = backendClient.dataRootMigrationPresentationPhase ?? migration.phase
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            if presentedPhase != "completed" && presentedPhase != "failed" {
                                ProgressView().controlSize(.small)
                            }
                            Text(dataRootMigrationPhaseLabel(presentedPhase))
                                .font(.system(size: 11, weight: .semibold))
                            Spacer()
                            Text("#\(migration.generation)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(CorptiePalette.secondaryText)
                        }
                        Text(migration.targetDataRoot)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(CorptiePalette.secondaryText)
                            .lineLimit(2)
                        if let error = migration.error {
                            Text("\(error.code): \(error.message)")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(.red)
                        }
                    }
                    .padding(9)
                    .background(CorptiePalette.secondaryText.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(L10n("Language"))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                Picker(L10n(""), selection: $appLanguage.selection) {
                    ForEach(AppLanguage.allCases) { language in
                        Text(L10n(language.localizationKey)).tag(language)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .frame(maxWidth: 220, alignment: .leading)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(L10n("Session Management"))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(L10n("Archived Sessions"))
                            .font(.system(size: 12, weight: .semibold))
                        Text(L10n("View or restore sessions removed from the main screen."))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                    Spacer()
                    Button(L10n("View…"), systemImage: "archivebox") {
                        selectedTab = .archivedSessions
                    }
                }
            }


            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n("Code Diff Tool"))
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Text(L10n("Used when you review files changed by a Codex reply."))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                Picker(L10n(""), selection: $codeDiff.tool) {
                    Text(L10n("Automatic")).tag("automatic")
                    Text(L10n("Git Difftool")).tag("git-difftool")
                    Text(L10n("FileMerge")).tag("filemerge")
                    Text(L10n("Visual Studio Code")).tag("vscode")
                    Text(L10n("Kaleidoscope")).tag("kaleidoscope")
                    Text(L10n("Beyond Compare")).tag("beyond-compare")
                    Text(L10n("Sublime Merge")).tag("sublime-merge")
                }
                .labelsHidden()
                .frame(width: 180)
            }


            if let error = settingsError {
                Text(error)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
                }
                .padding(.trailing, 8)
            }

        }
    }

    private var providerSettingsTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(L10n("共用配置")).font(.title3.weight(.semibold))
                GroupBox {
                    TaskCreationDefaultsSettingsView(
                        load: { try await ProviderSettingsAPI.readTaskDefaults(providerId: $0) },
                        save: { try await ProviderSettingsAPI.saveTaskDefaults($0) },
                        draft: Binding(
                            get: { sessionCreationDraft ?? backendClient.settings?.newSessionDefaults?.taskCreation ?? TaskCreationDefaults() },
                            set: { sessionCreationDraft = $0 }))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                GroupBox {
                    FoundationModelSettingsView(modelCatalog: backendClient.modelCatalog)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                ProviderEnvironmentSettingsView(defaultProviderId: backendClient.settings?.newSessionDefaults?.taskCreation?.providerId)
            }
            .padding(.trailing, 8)
        }
    }

    private var archivedSessionsTab: some View {
        ArchivedSessionsSettingsTab(
            backendClient: backendClient,
            archivedSessionPendingDeletion: $archivedSessionPendingDeletion
        )
    }

    private var proxySettingsTab: some View {
        ProxySettingsTab(backendClient: backendClient, agentProxy: $agentProxy)
    }

    private var feishuSettingsTab: some View {
        FeishuSettingsTab(
            backendClient: backendClient,
            feishuStore: feishuStore,
            gateway: $gateway,
            feishuAddMode: $feishuAddMode,
            newFeishuAppId: $newFeishuAppId,
            newFeishuAppSecret: $newFeishuAppSecret,
            newFeishuProfile: $newFeishuProfile,
            feishuPairingCodes: $feishuPairingCodes,
            availableFeishuProfiles: availableFeishuProfiles,
            selectDefaultFeishuProfileIfNeeded: selectDefaultFeishuProfileIfNeeded,
            addTrustedWorkspace: addTrustedWorkspace
        )
    }

    private var availableFeishuProfiles: [FeishuProfile] {
        let usedProfiles = Set(feishuStore.feishuBots.map(\.profile))
        return feishuStore.feishuProfiles.filter { !usedProfiles.contains($0.name) }
    }


    private func selectDefaultFeishuProfileIfNeeded() {
        guard !availableFeishuProfiles.contains(where: { $0.name == newFeishuProfile }) else {
            return
        }
        newFeishuProfile = availableFeishuProfiles.first(where: { $0.active })?.name
            ?? availableFeishuProfiles.first?.name
            ?? ""
    }

    private var llmInteractionEnabled: Binding<Bool> {
        Binding(
            get: { choiceParser.provider != "disabled" },
            set: { enabled in
                choiceParser.provider = enabled ? (savedChoiceParser.provider == "openai" ? "openai" : "local-agent") : "disabled"
                choiceParserStatus = .idle
            }
        )
    }

    private var isChoiceParserDirty: Bool {
        choiceParser != savedChoiceParser
    }

    private func addTrustedWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false
        panel.prompt = L10n("Add Workspace")
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            WorkspaceAccessStore.shared.authorize(url)
            let path = url.standardizedFileURL.path
            if !gateway.trustedWorkspaces.contains(path) {
                gateway.trustedWorkspaces.append(path)
            }
        }
    }

    private func saveAllSettings() async {
        let requestedDataRoot = dataRoot.trimmingCharacters(in: .whitespacesAndNewlines)
        if let activeDataRoot = backendClient.settings?.dataRoot,
           !DataRootMigrationPresentation.pathsEqual(activeDataRoot, requestedDataRoot) {
            dataRootMigrationDialog = DataRootMigrationDialogState(
                sourceDataRoot: activeDataRoot,
                targetDataRoot: requestedDataRoot,
                phase: .confirmation
            )
            return
        }

        if await persistSettings(dataRoot: requestedDataRoot) {
            recordSavedSettings()
        }
    }

    private func confirmDataRootMigration() async {
        guard var dialog = dataRootMigrationDialog, dialog.phase == .confirmation else { return }
        dialog.phase = .migrating
        dataRootMigrationDialog = dialog

        if await persistSettings(dataRoot: dialog.targetDataRoot) {
            recordSavedSettings()
            dataRoot = backendClient.settings?.dataRoot ?? dialog.targetDataRoot
            dialog.phase = .completed
            dataRootMigrationDialog = dialog
            return
        }

        let operation = backendClient.dataRootMigration
        await backendClient.loadSettings()
        dataRoot = backendClient.settings?.dataRoot ?? dialog.sourceDataRoot
        dialog.phase = .failed
        dialog.errorCode = operation?.error?.code
        dialog.errorMessage = operation?.error?.message ?? backendClient.lastError ?? L10n("The migration failed before activation.")
        dataRootMigrationDialog = dialog
    }

    private func persistSettings(dataRoot: String) async -> Bool {
        await backendClient.updateSettings(
            dataRoot: dataRoot,
            choiceParser: choiceParser,
            codexBackend: codexBackend,
            codeDiff: codeDiff,
            agentProxy: agentProxy,
            gateway: gateway,
            sessionCreationDefaults: sessionCreationDraft
        )
    }

    private func recordSavedSettings() {
        sessionCreationDraft = nil
        savedChoiceParser = choiceParser
        savedCodexBackend = codexBackend
        savedCodeDiff = codeDiff
        savedAgentProxy = agentProxy
        savedGateway = gateway
        choiceParserStatus = .saved
    }

    private func confirmChoiceParser() async {
        choiceParserStatus = .idle
        if await backendClient.updateSettings(dataRoot: dataRoot, choiceParser: choiceParser, codexBackend: codexBackend, codeDiff: codeDiff, agentProxy: agentProxy, gateway: gateway) {
            savedChoiceParser = choiceParser
            savedCodexBackend = codexBackend
            savedCodeDiff = codeDiff
            savedAgentProxy = agentProxy
            savedGateway = gateway
            choiceParserStatus = .saved
        } else {
            choiceParserStatus = .failed(backendClient.lastError ?? L10n("Save failed"))
        }
    }

    private func testChoiceParser() async {
        choiceParserStatus = .idle
        guard choiceParser.provider != "disabled" else {
            return
        }
        switch await backendClient.testChoiceParser(choiceParser, agentProxy: agentProxy) {
        case .success(let message):
            choiceParserStatus = .passed(message)
        case .failure(let error):
            choiceParserStatus = .failed(error.localizedDescription)
        }
    }

    private func chooseDataRoot() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = URL(fileURLWithPath: dataRoot.isEmpty ? defaultDataRoot : dataRoot)

        if panel.runModal() == .OK, let url = panel.url {
            WorkspaceAccessStore.shared.authorize(url)
            dataRoot = url.path
        }
    }

    private func dataRootMigrationPhaseLabel(_ phase: String) -> String {
        switch phase {
        case "preflight": return L10n("Checking Data Root")
        case "quiescing": return L10n("Stopping persistent writers")
        case "checkpointing": return L10n("Checkpointing database")
        case "copying": return L10n("Copying Data Root")
        case "verifying": return L10n("Verifying migrated data")
        case "switching": return L10n("Committing Data Root selection")
        case "restartRequired": return L10n("Restarting Backend")
        case "reconnecting": return L10n("Reconnecting")
        case "completed": return L10n("Data Root migration completed")
        case "failed": return L10n("Data Root migration failed")
        default: return phase
        }
    }

    private func dataRootMigrationDialogTitle(_ phase: DataRootMigrationDialogPhase) -> String {
        switch phase {
        case .confirmation: L10n("Move Data Root?")
        case .migrating: L10n("Migrating Data Root")
        case .completed: L10n("Data Root Migration Complete")
        case .failed: L10n("Data Root Migration Failed")
        }
    }

    private func dataRootMigrationDialogIcon(_ phase: DataRootMigrationDialogPhase) -> String {
        switch phase {
        case .confirmation: "exclamationmark.triangle.fill"
        case .migrating: "externaldrive.badge.timemachine"
        case .completed: "checkmark.circle.fill"
        case .failed: "xmark.octagon.fill"
        }
    }

    private func dataRootMigrationDialogColor(_ phase: DataRootMigrationDialogPhase) -> Color {
        switch phase {
        case .confirmation: .orange
        case .migrating: .accentColor
        case .completed: .green
        case .failed: .red
        }
    }

    private func dataRootMigrationBlockerLabel(_ kind: String) -> String {
        switch kind {
        case "active_session_turns": L10n("Active Session turns")
        case "agent_work_queue": L10n("Agent work queue")
        case "scheduled_tasks": L10n("Scheduled tasks")
        case "worktree_integrations": L10n("Worktree integrations")
        case "artifact_writes": L10n("Artifact writes")
        case "live_provider_turns": L10n("Live Provider turns")
        case "background_memory_tasks": L10n("Background Memory tasks")
        case "background_choice_tasks": L10n("Background choice tasks")
        default: kind.replacingOccurrences(of: "_", with: " ")
        }
    }

    private var defaultDataRoot: String {
        URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".corptie", isDirectory: true)
            .path
    }
}
