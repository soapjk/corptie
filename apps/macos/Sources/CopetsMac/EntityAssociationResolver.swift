import Foundation

enum WorkspaceAssociationResolution: Equatable {
    case none
    case resolved(GitRepository)
    case unresolved(String)

    var displayName: String? {
        switch self {
        case .none: nil
        case .resolved(let repository): repository.name
        case .unresolved(let id): id
        }
    }

    var isUnresolved: Bool {
        if case .unresolved = self { return true }
        return false
    }
}

enum EntityAssociationResolver {
    static func workspace(id: String?, repositories: [GitRepository]) -> WorkspaceAssociationResolution {
        guard let id, !id.isEmpty else { return .none }
        guard let repository = repositories.first(where: { $0.id == id }) else {
            return .unresolved(id)
        }
        return .resolved(repository)
    }
}
