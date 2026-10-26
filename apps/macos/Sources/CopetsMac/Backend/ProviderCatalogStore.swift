import Combine
import Foundation
import CorptieClientCore

/// Provider discovery and model loading have one owner, separate from Session updates.
@MainActor
final class ProviderCatalogStore: ObservableObject {
    @Published private(set) var codexModels: [CodexModel] = []
    @Published private(set) var agentProviders: [AgentProviderDescriptor] = []
    @Published private(set) var defaultSessionProviderId: String?
    @Published private(set) var codexDefaultModel: String?
    @Published private(set) var codexDefaultReasoningLevel: String?
    @Published private(set) var loadedModelProvider: String?
    @Published private(set) var isLoadingCodexModels = false

    private let api: ProviderCatalogAPI
    private let publishError: (String?) -> Void

    /// Historic storage names are kept for existing callers. Detail never
    /// presents another Provider's catalog while a new catalog is loading.
    func models(for provider: String?) -> [CodexModel] {
        matchesLoadedProvider(provider) ? codexModels : []
    }
    func defaultReasoning(for provider: String?) -> String? {
        matchesLoadedProvider(provider) ? codexDefaultReasoningLevel : nil
    }
    func defaultModel(for provider: String?) -> String? {
        matchesLoadedProvider(provider) ? codexDefaultModel : nil
    }
    private func matchesLoadedProvider(_ provider: String?) -> Bool {
        guard let provider, let loadedModelProvider else { return false }
        if provider == loadedModelProvider { return true }
        guard let canonical = agentProviders.canonicalProviderId(for: provider) else { return false }
        return canonical == agentProviders.canonicalProviderId(for: loadedModelProvider)
    }

    init(baseURL: URL, urlSession: URLSession = .shared, publishError: @escaping (String?) -> Void) {
        self.api = ProviderCatalogAPI(baseURL: baseURL, urlSession: urlSession)
        self.publishError = publishError
    }

    func loadProviders() async {
        do {
            let catalog = try await api.providers()
            agentProviders = catalog.providers
            defaultSessionProviderId = catalog.providers.canonicalProviderId(for: catalog.defaultProviderId)
            publishError(nil)
        } catch {
            publishError(error.localizedDescription)
        }
    }

    func providerDisplayName(for providerIdentity: String?) -> String? {
        guard let providerIdentity else { return nil }
        let fallback = providerIdentity.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !fallback.isEmpty else { return nil }
        return agentProviders.displayName(for: fallback) ?? fallback
    }

    func loadModels(for provider: String, forceRefresh: Bool = false) async {
        if isLoadingCodexModels {
            return
        }
        isLoadingCodexModels = true
        defer { isLoadingCodexModels = false }

        do {
            let decoded = try await api.models(for: provider, forceRefresh: forceRefresh)
            loadedModelProvider = provider
            codexDefaultModel = decoded.currentModel
            codexDefaultReasoningLevel = decoded.currentReasoningLevel
            codexModels = decoded.models
            publishError(nil)
        } catch {
            publishError(error.localizedDescription)
        }
    }
}
