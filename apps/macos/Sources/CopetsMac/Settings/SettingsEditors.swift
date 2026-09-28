import AppKit
import Combine
import os
import QuartzCore
import SwiftUI
import UserNotifications

struct ProxyProfileEditor: View {
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
                Toggle(L10n(""), isOn: $profile.enabled)
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

enum ChoiceParserStatus: Equatable {
    case idle
    case passed(String)
    case saved
    case failed(String)

    @MainActor var message: String {
        switch self {
        case .idle:
            ""
        case .passed(let text):
            text
        case .saved:
            L10n("Saved")
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

struct ParserModelPicker: View {
    @ObservedObject private var modelCatalog = BackendClient.shared.modelCatalog
    let title: String
    @Binding var selection: String
    let defaultModel: String
    let allowAutomatic: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CorptiePalette.secondaryText)

            if modelCatalog.codexModels.isEmpty {
                TextField(defaultModel.isEmpty ? L10n("Automatic") : defaultModel, text: $selection)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
            } else {
                Picker(L10n(""), selection: normalizedSelection) {
                    if allowAutomatic {
                        Text(L10n("Auto")).tag("")
                    }
                    ForEach(sortedModels) { model in
                        Text(model.name).tag(model.id)
                    }
                    if shouldShowCustom {
                        Text(L10nFormat("Custom: %@", selection)).tag(selection)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .help(L10n("Choose parser model"))
            }
        }
    }

    private var sortedModels: [CodexModel] {
        modelCatalog.codexModels.sorted { lhs, rhs in
            score(lhs) < score(rhs)
        }
    }

    private var shouldShowCustom: Bool {
        !selection.isEmpty && !modelCatalog.codexModels.contains { $0.id == selection }
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
