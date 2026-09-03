import Foundation

enum ArtifactVisibility: String, Codable, CaseIterable, Identifiable, Sendable {
    case workPrivate = "work_private"
    case taskPrivate = "task_private"
    case sessionPrivate = "session_private"
    case repositoryTracked = "repository_tracked"
    var id: String { rawValue }
}

struct WorkArtifact: Identifiable, Codable, Hashable, Sendable {
    var id: String { artifactId }
    let artifactId: String
    let workId: String
    let title: String
    let summary: String
    let visibility: ArtifactVisibility
    let boundTaskId: String?
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
    let availableActions: [String]?
}

enum ArtifactCollectionLoadState: Equatable, Sendable {
    case idle
    case loading(previousValue: [WorkArtifact]?)
    case loaded([WorkArtifact])
    case failed(message: String, previousValue: [WorkArtifact]?)

    var value: [WorkArtifact]? {
        switch self {
        case .idle: nil
        case .loading(let previous), .failed(_, let previous): previous
        case .loaded(let artifacts): artifacts
        }
    }
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
    let workId: String
    let taskId: String?
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
    let workId: String
    let action: String
    let actorId: String
    let sessionId: String?
    let taskId: String?
    let fromVersion: Int?
    let toVersion: Int?
    let createdAt: String
}

struct ArtifactListEnvelope: Codable, Sendable {
    let artifacts: [WorkArtifact]
    let totalCount: Int?
    let nextOffset: Int?
}

struct ArtifactDetailEnvelope: Codable, Sendable {
    let artifactId: String
    let version: Int
    let contentHash: String
    let mimeType: String
    let totalBytes: Int
    let encoding: String?
    let content: String?
    let range: ArtifactReadRange
    let complete: Bool
    let pendingUpdate: ArtifactPendingUpdate?
    let readReceiptId: String
    let deduplicated: Bool
    let turnBudget: ArtifactTurnReadBudget
}

struct ArtifactReadRange: Codable, Sendable {
    let offset: Int
    let byteLength: Int
    let nextOffset: Int?
}

struct ArtifactPendingUpdate: Codable, Sendable {
    let version: Int
    let contentHash: String
}

struct ArtifactTurnReadBudget: Codable, Sendable {
    let uniqueBytesUsed: Int
    let uniqueBytesLimit: Int
    let uniquePagesUsed: Int
    let uniquePagesLimit: Int
}

struct ArtifactImportReceipt: Codable, Sendable {
    let sourcePath: String
    let sourcePreserved: Bool
    let byteLength: Int
    let contentHash: String
    let remoteWrite: Bool
}

struct ArtifactImportEnvelope: Codable, Sendable {
    let artifact: WorkArtifact
    let receipt: ArtifactImportReceipt
}

struct ArtifactPublicationEnvelope: Codable, Sendable {
    let artifact: WorkArtifact
    let version: ArtifactVersion
    let reference: ArtifactReference?
    let operationStatus: String?
    let idempotentReplay: Bool?
}

struct ArtifactExportReceipt: Codable, Sendable {
    let artifactId: String
    let version: Int
    let contentHash: String
    let destinationPath: String
    let repositoryWrite: Bool
}

struct ArtifactLocalFileReceipt: Codable, Sendable, Equatable {
    let artifactId: String
    let version: Int
    let path: String
    let suggestedFilename: String
    let mimeType: String

    var fileURL: URL { URL(fileURLWithPath: path) }

    var applicationLookupURL: URL {
        fileURL.deletingLastPathComponent()
            .appendingPathComponent(suggestedFilename, isDirectory: false)
    }
}

enum ArtifactContentPagingPolicy {
    static let pageBytes = 64 * 1024

    static func previousOffset(currentOffset: Int) -> Int? {
        currentOffset > 0 ? max(0, currentOffset - pageBytes) : nil
    }
}
