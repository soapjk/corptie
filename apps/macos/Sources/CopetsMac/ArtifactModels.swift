import Foundation

enum ArtifactVisibility: String, Codable, CaseIterable, Identifiable, Sendable {
    case objectivePrivate = "objective_private"
    case workItemPrivate = "work_item_private"
    case sessionPrivate = "session_private"
    case repositoryTracked = "repository_tracked"
    var id: String { rawValue }
}

struct ObjectiveArtifact: Identifiable, Codable, Hashable, Sendable {
    var id: String { artifactId }
    let artifactId: String
    let objectiveId: String
    let title: String
    let summary: String
    let visibility: ArtifactVisibility
    let boundWorkItemId: String?
    let boundSessionId: String?
    let repositoryLocator: String?
    let currentVersion: Int
    let approvedVersion: Int?
    let status: String
    let sourceSessionId: String?
    let sourceEventId: String?
    let createdByActorId: String
    let createdAt: String
    let updatedAt: String
    let resourceVersion: Int
    let versions: [ArtifactVersion]
    let references: [ArtifactReference]
    let audit: [ArtifactAuditEvent]
}

struct ArtifactVersion: Identifiable, Codable, Hashable, Sendable {
    var id: String { "\(artifactId):\(version)" }
    let artifactId: String
    let version: Int
    let contentHash: String
    let byteLength: Int
    let mimeType: String
    let storageKey: String?
    let sourceSessionId: String?
    let sourceEventId: String?
    let supersedesVersion: Int?
    let approvalStatus: String
    let createdByActorId: String
    let createdAt: String
}

struct ArtifactReference: Identifiable, Codable, Hashable, Sendable {
    var id: String { referenceId }
    let referenceId: String
    let artifactId: String
    let objectiveId: String
    let workItemId: String?
    let sessionId: String?
    let relation: String
    let required: Bool
    let versionPolicy: String
    let pinnedVersion: Int
    let pinnedHash: String
    let pendingVersion: Int?
    let pendingHash: String?
    let authorizedByActorId: String
    let authorizedAt: String
    let revokedAt: String?
    let revokedByActorId: String?
    let revocationReason: String?
    let resourceVersion: Int
}

struct ArtifactAuditEvent: Identifiable, Codable, Hashable, Sendable {
    var id: String { auditId }
    let auditId: String
    let artifactId: String?
    let objectiveId: String
    let action: String
    let actorId: String
    let sessionId: String?
    let workItemId: String?
    let fromVersion: Int?
    let toVersion: Int?
    let createdAt: String
}

struct ArtifactListEnvelope: Codable, Sendable { let artifacts: [ObjectiveArtifact] }

struct ArtifactDetailEnvelope: Codable, Sendable {
    let artifact: ObjectiveArtifact
    let version: ArtifactVersion
    let content: String?
    let offset: Int
    let nextOffset: Int?
    let truncated: Bool
    let references: [ArtifactReference]
}

struct ArtifactImportReceipt: Codable, Sendable {
    let sourcePath: String
    let sourcePreserved: Bool
    let byteLength: Int
    let contentHash: String
    let remoteWrite: Bool
}

struct ArtifactImportEnvelope: Codable, Sendable {
    let artifact: ObjectiveArtifact
    let receipt: ArtifactImportReceipt
}

struct ArtifactPublicationEnvelope: Codable, Sendable {
    let artifact: ObjectiveArtifact
    let version: ArtifactVersion
}

struct ArtifactExportReceipt: Codable, Sendable {
    let artifactId: String
    let version: Int
    let contentHash: String
    let destinationPath: String
    let repositoryWrite: Bool
}

enum ArtifactContentPagingPolicy {
    static let pageBytes = 64 * 1024

    static func previousOffset(currentOffset: Int) -> Int? {
        currentOffset > 0 ? max(0, currentOffset - pageBytes) : nil
    }
}
