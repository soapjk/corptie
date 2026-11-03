import AppKit
import SwiftUI
import CorptieConversation

struct ProxySettingsTab: View {
    let backendClient: BackendClient
    @Binding var agentProxy: AgentProxySettings

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    SettingsSectionHeading(title: L10n("Agent Proxy"), mode: L10n("Requires Save Settings"))
                    Text(L10n("Proxy settings are applied per agent when Corptie launches agent processes."))
                        .font(WorkbenchTypography.font(for: .help))
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
                        title: L10n("Codex CLI"),
                        subtitle: L10n("Used by new Codex PTY sessions and resumed Codex sessions."),
                        profile: $agentProxy.codex
                    )

                    ProxyProfileEditor(
                        title: L10n("Choice Parser"),
                        subtitle: L10n("Used by the Local Agent choice parser test and parsing process."),
                        profile: $agentProxy.choiceParser
                    )

                    ProxyProfileEditor(
                        title: L10n("Generic PTY Agent"),
                        subtitle: L10n("Used by custom PTY agents launched from the advanced task form."),
                        profile: $agentProxy.pty
                    )
                }
                .padding(.vertical, 2)
            }


        }
    }
}
