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
    static let contentMaximum: CGFloat = 720
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
    @State private var draft = SettingsDraftState()
    @State private var foundationDraft = FoundationModelDraft()
    @State private var discardConfirmation = false
    @FocusState private var dataRootFocused: Bool
    @State private var feishuAddMode = "credentials"
    @State private var newFeishuAppId = ""
    @State private var newFeishuAppSecret = ""
    @State private var newFeishuProfile = ""
    @State private var feishuPairingCodes: [String: FeishuPairingCodeResponse] = [:]
    @State private var dataRootMigrationDialog: DataRootMigrationDialogState?

    private let loadsSettings: Bool

    init(initialTab: SettingsTab = .general, draft: SettingsDraftState = SettingsDraftState(), loadsSettings: Bool = true) {
        _selectedTab = State(initialValue: initialTab)
        _draft = State(initialValue: draft)
        self.loadsSettings = loadsSettings
    }

    var body: some View {
        GeometryReader { geometry in
            let wide = geometry.size.width >= 800
            HSplitView {
                settingsCategories
                    .padding(.top, MainWindowLayoutMetrics.titlebarHeight)
                    .modifier(SettingsColumnSurface(sidebar: true))
                    .frame(minWidth: wide ? SettingsPageLayout.sidebarMinimum : 0,
                           idealWidth: wide ? SettingsPageLayout.sidebarIdeal : 0,
                           maxWidth: wide ? SettingsPageLayout.sidebarMaximum : 0, maxHeight: .infinity)
                    .clipped()
                    .accessibilityHidden(!wide)
                settingsDetail(compact: !wide, inset: geometry.size.width < 480 ? 16 : 20)
                    .padding(.top, MainWindowLayoutMetrics.titlebarHeight)
                    .modifier(SettingsColumnSurface())
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        // Match the console: column canvases reach the window edges while
        // each column's controls reserve their own titlebar clearance.
        .ignoresSafeArea(.container, edges: .top)
        .background(WorkbenchStyle.canvas.ignoresSafeArea(.container, edges: .vertical))
        .accessibilityIdentifier("settings.page")
        .environmentObject(backendClient)
        .task { if loadsSettings { await loadSettings() } }
        .onChange(of: settingsState.settings) { _, settings in
            guard !draft.isSaving, let settings else { return }
            draft.receive(settings)
        }
        .onChange(of: draft.isReadOnly, initial: true) { _, readOnly in
            foundationDraft.readOnly = readOnly
        }
        .onChange(of: dataRootFocused) { _, focused in
            if !focused { draft.showValidation = true }
        }
        .confirmationDialog(L10n("Discard unsaved settings?"), isPresented: $discardConfirmation, titleVisibility: .visible) {
            Button(L10n("Discard Changes"), role: .destructive) { draft.discard() }
            Button(L10n("Cancel"), role: .cancel) { }
        } message: {
            Text(L10n("Only pending shared settings will be discarded. Immediate changes and separately saved regions are kept."))
        }
        .onChange(of: selectedTab) { _, tab in
            if tab == .archivedSessions {
                Task { await backendClient.refreshArchivedSessions(sessionKind: .assistantChat) }
            } else if tab == .gateway {
                Task {
                    await feishuStore.loadFeishuBots()
                    await feishuStore.loadFeishuProfiles()
                    selectDefaultFeishuProfileIfNeeded()
                }
            }
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
                        Text(L10n("Other pending shared settings are submitted with this migration. Separately saved regions are not included."))
                            .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                        Text(L10n("If migration fails, the original Data Root remains authoritative. The old directory is retained after success and is never deleted automatically."))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                case .migrating:
                    let phase = backendClient.dataRootMigrationPresentationPhase ?? "preflight"
                    VStack(alignment: .leading, spacing: 9) {
                        ProgressView().controlSize(.small)
                            .progressViewStyle(.linear)
                        HStack {
                            Text(dataRootMigrationPhaseLabel(phase))
                                .font(.system(size: 12, weight: .semibold))
                            Spacer()
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

    private func loadSettings() async {
        await backendClient.loadSettings()
        if let settings = settingsState.settings { draft.receive(settings) }
        else { draft.loadError = backendClient.lastError ?? L10n("Unable to load settings.") }
        await draft.providerDraft.load()
        // Only the gateway needs these inventories. Do not put them ahead of the
        // first visible form or fetch them on every settings entry.
    }

    private func settingsDetail(compact: Bool, inset: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if compact {
                Menu {
                    ForEach(SettingsTab.allCases, id: \.self) { tab in
                        Button { selectedTab = tab } label: {
                            Label(categoryLabel(tab), systemImage: tab.systemImage)
                        }
                    }
                } label: {
                    Label(L10n("Category") + ": " + L10n(selectedTab.titleKey), systemImage: "line.3.horizontal")
                }
                .accessibilityIdentifier("settings.categoryMenu")
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n(selectedTab.titleKey)).font(WorkbenchTypography.font(for: .pageTitle))
                    .accessibilityIdentifier("settings.page.title")
                    .accessibilityAddTraits(.isHeader)
                Text(selectedTab.saveExplanation).font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
            }
            Divider()
            if !draft.isLoaded && selectedTab.hasSharedSettings {
                if let error = draft.loadError {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(error, systemImage: "exclamationmark.triangle")
                        Button(L10n("Retry")) { Task { await loadSettings() } }
                    }
                    .font(WorkbenchTypography.font(for: .help))
                } else {
                    ProgressView(L10n("Loading settings…"))
                }
                Spacer(minLength: 0)
            } else {
                selectedSettingsTab
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .disabled(draft.isSaving)
            }
            Divider()
            settingsFeedback
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 12) {
                    saveStatus.fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 12)
                    saveActions
                }
                VStack(alignment: .leading, spacing: 8) {
                    saveStatus
                    HStack { Spacer(minLength: 0); saveActions }
                }
            }
            .frame(minHeight: 52)
        }
        .frame(maxWidth: SettingsPageLayout.contentMaximum, maxHeight: .infinity, alignment: .topLeading)
        .padding(inset)
        .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var saveStatus: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !draft.dirtyTabs.isEmpty {
                Menu {
                    ForEach(SettingsTab.allCases.filter { draft.dirtyTabs.contains($0) }, id: \.self) { tab in
                        Button(L10n(tab.titleKey)) { selectedTab = tab }
                    }
                } label: {
                    Label(L10nFormat("%lld categories have unsaved changes", draft.dirtyTabs.count), systemImage: "pencil.circle")
                }
                .accessibilityIdentifier("settings.unsaved")
            } else if selectedTab.hasSharedSettings {
                if let date = draft.lastSavedAt {
                    Label(L10n("Settings saved") + " · " + date.formatted(date: .omitted, time: .shortened), systemImage: "checkmark.circle")
                } else {
                    Text(L10n("No unsaved changes"))
                }
            } else {
                Text(selectedTab.saveExplanation)
            }
            if foundationDraft.isDirty {
                Button(L10n("Background model has changes to save separately")) { selectedTab = .provider }
                    .buttonStyle(.link)
            }
            if !newFeishuAppId.isEmpty || !newFeishuAppSecret.isEmpty {
                Button(L10n("Bot credentials have not been added")) { selectedTab = .gateway }
                    .buttonStyle(.link)
            }
        }
        .font(WorkbenchTypography.font(for: .help))
        .foregroundStyle(.secondary)
    }

    @ViewBuilder private var saveActions: some View {
        if !draft.dirtyTabs.isEmpty {
            Button(L10n("Discard Changes")) { discardConfirmation = true }
                .disabled(draft.isSaving)
                .accessibilityIdentifier("settings.discard")
        }
        if selectedTab.hasSharedSettings || !draft.dirtyTabs.isEmpty {
            Button {
                Task { await saveAllSettings() }
            } label: {
                HStack(spacing: 6) {
                    if draft.isSaving { ProgressView().controlSize(.small) }
                    Text(L10n(draft.isSaving ? "Saving…" : "Save Settings"))
                }
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut("s", modifiers: .command)
            .disabled(!draft.canSave)
            .accessibilityIdentifier("settings.save")
        }
    }

    @ViewBuilder private var settingsFeedback: some View {
        if draft.isReadOnly && selectedTab.hasSharedSettings {
            Label(L10n("Read-only preview. Shared settings cannot be saved."), systemImage: "lock")
        }
        if !draft.conflictTabs.isEmpty {
            Label(L10n("Settings changed elsewhere. Your edits are kept. Discard shared changes to load the latest values before saving."), systemImage: "exclamationmark.triangle")
                .foregroundStyle(CorptiePalette.amber)
        }
        if let error = draft.saveError {
            Label(L10n("Settings were not fully saved.") + " " + error, systemImage: "exclamationmark.circle")
                .foregroundStyle(.red).textSelection(.enabled)
                .accessibilityIdentifier("settings.save.error")
        }
        if draft.showValidation, let error = draft.dataRootError {
            Button {
                selectedTab = .general
                dataRootFocused = true
            } label: { Label(error, systemImage: "exclamationmark.circle") }
                .buttonStyle(.link)
        }
    }

    private func categoryLabel(_ tab: SettingsTab) -> String {
        let suffix = draft.conflictTabs.contains(tab) ? L10n("Conflict")
            : draft.dirtyTabs.contains(tab) || (tab == .provider && foundationDraft.isDirty)
                ? L10n("Unsaved changes") : ""
        return L10n(tab.titleKey) + (suffix.isEmpty ? "" : " · " + suffix)
    }

    private var settingsCategories: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("Settings")).font(WorkbenchTypography.font(for: .navigationHeading)).padding(.bottom, 12)
                ForEach(SettingsTab.allCases, id: \.self) { tab in
                    if tab == .general || tab == .devices || tab == .archivedSessions {
                        Text(tab.groupTitle)
                            .font(WorkbenchTypography.font(for: .navigationHeading)).foregroundStyle(.secondary)
                            .padding(.top, tab == .general ? 0 : 16).padding(.bottom, 4)
                    }
                    Button { selectedTab = tab } label: {
                        HStack(spacing: 0) {
                            ManagementCategoryRow(title: L10n(tab.titleKey), systemImage: tab.systemImage, isSelected: selectedTab == tab)
                            if draft.conflictTabs.contains(tab) {
                                Image(systemName: "exclamationmark.triangle").foregroundStyle(CorptiePalette.amber)
                            } else if draft.dirtyTabs.contains(tab) || (tab == .provider && foundationDraft.isDirty) {
                                Image(systemName: "circle.fill").font(.system(size: 5))
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(categoryLabel(tab))
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
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                SettingsSectionHeading(title: L10n("Language and tools"), mode: L10n("Language changes immediately; code diff requires Save Settings."))
                SettingsOptionRow(title: L10n("Language")) {
                    Picker(L10n("Language"), selection: $appLanguage.selection) {
                        ForEach(AppLanguage.allCases) { language in
                            Text(L10n(language.localizationKey)).tag(language)
                        }
                    }
                    .pickerStyle(.menu).labelsHidden()
                    .accessibilityIdentifier("settings.language")
                }

                SettingsOptionRow(title: L10n("Code Diff Tool"),
                                  explanation: L10n("Used when reviewing files changed during a session.")) {
                    Picker(L10n("Code Diff Tool"), selection: $draft.codeDiff.tool) {
                        Text(L10n("Automatic")).tag("automatic")
                        Text(L10n("Git Difftool")).tag("git-difftool")
                        Text(L10n("FileMerge")).tag("filemerge")
                        Text(L10n("Visual Studio Code")).tag("vscode")
                        Text(L10n("Kaleidoscope")).tag("kaleidoscope")
                        Text(L10n("Beyond Compare")).tag("beyond-compare")
                        Text(L10n("Sublime Merge")).tag("sublime-merge")
                    }
                    .labelsHidden()
                    .disabled(draft.isReadOnly)
                    .accessibilityIdentifier("settings.codeDiff")
                }

                Divider()

                SettingsSectionHeading(title: L10n("Session collaboration"), mode: L10n("Requires Save Settings"))
                SettingsOptionRow(title: L10n("Confirm the first collaboration message"),
                                  explanation: L10n("Ask before two sessions first communicate. Turn off to send directly; existing channels and parent-child collaboration keep their current permissions.")) {
                    Toggle(L10n("Confirm the first collaboration message"), isOn: $draft.collaboration.requireFirstMessageConfirmation)
                        .toggleStyle(.switch)
                        .labelsHidden()
                        .disabled(draft.isReadOnly)
                        .accessibilityIdentifier("settings.collaboration.requireFirstMessageConfirmation")
                }

                Divider()

                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        SettingsSectionHeading(title: L10n("Storage"), mode: L10n("Requires Save Settings"))
                        Text(L10nFormat(
                            "%@ environment on port %lld.",
                            L10n(CorptieAppEnvironment.displayName),
                            CorptieAppEnvironment.backendPort
                        ))
                            .font(WorkbenchTypography.font(for: .help))
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
                        .font(WorkbenchTypography.font(for: .body))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    HStack(spacing: 8) {
                        TextField(L10n("Choose a data root"), text: $draft.dataRoot)
                            .disabled(draft.isReadOnly)
                            .focused($dataRootFocused)
                            .accessibilityIdentifier("settings.dataRoot")
                            .textFieldStyle(.roundedBorder)
                            .font(WorkbenchTypography.font(for: .technical))

                        Button {
                            chooseDataRoot()
                        } label: {
                            Image(systemName: "folder")
                        }
                        .disabled(draft.isReadOnly)
                        .help(L10n("Choose data root"))
                        .accessibilityLabel(L10n("Choose data root"))
                    }
                    if draft.showValidation, let error = draft.dataRootError {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.red)
                            .accessibilityIdentifier("settings.dataRoot.error")
                    }
                    Text(L10n("Database, configuration, logs, Artifacts, Provider runtimes, Skills, cache, state, and backups are migrated and verified before a controlled Backend restart. The old Data Root is retained and is never deleted automatically."))
                        .font(WorkbenchTypography.font(for: .help))
                        .foregroundStyle(CorptiePalette.secondaryText)

                    if let migration = backendClient.dataRootMigration {
                        let presentedPhase = backendClient.dataRootMigrationPresentationPhase ?? migration.phase
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 8) {
                                if presentedPhase != "completed" && presentedPhase != "failed" {
                                    ProgressView().controlSize(.small)
                                }
                                Text(dataRootMigrationPhaseLabel(presentedPhase))
                                    .font(WorkbenchTypography.font(for: .metadata).weight(.semibold))
                                Spacer()
                                Text("#\(migration.generation)")
                                    .font(WorkbenchTypography.font(for: .technical))
                                    .foregroundStyle(CorptiePalette.secondaryText)
                            }
                            Text(migration.targetDataRoot)
                                .font(WorkbenchTypography.font(for: .technical))
                                .foregroundStyle(CorptiePalette.secondaryText)
                                .lineLimit(2)
                            if let error = migration.error {
                                Text("\(error.code): \(error.message)")
                                    .font(WorkbenchTypography.font(for: .help))
                                    .foregroundStyle(.red)
                            }
                        }
                        .padding(12)
                        .background(CorptiePalette.secondaryText.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                    }
                }


                VStack(alignment: .leading, spacing: 12) {
                    Text(L10n("Session Management"))
                        .font(WorkbenchTypography.font(for: .sectionTitle))
                    SettingsOptionRow(title: L10n("Archived Sessions"),
                                      explanation: L10n("View or restore sessions removed from the main screen.")) {
                        Button(L10n("View…"), systemImage: "archivebox") { selectedTab = .archivedSessions }
                            .accessibilityIdentifier("settings.archivedSessions.open")
                    }
                }


            }
            .padding(.trailing, 8)
        }
    }

    private var providerSettingsTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                SettingsSectionHeading(title: L10n("共用配置"), mode: L10n("Session defaults use Save Settings below. Background models are saved separately."))
                GroupBox {
                    TaskCreationDefaultsSettingsView(
                        load: { try await ProviderSettingsAPI.readTaskDefaults(providerId: $0) },
                        save: { try await ProviderSettingsAPI.saveTaskDefaults($0) },
                        draft: Binding(
                            get: { draft.taskCreation },
                            set: { draft.taskCreation = $0 }))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .disabled(draft.isReadOnly)
                }
                GroupBox {
                    FoundationModelSettingsView(modelCatalog: backendClient.modelCatalog, draft: foundationDraft)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                ProviderEnvironmentSettingsView(defaultProviderId: backendClient.settings?.newSessionDefaults?.taskCreation?.providerId, draft: draft.providerDraft)
                    .disabled(draft.isReadOnly)
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
        ProxySettingsTab(backendClient: backendClient, agentProxy: $draft.agentProxy)
            .disabled(draft.isReadOnly)
    }

    private var feishuSettingsTab: some View {
        FeishuSettingsTab(
            backendClient: backendClient,
            feishuStore: feishuStore,
            gateway: $draft.gateway,
            feishuAddMode: $feishuAddMode,
            newFeishuAppId: $newFeishuAppId,
            newFeishuAppSecret: $newFeishuAppSecret,
            newFeishuProfile: $newFeishuProfile,
            feishuPairingCodes: $feishuPairingCodes,
            availableFeishuProfiles: availableFeishuProfiles,
            selectDefaultFeishuProfileIfNeeded: selectDefaultFeishuProfileIfNeeded,
            addTrustedWorkspace: addTrustedWorkspace
        )
        .disabled(draft.isReadOnly)
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
            if !draft.gateway.trustedWorkspaces.contains(path) {
                draft.gateway.trustedWorkspaces.append(path)
            }
        }
    }

    private func saveAllSettings() async {
        draft.showValidation = true
        guard draft.canSave else {
            if draft.dataRootError != nil { selectedTab = .general; dataRootFocused = true }
            return
        }
        draft.saveError = nil
        let requestedDataRoot = draft.dataRoot.trimmingCharacters(in: .whitespacesAndNewlines)
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
            draft.dataRoot = backendClient.settings?.dataRoot ?? dialog.targetDataRoot
            dialog.phase = .completed
            dataRootMigrationDialog = dialog
            return
        }

        let operation = backendClient.dataRootMigration
        await backendClient.loadSettings()
        dialog.phase = .failed
        dialog.errorCode = operation?.error?.code
        dialog.errorMessage = operation?.error?.message ?? backendClient.lastError ?? L10n("The migration failed before activation.")
        dataRootMigrationDialog = dialog
    }

    private func persistSettings(dataRoot: String) async -> Bool {
        let success = await draft.save { submitted in
            // Save provider metadata before a data-root migration moves its state directory.
            try await draft.providerDraft.save()
            let updated = await backendClient.updateSettings(
                dataRoot: dataRoot,
                choiceParser: submitted.choiceParser,
                codexBackend: submitted.codexBackend,
                codeDiff: submitted.codeDiff,
                agentProxy: submitted.agentProxy,
                gateway: submitted.gateway,
                sessionCreationDefaults: draft.sharedDirtyTabs.contains(.provider) ? submitted.taskCreation : nil,
                collaboration: submitted.collaboration
            )
            guard updated, let settings = settingsState.settings else {
                throw BackendError.message(backendClient.lastError ?? L10n("Save failed"))
            }
            await backendClient.loadProviders()
            return settings
        }
        if !success {
            // The endpoint can save ordinary fields before migration fails.
            await backendClient.loadSettings()
            if let settings = settingsState.settings { draft.receive(settings) }
            await draft.providerDraft.load()
        }
        return success
    }

    private func recordSavedSettings() {
        if let settings = settingsState.settings { draft.saved(settings) }
    }

    private func chooseDataRoot() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = URL(fileURLWithPath: draft.dataRoot.isEmpty ? defaultDataRoot : draft.dataRoot)

        if panel.runModal() == .OK, let url = panel.url {
            WorkspaceAccessStore.shared.authorize(url)
            draft.dataRoot = url.path
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
        case "agent_work_queue": L10n("Role work queue")
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
