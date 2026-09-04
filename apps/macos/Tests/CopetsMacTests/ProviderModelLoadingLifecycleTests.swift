import Foundation
import Testing

struct ProviderModelLoadingLifecycleTests {
    @Test
    func startupDoesNotWaitForProviderModelDiscovery() throws {
        let source = try backendClientSource()

        let start = try #require(source.range(of: "    func start() {"))
        let stop = try #require(source.range(
            of: "    func stop() {",
            range: start.upperBound..<source.endIndex
        ))
        let startupBody = source[start.lowerBound..<stop.lowerBound]
        #expect(startupBody.contains("await loadProviders()"))
        #expect(!startupBody.contains("loadModels(for:"))

        let storeReady = try #require(source.range(of: "if eventName == \"BackendStoreReady\""))
        let replayRequired = try #require(source.range(
            of: "if eventName == \"EventReplayRequired\"",
            range: storeReady.upperBound..<source.endIndex
        ))
        let storeReadyBody = source[storeReady.lowerBound..<replayRequired.lowerBound]
        #expect(storeReadyBody.contains("await loadProviders()"))
        #expect(!storeReadyBody.contains("loadModels(for:"))
    }

    @Test
    func modelDiscoveryRemainsAvailableOnDemand() throws {
        let backendClient = try backendClientSource()
        #expect(backendClient.contains("func loadModelsForSelectedSession(forceRefresh: Bool = false) async"))
        #expect(backendClient.contains("await loadModels(for: provider, forceRefresh: forceRefresh)"))

        let floatingRootView = try source(named: "FloatingRootView.swift")
        #expect(floatingRootView.contains("private func loadModelsForCurrentAgent()"))
        #expect(floatingRootView.contains("await backendClient.loadModels(for: provider)"))

        let appSource = try source(named: "CopetsMacApp.swift")
        #expect(appSource.contains("await backendClient.loadModels(for: \"codex-pty\")"))
    }

    private func backendClientSource() throws -> String {
        try source(named: "BackendClient.swift")
    }

    private func source(named name: String) throws -> String {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/CopetsMac/\(name)"),
            encoding: .utf8
        )
    }
}
