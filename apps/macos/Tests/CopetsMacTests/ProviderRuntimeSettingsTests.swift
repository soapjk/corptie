import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

struct ProviderRuntimeSettingsTests {
    private func projection(_ unsupported: Bool = false) throws -> ProviderRuntimeSettingsProjection {
        let text = unsupported ? """
        {"runtimeDirectory":"/tmp/corptie/runtimes/example","credentialTarget":null,
         "reuseMethod":"unsupported","sourceKinds":[],"candidates":[],"source":null,
         "state":"unsupported","message":"此适配器不支持凭证来源选择。","sourceChanged":false}
        """ : """
        {"runtimeDirectory":"/tmp/corptie/runtimes/example","credentialTarget":"/tmp/corptie/runtimes/example/auth.json",
         "reuseMethod":"synchronize","sourceKinds":["directory","file"],
         "candidates":[{"kind":"directory","path":"/tmp/official"}],
         "source":{"kind":"file","path":"/tmp/custom/credentials.json"},
         "state":"found","message":"已找到凭证，尚未验证连接。","sourceChanged":false}
        """
        return try JSONDecoder().decode(ProviderRuntimeSettingsProjection.self, from: Data(text.utf8))
    }

    @Test @MainActor
    func sourceSettingsAndUnsupportedAdaptersRenderWithoutStartingARequest() throws {
        for unsupported in [false, true] {
            var updates = 0
            let runtime = try projection(unsupported)
            let view = NSHostingView(rootView: ProviderRuntimeSettingsView(providerId: "example", runtime: runtime,
                busy: false, updated: { _ in updates += 1 }).frame(width: 480))
            view.frame = NSRect(x: 0, y: 0, width: 480, height: 900)
            view.layoutSubtreeIfNeeded()
            #expect(updates == 0)
            #expect(view.fittingSize.width <= 480)
            #expect(runtime.sourceKinds.isEmpty == unsupported)
        }
    }

    @Test
    func disabledProviderRetainsCapabilitiesAndCannotBeASwitchTarget() throws {
        let provider = try JSONDecoder().decode(AgentProviderDescriptor.self, from: Data("""
        {"id":"example","displayName":"Example","transport":"stdio","aliases":[],
         "capabilities":["session.create"],"runtime":{"lifecycle":"managed"},
         "configuration":{"fields":[]},"executionEnabled":false}
        """.utf8))
        #expect(provider.supports("session.create"))
        #expect(!provider.isExecutionEnabled)
        #expect([provider].sessionProviderAlternatives(to: "other").isEmpty)
    }
}
