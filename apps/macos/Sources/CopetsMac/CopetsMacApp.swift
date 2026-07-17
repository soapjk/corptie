import AppKit
import SwiftUI

@main
struct CorptieMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            SettingsView()
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let backendClient = BackendClient.shared
    private var panelController: FloatingPanelController?
    private var detachedSessionManager: DetachedSessionManager?
    private var completionSoundManager: SessionCompletionSoundManager?
    private var statusItem: NSStatusItem?
    private var statusMenu: NSMenu?
    private var settingsWindow: NSWindow?
    private var collaborationWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        configureApplicationIcon()

        showWelcomePromptIfNeeded()
        CorptieBackendSupervisor.ensureProductionBackendStarted()

        let detachedManager = DetachedSessionManager(client: backendClient, showMain: { [weak self] in
            self?.panelController?.show()
        }, isMainVisible: { [weak self] in
            self?.panelController?.isVisible ?? false
        }) { [weak self] session in
            self?.panelController?.show()
            self?.backendClient.select(session: session)
        }
        let controller = FloatingPanelController(client: backendClient, detachedSessionManager: detachedManager)
        let soundManager = SessionCompletionSoundManager(client: backendClient)
        controller.show()
        panelController = controller
        detachedSessionManager = detachedManager
        completionSoundManager = soundManager
        soundManager.start()
        installStatusItem()

        backendClient.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        detachedSessionManager?.closeAll()
        completionSoundManager?.stop()
        backendClient.stop()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel()
        return true
    }

    private func configureApplicationIcon() {
        guard let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
              let icon = NSImage(contentsOf: iconURL) else {
            return
        }
        NSApp.applicationIconImage = icon
    }

    private func showWelcomePromptIfNeeded() {
        let key = "corptie.hasAcknowledgedWelcomeSetup"

        guard !CorptieAppEnvironment.userDefaults.bool(forKey: key) else {
            return
        }

        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Welcome to Corptie"
        alert.informativeText = """
        Corptie keeps your agent tasks visible in a floating panel while you work on other things.

        Your session data is stored in ~/Library/Application Support/Corptie/ and stays on this machine.

        If you ever need to run tasks in a workspace on an external drive, you may need to grant Corptie Full Disk Access in System Settings.
        """
        alert.addButton(withTitle: "Get Started")
        CorptieAppEnvironment.userDefaults.set(true, forKey: key)
        CorptieAppEnvironment.userDefaults.synchronize()
        alert.runModal()
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: CorptieAppEnvironment.isDevelopment ? "hammer" : "sparkles", accessibilityDescription: CorptieAppEnvironment.appName)
        item.button?.imagePosition = .imageOnly
        item.button?.target = self
        item.button?.action = #selector(handleStatusItemClick)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Show \(CorptieAppEnvironment.appName)", action: #selector(showPanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Collaboration...", action: #selector(openCollaboration), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Settings...", action: #selector(openSettings), keyEquivalent: ","))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit \(CorptieAppEnvironment.appName)", action: #selector(quit), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        statusMenu = menu
        statusItem = item
    }

    @objc private func handleStatusItemClick() {
        guard NSApp.currentEvent?.type == .rightMouseUp,
              let event = NSApp.currentEvent,
              let button = statusItem?.button,
              let statusMenu else {
            showPanel()
            return
        }

        NSMenu.popUpContextMenu(statusMenu, with: event, for: button)
    }

    @objc private func showPanel() {
        NSApp.activate(ignoringOtherApps: true)
        panelController?.show()
    }

    @objc private func openSettings() {
        NSApp.activate(ignoringOtherApps: true)

        if let settingsWindow {
            settingsWindow.makeKeyAndOrderFront(nil)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 380),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "\(CorptieAppEnvironment.appName) Settings"
        window.center()
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: SettingsView {
            window.close()
        })
        window.makeKeyAndOrderFront(nil)
        settingsWindow = window
    }

    @objc private func openCollaboration() {
        NSApp.activate(ignoringOtherApps: true)

        if let collaborationWindow {
            collaborationWindow.makeKeyAndOrderFront(nil)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "\(CorptieAppEnvironment.appName) Collaboration"
        window.center()
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: CollaborationView())
        window.makeKeyAndOrderFront(nil)
        collaborationWindow = window
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

@MainActor
enum CorptieBackendSupervisor {
    private static let label = "com.corptie.backend"

    static func ensureProductionBackendStarted() {
        guard !CorptieAppEnvironment.isDevelopment else {
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
            let installedPlist = launchAgentsDir.appendingPathComponent("\(label).plist")

            try fileManager.createDirectory(at: launchAgentsDir, withIntermediateDirectories: true)
            if !fileManager.contentsEqual(atPath: bundledPlist.path, andPath: installedPlist.path) {
                _ = try? runLaunchctl(["bootout", "gui/\(getuid())", installedPlist.path])
                if fileManager.fileExists(atPath: installedPlist.path) {
                    try fileManager.removeItem(at: installedPlist)
                }
                try fileManager.copyItem(at: bundledPlist, to: installedPlist)
            }

            if !isLaunchAgentLoaded() {
                try runLaunchctl(["bootstrap", "gui/\(getuid())", installedPlist.path])
            }
            _ = try? runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(label)"])
        } catch {
            NSLog("Corptie backend startup failed: \(error.localizedDescription)")
        }
    }

    private static func isLaunchAgentLoaded() -> Bool {
        (try? runLaunchctl(["print", "gui/\(getuid())/\(label)"])) != nil
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

        var errorDescription: String? {
            switch self {
            case let .launchctlFailed(command, output):
                return "launchctl \(command) failed: \(output)"
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

struct SettingsView: View {
    @ObservedObject private var backendClient = BackendClient.shared
    var onClose: () -> Void = {}
    @State private var dataDir = ""
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

    var body: some View {
        VStack(spacing: 12) {
            TabView {
                generalSettingsTab
                    .tabItem {
                        Label("General", systemImage: "gearshape")
                    }

                proxySettingsTab
                    .tabItem {
                        Label("Proxy", systemImage: "network")
                    }

                feishuSettingsTab
                    .tabItem {
                        Label("Gateway", systemImage: "message.badge.filled.fill")
                    }
            }

            Divider()

            HStack {
                Spacer()
                Button("Save") {
                    Task {
                        await saveAllSettings()
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(backendClient.isUpdatingSettings || dataDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 560, height: 580)
        .task {
            await backendClient.loadSettings()
            await backendClient.loadFeishuBots()
            await backendClient.loadFeishuProfiles()
            selectDefaultFeishuProfileIfNeeded()
            await backendClient.loadModels(for: "codex-pty")
            if dataDir.isEmpty {
                dataDir = backendClient.settings?.dataDir ?? defaultDataDirectory
            }
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
                dataDir = settings.dataDir
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
    }

    private var generalSettingsTab: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Storage")
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text("\(CorptieAppEnvironment.displayName) environment on port \(CorptieAppEnvironment.backendPort).")
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
                Text("Data Directory")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                HStack(spacing: 8) {
                    TextField("Choose a data directory", text: $dataDir)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))

                    Button {
                        chooseDataDirectory()
                    } label: {
                        Image(systemName: "folder")
                    }
                    .help("Choose data directory")
                }
            }

            if let settings = backendClient.settings {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Database")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Text(settings.dbPath)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .textSelection(.enabled)
                        .lineLimit(2)
                }
                if let configPath = settings.configPath {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Config")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        Text(configPath)
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(CorptiePalette.secondaryText)
                            .textSelection(.enabled)
                            .lineLimit(2)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Codex Backend")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                Picker("", selection: $codexBackend.mode) {
                    Text("App Server").tag("app-server")
                    Text("PTY Legacy").tag("pty")
                }
                .pickerStyle(.segmented)
                .help("Choose how new Codex sessions are created. App Server uses Codex JSON-RPC; PTY Legacy drives the terminal UI.")
                Text(codexBackend.mode == "app-server" ? "New Codex sessions use the official Codex app-server protocol." : "New Codex sessions use the legacy terminal adapter.")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)
            }

            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Code Diff Tool")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Text("Used when you review files changed by a Codex reply.")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                Picker("", selection: $codeDiff.tool) {
                    Text("Automatic").tag("automatic")
                    Text("Git Difftool").tag("git-difftool")
                    Text("FileMerge").tag("filemerge")
                    Text("Visual Studio Code").tag("vscode")
                    Text("Kaleidoscope").tag("kaleidoscope")
                    Text("Beyond Compare").tag("beyond-compare")
                    Text("Sublime Merge").tag("sublime-merge")
                }
                .labelsHidden()
                .frame(width: 180)
            }

            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Toggle("Use LLM-enhanced interactions", isOn: llmInteractionEnabled)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Spacer()
                }
                .help("Enable model-assisted parsing for terminal choice prompts")

                if choiceParser.provider != "disabled" {
                    Picker("", selection: $choiceParser.provider) {
                        Text("Local Agent").tag("local-agent")
                        Text("OpenAI-compatible").tag("openai")
                    }
                    .pickerStyle(.segmented)
                    .help("Choose how Corptie parses terminal choice prompts")

                    if choiceParser.provider == "openai" {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("Base URL, e.g. https://api.openai.com/v1", text: $choiceParser.openaiBaseURL)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                            TextField("OpenAI API key", text: $choiceParser.openaiApiKey)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                            TextField("Parser model", text: $choiceParser.openaiModel)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("Agent command", text: $choiceParser.localCommand)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                            TextField("Fixed arguments", text: $choiceParser.localArgs)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                            ParserModelPicker(
                                title: "Model",
                                selection: $choiceParser.localModel,
                                defaultModel: "",
                                allowAutomatic: true
                            )
                        }
                    }

                    HStack {
                        Text("Timeout")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        Stepper("\(choiceParser.timeoutMs / 1000)s", value: $choiceParser.timeoutMs, in: 1000...60000, step: 1000)
                            .font(.system(size: 11, weight: .medium))
                    }
                }

                HStack(spacing: 8) {
                    Button("Test") {
                        Task {
                            await testChoiceParser()
                        }
                    }
                    .disabled(choiceParser.provider == "disabled" || backendClient.isTestingChoiceParser || backendClient.isUpdatingSettings)

                    Button("Confirm") {
                        Task {
                            await confirmChoiceParser()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!isChoiceParserDirty || backendClient.isTestingChoiceParser || backendClient.isUpdatingSettings)

                    if isChoiceParserDirty {
                        Button("Cancel") {
                            choiceParser = savedChoiceParser
                            choiceParserStatus = .idle
                        }
                    }

                    if backendClient.isTestingChoiceParser {
                        ProgressView()
                            .controlSize(.small)
                    }

                    Text(choiceParserStatus.message)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(choiceParserStatus.color)
                }
                .onChange(of: choiceParser) { _, _ in
                    choiceParserStatus = .idle
                }
            }

            if let error = backendClient.lastError {
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

    private var proxySettingsTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Agent Proxy")
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text("Proxy settings are applied per agent when Corptie launches agent processes.")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                if backendClient.isUpdatingSettings {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ProxyProfileEditor(
                        title: "Codex CLI",
                        subtitle: "Used by new Codex PTY sessions and resumed Codex sessions.",
                        profile: $agentProxy.codex
                    )

                    ProxyProfileEditor(
                        title: "Choice Parser",
                        subtitle: "Used by the Local Agent choice parser test and parsing process.",
                        profile: $agentProxy.choiceParser
                    )

                    ProxyProfileEditor(
                        title: "Generic PTY Agent",
                        subtitle: "Used by custom PTY agents launched from the advanced task form.",
                        profile: $agentProxy.pty
                    )
                }
                .padding(.vertical, 2)
            }

            if let error = backendClient.lastError {
                Text(error)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }

        }
    }

    private var feishuSettingsTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Feishu Gateway")
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text("Connect trusted Feishu users to sessions on this Mac.")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                if backendClient.isUpdatingFeishu {
                    ProgressView()
                        .controlSize(.small)
                }
                Button {
                    Task { await backendClient.loadFeishuBots() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Refresh Feishu bots")
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Trusted Workspaces")
                                    .font(.system(size: 13, weight: .bold))
                                Text("These folders appear first when a Feishu user creates a session. Paths used by existing sessions are included automatically.")
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(CorptiePalette.secondaryText)
                            }
                            Spacer()
                            Button("Add Folder…") {
                                addTrustedWorkspace()
                            }
                            .controlSize(.small)
                        }

                        if gateway.trustedWorkspaces.isEmpty {
                            Text("No pinned workspaces. Existing and recent session folders remain available in Feishu.")
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
                                    .help("Remove trusted workspace")
                                }
                            }
                        }
                    }
                    .padding(12)
                    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                    if backendClient.feishuBots.isEmpty {
                        ContentUnavailableView(
                            "No Feishu Bots",
                            systemImage: "message.badge",
                            description: Text("Add a lark-cli profile below. A bot stays stopped until you explicitly enable it.")
                        )
                        .frame(maxWidth: .infinity, minHeight: 150)
                    } else {
                        ForEach(backendClient.feishuBots) { bot in
                            feishuBotCard(bot)
                        }
                    }

                    Divider()

                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Add Bot")
                                .font(.system(size: 13, weight: .bold))
                            Spacer()
                            Link("Create or configure in Feishu Open Platform", destination: URL(string: "https://open.feishu.cn/app")!)
                                .font(.system(size: 10, weight: .semibold))
                        }
                        Text("Feishu requires the enterprise app and bot capability to be created and published in its developer console first. Corptie connects that existing app to local sessions.")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        Picker("", selection: $feishuAddMode) {
                            Text("App Credentials").tag("credentials")
                            Text("Existing CLI Profile").tag("profile")
                        }
                        .pickerStyle(.segmented)
                        if feishuAddMode == "credentials" {
                            TextField("Feishu App ID", text: $newFeishuAppId)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                            SecureField("Feishu App Secret", text: $newFeishuAppSecret)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                        } else if availableFeishuProfiles.isEmpty {
                            Text("No unused lark-cli Profiles are available. Add a Profile in lark-cli or remove its existing Gateway bot first.")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(CorptiePalette.secondaryText)
                        } else {
                            Picker("lark-cli Profile", selection: $newFeishuProfile) {
                                ForEach(availableFeishuProfiles) { profile in
                                    Text(profile.active ? "\(profile.name) (Active)" : profile.name)
                                        .tag(profile.name)
                                }
                            }
                            .pickerStyle(.menu)
                        }
                        HStack {
                            Text(feishuAddMode == "credentials"
                                ? "The App Secret is passed directly to lark-cli encrypted storage and is never saved in the Corptie database."
                                : "The existing Profile and its credentials remain owned by lark-cli and are never removed by Corptie.")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(CorptiePalette.secondaryText)
                            Spacer()
                            Button("Add Bot") {
                                Task {
                                    let added = if feishuAddMode == "credentials" {
                                        await backendClient.addFeishuBot(appId: newFeishuAppId, appSecret: newFeishuAppSecret)
                                    } else {
                                        await backendClient.addFeishuBot(profile: newFeishuProfile)
                                    }
                                    if added {
                                        newFeishuAppId = ""
                                        newFeishuAppSecret = ""
                                        await backendClient.loadFeishuProfiles()
                                        selectDefaultFeishuProfileIfNeeded()
                                    }
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!canAddFeishuBot || backendClient.isUpdatingFeishu)
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
                        Image(systemName: "message.badge")
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                    .frame(width: 30, height: 30)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(bot.remoteName ?? "Loading Feishu bot identity…")
                        .font(.system(size: 13, weight: .bold))
                    if let remoteName = bot.remoteName {
                        Text("Search in Feishu: \(remoteName)")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.blue)
                    }
                    Text("App ID: \(bot.appId ?? "Unknown") · Profile: \(bot.profile)")
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .textSelection(.enabled)
                }
                Spacer()
                Text(feishuConnectionLabel(bot))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(bot.connectionStatus == "connected" ? .green : CorptiePalette.secondaryText)
                Toggle("", isOn: Binding(
                    get: { bot.enabled },
                    set: { enabled in
                        Task { await backendClient.setFeishuBotEnabled(bot, enabled: enabled) }
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
                Label(bot.bindings.isEmpty ? "Not paired" : "Paired", systemImage: bot.bindings.isEmpty ? "person.crop.circle.badge.questionmark" : "person.crop.circle.badge.checkmark")
                if let assignment = bot.assignment {
                    Label(assignment.sessionId, systemImage: "link")
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    Label("No session selected", systemImage: "link.badge.plus")
                }
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(CorptiePalette.secondaryText)

            if let pairing = feishuPairingCodes[bot.id] {
                HStack(spacing: 8) {
                    Text("Pairing code")
                        .font(.system(size: 11, weight: .semibold))
                    Text(pairing.code)
                        .font(.system(size: 18, weight: .bold, design: .monospaced))
                        .textSelection(.enabled)
                    Text("expires \(pairing.expiresAt)")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                .padding(.vertical, 4)
            }

            HStack(spacing: 8) {
                Button("Generate Pairing Code") {
                    Task {
                        if case .success(let pairing) = await backendClient.createFeishuPairingCode(for: bot) {
                            feishuPairingCodes[bot.id] = pairing
                        }
                    }
                }
                .disabled(!bot.enabled)
                if let binding = bot.bindings.first {
                    Button("Unpair") {
                        Task { await backendClient.revokeFeishuBinding(binding) }
                    }
                }
                if bot.assignment != nil {
                    Button("Release Session") {
                        Task { await backendClient.releaseFeishuSession(for: bot) }
                    }
                }
                Spacer()
                Button("Delete", role: .destructive) {
                    Task {
                        if await backendClient.deleteFeishuBot(bot) {
                            feishuPairingCodes.removeValue(forKey: bot.id)
                            selectDefaultFeishuProfileIfNeeded()
                        }
                    }
                }
            }
            .controlSize(.small)
            .disabled(backendClient.isUpdatingFeishu)
        }
        .padding(12)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func feishuConnectionLabel(_ bot: FeishuBot) -> String {
        switch bot.connectionStatus {
        case "connected": "Connected"
        case "connecting": "Connecting"
        case "error": "Error"
        default: "Stopped"
        }
    }

    private var availableFeishuProfiles: [FeishuProfile] {
        let usedProfiles = Set(backendClient.feishuBots.map(\.profile))
        return backendClient.feishuProfiles.filter { !usedProfiles.contains($0.name) }
    }

    private var canAddFeishuBot: Bool {
        if feishuAddMode == "profile" {
            return availableFeishuProfiles.contains { $0.name == newFeishuProfile }
        }
        return !newFeishuAppId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !newFeishuAppSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
        panel.prompt = "Add Workspace"
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            let path = url.standardizedFileURL.path
            if !gateway.trustedWorkspaces.contains(path) {
                gateway.trustedWorkspaces.append(path)
            }
        }
    }

    private func saveAllSettings() async {
        if await backendClient.updateSettings(
            dataDir: dataDir,
            choiceParser: choiceParser,
            codexBackend: codexBackend,
            codeDiff: codeDiff,
            agentProxy: agentProxy,
            gateway: gateway
        ) {
            savedChoiceParser = choiceParser
            savedCodexBackend = codexBackend
            savedCodeDiff = codeDiff
            savedAgentProxy = agentProxy
            savedGateway = gateway
            choiceParserStatus = .saved
            onClose()
        }
    }

    private func confirmChoiceParser() async {
        choiceParserStatus = .idle
        if await backendClient.updateSettings(dataDir: dataDir, choiceParser: choiceParser, codexBackend: codexBackend, codeDiff: codeDiff, agentProxy: agentProxy, gateway: gateway) {
            savedChoiceParser = choiceParser
            savedCodexBackend = codexBackend
            savedCodeDiff = codeDiff
            savedAgentProxy = agentProxy
            savedGateway = gateway
            choiceParserStatus = .saved
        } else {
            choiceParserStatus = .failed(backendClient.lastError ?? "Save failed")
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

    private func chooseDataDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = URL(fileURLWithPath: dataDir.isEmpty ? defaultDataDirectory : dataDir)

        if panel.runModal() == .OK, let url = panel.url {
            dataDir = url.path
        }
    }

    private var defaultDataDirectory: String {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return support?.appendingPathComponent(CorptieAppEnvironment.appSupportFolderName, isDirectory: true).path ?? NSHomeDirectory()
    }
}

private struct ProxyProfileEditor: View {
    let title: String
    let subtitle: String
    @Binding var profile: AgentProxyProfile

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(CorptiePalette.primaryText)
                    Text(subtitle)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                Toggle("", isOn: $profile.enabled)
                    .labelsHidden()
            }

            if profile.enabled {
                VStack(alignment: .leading, spacing: 8) {
                    proxyField("HTTP_PROXY", text: $profile.httpProxy, placeholder: "http://127.0.0.1:7890")
                    proxyField("HTTPS_PROXY", text: $profile.httpsProxy, placeholder: "http://127.0.0.1:7890")
                    proxyField("ALL_PROXY", text: $profile.allProxy, placeholder: "socks5h://127.0.0.1:7890")
                    proxyField("NO_PROXY", text: $profile.noProxy, placeholder: AgentProxyProfile.defaults.noProxy)
                }
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.white.opacity(0.07))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        )
    }

    private func proxyField(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(CorptiePalette.secondaryText)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
        }
    }
}

