import Foundation
import Testing
@testable import CorptieMac

struct EntityAssociationResolverTests {
    @Test
    func repositoryIDsResolveForDisplayAndUnknownAssociationsRemainVisible() {
        let repository = GitRepository(
            id: "repository:known",
            path: "/tmp/known/.git",
            name: "known",
            discoveredAt: nil,
            lastValidatedAt: nil
        )

        #expect(EntityAssociationResolver.workspace(id: nil, repositories: [repository]) == .none)
        #expect(
            EntityAssociationResolver.workspace(id: repository.id, repositories: [repository])
                == .resolved(repository)
        )
        let unresolved = EntityAssociationResolver.workspace(
            id: "worktree:legacy",
            repositories: [repository]
        )
        #expect(unresolved == .unresolved("worktree:legacy"))
        #expect(unresolved.displayName == "worktree:legacy")
        #expect(unresolved.isUnresolved)
    }

    @Test
    func structuredEntityErrorsPreserveFieldGuidance() throws {
        let data = Data(#"""
        {
          "error":"Field only accepts repository IDs.",
          "code":"INVALID_ID_FORMAT",
          "field":"mainWorkspaceId",
          "expected":"registered repository: ID",
          "received":{"type":"string","value":"worktree:legacy"}
        }
        """#.utf8)
        let envelope = try JSONDecoder().decode(EntityErrorEnvelope.self, from: data)
        #expect(envelope.code == "INVALID_ID_FORMAT")
        #expect(envelope.field == "mainWorkspaceId")
        #expect(envelope.displayMessage.contains("registered repository: ID"))
    }
}
