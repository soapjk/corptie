import Combine
import Foundation
import CorptieClientCore

/// Owns only IM gateway inventory and in-flight mutations, independently of chat state.
@MainActor
final class FeishuSettingsStore: ObservableObject {
    @Published private(set) var feishuBots: [FeishuBot] = []
    @Published private(set) var feishuProfiles: [FeishuProfile] = []
    @Published private(set) var isUpdatingFeishu = false

    private let api: FeishuGatewayAPI
    private let currentError: () -> String?
    private let publishError: (String?) -> Void
    private var lastError: String? {
        get { currentError() }
        set { publishError(newValue) }
    }

    init(
        baseURL: URL,
        urlSession: URLSession = .shared,
        currentError: @escaping () -> String?,
        publishError: @escaping (String?) -> Void,
        decodeError: @escaping (Data) -> String?
    ) {
        self.api = FeishuGatewayAPI(baseURL: baseURL, urlSession: urlSession, decodeError: decodeError)
        self.currentError = currentError
        self.publishError = publishError
    }

    func loadFeishuBots() async {
        do {
            feishuBots = try await api.bots()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func loadFeishuProfiles() async {
        do {
            feishuProfiles = try await api.profiles()
            if lastError?.contains("Feishu") == true {
                lastError = nil
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    @discardableResult
    func addFeishuBot(appId: String, appSecret: String) async -> Bool {
        let trimmedAppId = appId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedSecret = appSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedAppId.isEmpty, !trimmedSecret.isEmpty else {
            lastError = L10n("Feishu App ID and App Secret are required.")
            return false
        }
        return await performFeishuMutation(method: "POST", path: "feishu/bots", body: [
            "appId": trimmedAppId,
            "appSecret": trimmedSecret,
            "brand": "feishu"
        ])
    }

    @discardableResult
    func addFeishuBot(profile: String) async -> Bool {
        let trimmedProfile = profile.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProfile.isEmpty else {
            lastError = L10n("lark-cli Profile is required.")
            return false
        }
        return await performFeishuMutation(method: "POST", path: "feishu/bots", body: [
            "profile": trimmedProfile
        ])
    }

    @discardableResult
    func setFeishuBotEnabled(_ bot: FeishuBot, enabled: Bool) async -> Bool {
        await performFeishuMutation(method: "PATCH", path: "feishu/bots/\(bot.id)", body: ["enabled": enabled])
    }

    @discardableResult
    func deleteFeishuBot(_ bot: FeishuBot) async -> Bool {
        await performFeishuMutation(method: "DELETE", path: "feishu/bots/\(bot.id)")
    }

    @discardableResult
    func releaseFeishuSession(for bot: FeishuBot) async -> Bool {
        await performFeishuMutation(method: "DELETE", path: "feishu/bots/\(bot.id)/assignment")
    }

    @discardableResult
    func revokeFeishuBinding(_ binding: FeishuBinding) async -> Bool {
        await performFeishuMutation(method: "DELETE", path: "feishu/bindings/\(binding.id)")
    }

    func createFeishuPairingCode(for bot: FeishuBot) async -> Result<FeishuPairingCodeResponse, Error> {
        isUpdatingFeishu = true
        defer { isUpdatingFeishu = false }
        do {
            let pairing = try await api.pairingCode(botID: bot.id)
            lastError = nil
            return .success(pairing)
        } catch {
            lastError = error.localizedDescription
            return .failure(error)
        }
    }

    private func performFeishuMutation(method: String, path: String, body: [String: Any]? = nil) async -> Bool {
        isUpdatingFeishu = true
        defer { isUpdatingFeishu = false }
        do {
            try await api.mutate(method: method, path: path, body: body)
            lastError = nil
            await loadFeishuBots()
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }
}