private enum ChoiceParserStatus: Equatable {
    case idle
    case passed(String)
    case saved
    case failed(String)

    var message: String {
        switch self {
        case .idle:
            ""
        case .passed(let text):
            text
        case .saved:
            "Saved"
        case .failed(let text):
            text
        }
    }

    var color: Color {
        switch self {
        case .idle:
            CorptiePalette.secondaryText
        case .passed, .saved:
            CorptiePalette.connected
        case .failed:
            .red
        }
    }
}

private struct ParserModelPicker: View {
    @ObservedObject private var backendClient = BackendClient.shared
    let title: String
    @Binding var selection: String
    let defaultModel: String
    let allowAutomatic: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CorptiePalette.secondaryText)

            if backendClient.codexModels.isEmpty {
                TextField(defaultModel.isEmpty ? "Automatic" : defaultModel, text: $selection)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
            } else {
                Picker("", selection: normalizedSelection) {
                    if allowAutomatic {
                        Text("Auto").tag("")
                    }
                    ForEach(sortedModels) { model in
                        Text(model.name).tag(model.id)
                    }
                    if shouldShowCustom {
                        Text("Custom: \(selection)").tag(selection)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .help("Choose parser model")
            }
        }
    }

    private var sortedModels: [CodexModel] {
        backendClient.codexModels.sorted { lhs, rhs in
            score(lhs) < score(rhs)
        }
    }

    private var shouldShowCustom: Bool {
        !selection.isEmpty && !backendClient.codexModels.contains { $0.id == selection }
    }

    private var normalizedSelection: Binding<String> {
        Binding(
            get: {
                if selection.isEmpty {
                    return allowAutomatic ? "" : defaultModel
                }
                return selection
            },
            set: { selection = $0 }
        )
    }

    private func score(_ model: CodexModel) -> Int {
        let id = model.id.lowercased()
        let name = model.name.lowercased()
        if id.contains("mini") || name.contains("mini") { return 0 }
        if id.contains("spark") || name.contains("spark") { return 1 }
        if id.contains("fast") || name.contains("fast") { return 2 }
        return 10
    }
}
