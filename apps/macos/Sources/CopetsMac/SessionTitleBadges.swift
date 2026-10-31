import Combine
import CorptieClientCore
import SwiftUI

/// Small value projection: unrelated entity/status updates never invalidate the icons.
struct SessionTitleIdentity: Equatable {
    struct Request: Equatable {
        let provider: String
        let model: String?
        let roleID: String?

        init(session: TaskSession) {
            provider = session.external?.provider ?? session.agent
            model = session.external?.currentModel
            roleID = session.roleId
        }
    }

    let providerID: String
    let providerName: String
    let model: String?
    let roleID: String?
    let roleName: String?
    let avatarPath: String?

    static func resolve(_ request: Request, roles: [String: Role], providers: [AgentProviderDescriptor]) -> Self {
        let role = request.roleID.flatMap { roles[$0] }
        return Self(providerID: providers.canonicalProviderId(for: request.provider) ?? request.provider,
                    providerName: providers.displayName(for: request.provider) ?? request.provider,
                    model: nonempty(request.model), roleID: nonempty(request.roleID),
                    roleName: role?.name, avatarPath: nonempty(role?.avatarPath))
    }

    static func updates(session: TaskSession, state: AnyPublisher<NormalizedAppState, Never>,
                        providers: AnyPublisher<[AgentProviderDescriptor], Never>) -> AnyPublisher<Self, Never> {
        Publishers.CombineLatest(state, providers)
            .map { state, providers in
                Self.resolve(.init(session: state.sessions[session.id] ?? session), roles: state.roles, providers: providers)
            }
            .removeDuplicates()
            .eraseToAnyPublisher()
    }

    private static func nonempty(_ value: String?) -> String? {
        let text = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    var providerHelp: String { [providerName, model].compactMap { $0 }.joined(separator: " · ") }
    @MainActor var roleHelp: String { roleName ?? roleID ?? L10n("Role") }
}

struct SessionTitleBadges: View {
    let session: TaskSession
    var size: CGFloat = 14
    @State private var identity: SessionTitleIdentity

    init(session: TaskSession, size: CGFloat = 14) {
        self.session = session
        self.size = size
        _identity = State(initialValue: Self.resolve(.init(session: session)))
    }

    private static func resolve(_ request: SessionTitleIdentity.Request) -> SessionTitleIdentity {
        .resolve(request, roles: AppStateStore.shared.state.roles,
                 providers: BackendClient.shared.modelCatalog.agentProviders)
    }

    var body: some View {
        SessionTitleIdentityIcons(identity: identity, size: size)
            .onReceive(SessionTitleIdentity.updates(session: session,
                state: AppStateStore.shared.$state.eraseToAnyPublisher(),
                providers: BackendClient.shared.modelCatalog.$agentProviders.eraseToAnyPublisher())) { identity = $0 }
            .onChange(of: SessionTitleIdentity.Request(session: session)) { _, request in
                identity = Self.resolve(request)
            }
    }
}

/// No animation, timers, shadows or global observation in the rendered badge content.
struct SessionTitleIdentityIcons: View {
    let identity: SessionTitleIdentity
    var size: CGFloat = 14

    var body: some View {
        HStack(spacing: 4) {
            Group {
                if let image = ProviderBrandIcon.image(for: identity.providerID, providers: []) {
                    Image(nsImage: image).resizable().interpolation(.high)
                } else {
                    Image(systemName: "cpu").resizable().scaledToFit().foregroundStyle(.secondary)
                }
            }
            .frame(width: size, height: size)
            .help(identity.providerHelp)
            .accessibilityLabel(identity.providerHelp)
            .accessibilityIdentifier("session.title.provider")

            if let roleID = identity.roleID {
                Group {
                    if let path = identity.avatarPath {
                        AnimatedAvatarImage(path: path, animates: false)
                    } else {
                        DefaultInitialAvatarView(familySeed: identity.roleName ?? roleID, variationSeed: roleID,
                            initials: DefaultAvatarInitials.make(from: identity.roleName ?? L10n("Role")), size: size)
                    }
                }
                .frame(width: size, height: size)
                .clipShape(Circle())
                .help(identity.roleHelp)
                .accessibilityLabel(identity.roleHelp)
                .accessibilityIdentifier("session.title.agent")
            }
        }
        .fixedSize()
        .layoutPriority(1)
    }
}
