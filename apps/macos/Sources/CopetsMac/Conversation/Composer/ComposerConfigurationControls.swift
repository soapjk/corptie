import SwiftUI
import CorptieConversation

struct ComposerPermissionChoice: Equatable {
    let sandbox: String
    let approval: String
    static let choices = [
        Self(sandbox: "read-only", approval: "on-request"),
        Self(sandbox: "workspace-write", approval: "on-request"),
        Self(sandbox: "danger-full-access", approval: "never")
    ]
    @MainActor var title: String {
        switch sandbox {
        case "read-only": L10n("Read Only")
        case "workspace-write": L10n("Workspace Write")
        case "danger-full-access": L10n("Full Access")
        default: L10n("Permission")
        }
    }
}

struct ComposerPermissionMenu: View {
    let selection: ComposerPermissionChoice
    let disabled: Bool
    let select: (ComposerPermissionChoice) -> Void
    var body: some View {
        Menu {
            ForEach(ComposerPermissionChoice.choices, id: \.sandbox) { choice in
                Button { select(choice) } label: {
                    HStack {
                        Text(choice.title)
                        if choice == selection { Image(systemName: "checkmark") }
                    }
                }
            }
        } label: {
            Label(selection.title, systemImage: "shield")
                .font(.system(size: 12)).lineLimit(1)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .fixedSize().disabled(disabled)
        .accessibilityLabel(L10n("Permission"))
    }
}

struct SessionComposerPermissionControl: View {
    let session: TaskSession
    let backend: BackendClient
    let enabled: Bool
    @State private var saving = false
    @State private var error: String?
    var body: some View {
        if session.actions?.updatePermissions != nil,
           session.actions?.updatePermissions?.reason != "CAPABILITY_UNSUPPORTED" {
            ComposerPermissionMenu(selection: .init(sandbox: session.external?.sandbox ?? "workspace-write",
                approval: session.external?.approvalPolicy ?? "on-request"),
                disabled: !enabled || saving || session.actions?.updatePermissions?.available != true) { choice in
                    guard !saving, enabled else { return }
                    saving = true
                    Task { @MainActor in
                        defer { saving = false }
                        do {
                            _ = try await backend.configureComposer(session: session,
                                route: "permissions", values: ["sandbox": choice.sandbox, "approvalPolicy": choice.approval])
                        } catch { self.error = error.localizedDescription }
                    }
                }
                .alert(L10n("Permission"), isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                    Button(L10n("OK")) { error = nil }
                } message: { Text(error ?? "") }
        }
    }
}

enum ComposerServiceTier {
    static func fastID(_ tiers: [CodexServiceTier]?) -> String? {
        tiers?.first(where: { $0.id == "fast" })?.id
            ?? tiers?.first(where: { $0.id == "priority" })?.id
    }
    static func isFast(_ tier: String?) -> Bool { tier == "fast" || tier == "priority" }
}
