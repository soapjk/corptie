import AppKit
import SwiftUI

@main
struct CopetsMacApp: App {
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
    private var statusItem: NSStatusItem?
    private var settingsWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        showWelcomePromptIfNeeded()

        let detachedManager = DetachedSessionManager(client: backendClient) { [weak self] session in
            self?.panelController?.show()
            self?.backendClient.select(session: session)
        }
        let controller = FloatingPanelController(client: backendClient, detachedSessionManager: detachedManager)
        controller.show()
        panelController = controller
        detachedSessionManager = detachedManager
        installStatusItem()

        backendClient.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        detachedSessionManager?.closeAll()
        backendClient.stop()
    }

    private func showWelcomePromptIfNeeded() {
        let key = "copets.hasAcknowledgedWelcomeSetup"

        guard !CopetsAppEnvironment.userDefaults.bool(forKey: key) else {
            return
        }

        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Welcome to Copets"
        alert.informativeText = """
        Copets keeps your agent tasks visible in a floating panel while you work on other things.

        Your session data is stored in ~/Library/Application Support/Copets/ and stays on this machine.

        If you ever need to run tasks in a workspace on an external drive, you may need to grant Copets Full Disk Access in System Settings.
        """
        alert.addButton(withTitle: "Get Started")
        CopetsAppEnvironment.userDefaults.set(true, forKey: key)
        CopetsAppEnvironment.userDefaults.synchronize()
        alert.runModal()
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: CopetsAppEnvironment.isDevelopment ? "hammer" : "sparkles", accessibilityDescription: CopetsAppEnvironment.appName)
        item.button?.imagePosition = .imageOnly

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Show \(CopetsAppEnvironment.appName)", action: #selector(showPanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Settings...", action: #selector(openSettings), keyEquivalent: ","))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit \(CopetsAppEnvironment.appName)", action: #selector(quit), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        item.menu = menu
        statusItem = item
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
        window.title = "\(CopetsAppEnvironment.appName) Settings"
        window.center()
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: SettingsView())
        window.makeKeyAndOrderFront(nil)
        settingsWindow = window
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

enum CopetsPermissionManager {
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
    @AppStorage("floatingPanelTransparency", store: CopetsAppEnvironment.userDefaults) private var panelTransparency = 0.45
    @State private var dataDir = ""
    @State private var choiceParser = ChoiceParserSettings.defaults

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Storage")
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text("\(CopetsAppEnvironment.displayName) environment on port \(CopetsAppEnvironment.backendPort).")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CopetsPalette.secondaryText)
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
                    .foregroundStyle(CopetsPalette.secondaryText)
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
                        .foregroundStyle(CopetsPalette.secondaryText)
                    Text(settings.dbPath)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(CopetsPalette.secondaryText)
                        .textSelection(.enabled)
                        .lineLimit(2)
                }
                if let configPath = settings.configPath {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Config")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(CopetsPalette.secondaryText)
                        Text(configPath)
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(CopetsPalette.secondaryText)
                            .textSelection(.enabled)
                            .lineLimit(2)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Choice Parser")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CopetsPalette.secondaryText)

                Picker("", selection: $choiceParser.provider) {
                    Text("Off").tag("disabled")
                    Text("OpenAI API").tag("openai")
                    Text("Local Agent").tag("local-agent")
                }
                .pickerStyle(.segmented)
                .help("Choose how Copets parses terminal choice prompts")

                if choiceParser.provider == "openai" {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("OpenAI API key", text: $choiceParser.openaiApiKey)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                        ParserModelPicker(
                            title: "Parser model",
                            selection: $choiceParser.openaiModel,
                            defaultModel: "gpt-4o-mini",
                            allowAutomatic: false
                        )
                    }
                } else if choiceParser.provider == "local-agent" {
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
                        .foregroundStyle(CopetsPalette.secondaryText)
                    Stepper("\(choiceParser.timeoutMs / 1000)s", value: $choiceParser.timeoutMs, in: 1000...60000, step: 1000)
                        .font(.system(size: 11, weight: .medium))
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Appearance")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(CopetsPalette.secondaryText)
                    Spacer()
                    Text("\(Int(panelTransparency * 100))% transparent")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(CopetsPalette.secondaryText)
                }

                Slider(value: $panelTransparency, in: 0.2...0.75)

                Text("Higher transparency keeps the floating panel lighter while preserving text clarity.")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CopetsPalette.secondaryText)
            }

            if let error = backendClient.lastError {
                Text(error)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }

            HStack {
                Spacer()

                Button("Save") {
                    Task {
                        await backendClient.updateSettings(dataDir: dataDir, choiceParser: choiceParser)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(backendClient.isUpdatingSettings || dataDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 520)
        .task {
            await backendClient.loadSettings()
            await backendClient.loadCodexModels()
            if dataDir.isEmpty {
                dataDir = backendClient.settings?.dataDir ?? defaultDataDirectory
            }
            choiceParser = backendClient.settings?.choiceParser ?? .defaults
        }
        .onChange(of: backendClient.settings) { _, settings in
            if let settings {
                dataDir = settings.dataDir
                choiceParser = settings.choiceParser ?? .defaults
            }
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
        return support?.appendingPathComponent(CopetsAppEnvironment.appSupportFolderName, isDirectory: true).path ?? NSHomeDirectory()
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
                .foregroundStyle(CopetsPalette.secondaryText)

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
