import SwiftUI
import Testing
import Observation
import CorptieClientCore
@testable import CorptieConversation
#if os(macOS)
import AppKit

@MainActor struct ProviderCardLayoutTests {
    @Observable final class ConfigurationState {
        var modelTitle = "Model"
        var busy = false
        var error: String?
    }
    private struct StatefulProvider: View {
        let state: ConfigurationState
        var body: some View {
            let provider = ClientDetailConfiguration.Selection(id: "provider", title: "Provider", choices: [], canSelect: false)
            let model = ClientDetailConfiguration.Selection(id: "model", title: state.modelTitle, choices: [], canSelect: false)
            DetailWidgetLayout(sizes: [.medium], naturalHeightIndices: [0]) {
                ConversationDetailProviderCard(configuration: .init(provider: provider, model: model, reasoning: provider,
                    busy: state.busy, error: state.error), scope: "test", select: { _, _ in }, reload: {})
                    .detailWidget(.medium)
            }.frame(width: 220).fixedSize(horizontal: false, vertical: true)
        }
    }

    @Test func modelAndInlineStatusUpdatesInvalidateNaturalHeightAtTheSameWidth() async throws {
        let state = ConfigurationState()
        let host = NSHostingView(rootView: StatefulProvider(state: state))
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 220, height: 600),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { window.contentView = nil; window.close() }
        func height() async throws -> CGFloat {
            // Drain the observable update without replacing the root view or
            // changing width: exercise the existing Layout cache's invalidation.
            try await Task.sleep(for: .milliseconds(20))
            host.layoutSubtreeIfNeeded()
            let height = host.fittingSize.height
            print("PROVIDER_STATE title=\(state.modelTitle) busy=\(state.busy) error=\(state.error != nil) height=\(height)")
            return height
        }
        let baseline = try await height()
        state.modelTitle = "Example Model With A Long Fully Visible Name And Extended Context Window"
        #expect(try await height() > baseline)
        state.modelTitle = "Model"
        #expect(abs(try await height() - baseline) <= 1)
        state.busy = true
        let busy = try await height()
        #expect(busy > baseline)
        state.error = "Configuration could not be updated. Please refresh the available models and try again."
        #expect(try await height() > busy)
        state.busy = false
        #expect(try await height() > baseline)
        state.error = nil
        #expect(abs(try await height() - baseline) <= 1)
    }

    @Test func longModelNameUsesAdditionalHeightAtNarrowWidths() {
        func height(model: String, width: CGFloat, canSelect: Bool = false) -> CGFloat {
            let provider = ClientDetailConfiguration.Selection(id: "provider", title: "Provider", choices: [], canSelect: false)
            let selection = ClientDetailConfiguration.Selection(id: "model", title: model,
                choices: [.init(id: "model", title: model)], canSelect: canSelect)
            let host = NSHostingView(rootView: ConversationDetailProviderCard(
                configuration: .init(provider: provider, model: selection, reasoning: provider),
                scope: "test", select: { _, _ in Issue.record("Layout must not select a configuration") }, reload: {})
                .frame(width: width).fixedSize(horizontal: false, vertical: true))
            host.layoutSubtreeIfNeeded()
            return host.fittingSize.height
        }
        let longName = "Example Model With A Long Fully Visible Name And Extended Context Window"
        for width: CGFloat in [220, 300] {
            for canSelect in [false, true] {
                let short = height(model: "Model", width: width, canSelect: canSelect)
                let long = height(model: longName, width: width, canSelect: canSelect)
                print("PROVIDER_LAYOUT width=\(width) selectable=\(canSelect) short=\(short) long=\(long)")
                #expect(long > short)
                #expect(short > 150 && short < 260)
            }
        }
        #expect(height(model: longName, width: 220) >= height(model: longName, width: 300))
    }
}
#endif
