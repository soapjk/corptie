import Foundation
import Testing
@testable import CorptieMac

@Suite(.serialized)
struct SkillDeletionTests {
    @Test func deletionClientRequiresHTTPAndCompletedResponseContract() async throws {
        let session = makeSession()
        SkillDeletionURLProtocol.handler = { request in
            #expect(request.httpMethod == "DELETE")
            #expect(request.value(forHTTPHeaderField: "X-Corptie-Confirm-Destructive-Action") == "delete-skill")
            return (200, Self.completedPayload)
        }
        let client = SkillDeletionHTTPClient(baseURL: URL(string: "http://127.0.0.1:9999")!, session: session)

        let result = try await client.delete(skillId: "skill:one")

        #expect(result.ok)
        #expect(result.operation.status == "completed")
    }

    @Test func deletionClientSurfacesHTTPFailureInsteadOfFalseSuccess() async {
        let session = makeSession()
        SkillDeletionURLProtocol.handler = { _ in
            (500, #"{"error":"runtime cleanup failed; retry is available","code":"SKILL_CLEANUP_FAILED"}"#)
        }
        let client = SkillDeletionHTTPClient(baseURL: URL(string: "http://127.0.0.1:9999")!, session: session)

        await #expect(throws: EntityLaunchError.self) {
            _ = try await client.delete(skillId: "skill:one")
        }
    }

    @Test func confirmationPolicyOffersDeleteOnlyWhenNoActiveSessionIsAffected() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let allowed = try decoder.decode(SkillDeletionImpactEnvelope.self, from: Data(Self.impactPayload.utf8)).impact
        #expect(SkillDeletionConfirmationPolicy.canOfferDestructiveAction(for: allowed))

        let blockedData = Self.impactPayload
            .replacingOccurrences(of: #""activeSessions":[]"#, with: #""activeSessions":[{"sessionId":"session:1","title":"Running","status":"running","agentId":"agent:1","agentName":"One"}]"#)
            .replacingOccurrences(of: #""activeSessionCount":0"#, with: #""activeSessionCount":1"#)
            .replacingOccurrences(of: #""canDelete":true"#, with: #""canDelete":false"#)
        let blocked = try decoder.decode(SkillDeletionImpactEnvelope.self, from: Data(blockedData.utf8)).impact
        #expect(!SkillDeletionConfirmationPolicy.canOfferDestructiveAction(for: blocked))
    }

    @MainActor
    @Test func stateChangeRemovesSkillAndStaleAgentSkillIdsTogether() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let store = AppStateStore()
        let snapshot = try decoder.decode(StateSnapshotEnvelope.self, from: Data(Self.snapshotPayload.utf8))
        let changes = try decoder.decode(StateChangeSetEnvelope.self, from: Data(Self.changePayload.utf8))

        #expect(store.apply(snapshot: snapshot) == .applied)
        #expect(store.skills.map(\.skillId) == ["skill:one"])
        #expect(store.agents.allSatisfy { $0.skillIds == ["skill:one"] })
        #expect(store.apply(changeSet: changes) == .applied)
        #expect(store.skills.isEmpty)
        #expect(store.agents.allSatisfy { $0.skillIds == [] })
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SkillDeletionURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static let impactPayload = #"{"impact":{"skillId":"skill:one","skillName":"One","affectedAgents":[{"agentId":"agent:1","name":"One"},{"agentId":"agent:2","name":"Two"}],"affectedAgentCount":2,"activeSessions":[],"activeSessionCount":0,"canDelete":true,"policy":"blockWhileAssignedAgentSessionActive"}}"#

    private static let completedPayload = #"{"ok":true,"operation":{"operationId":"skill-deletion:1","skillId":"skill:one","skillName":"One","status":"completed","cleanup":[{"kind":"runtime","providerId":"provider","path":"/tmp/runtime/skill:one","status":"succeeded","error":null}],"errorCode":null,"errorMessage":null},"impact":{"skillId":"skill:one","skillName":"One","affectedAgents":[],"affectedAgentCount":0,"activeSessions":[],"activeSessionCount":0,"canDelete":true,"policy":"blockWhileAssignedAgentSessionActive"}}"#

    private static let snapshotPayload = #"{"revision":1,"state":{"sessions":[],"workItems":[],"objectives":[],"agents":[{"agentId":"agent:1","name":"One","description":"","role":"independentContributor","status":"available","systemPrompt":"","capabilities":[],"skillIds":["skill:one"],"createdAt":"2026-08-19T00:00:00Z","updatedAt":"2026-08-19T00:00:00Z"},{"agentId":"agent:2","name":"Two","description":"","role":"independentContributor","status":"available","systemPrompt":"","capabilities":[],"skillIds":["skill:one"],"createdAt":"2026-08-19T00:00:01Z","updatedAt":"2026-08-19T00:00:01Z"}],"skills":[{"skillId":"skill:one","name":"One","description":"","sourceType":"local","source":"/tmp/one","installedAt":"2026-08-19T00:00:00Z","updatedAt":"2026-08-19T00:00:00Z"}],"repositories":[],"integrationRuns":[]}}"#

    private static let changePayload = #"{"snapshotRequired":false,"baseRevision":1,"revision":4,"upserts":{"sessions":[],"workItems":[],"objectives":[],"agents":[{"agentId":"agent:1","name":"One","description":"","role":"independentContributor","status":"available","systemPrompt":"","capabilities":[],"skillIds":[],"createdAt":"2026-08-19T00:00:00Z","updatedAt":"2026-08-19T00:00:00Z"},{"agentId":"agent:2","name":"Two","description":"","role":"independentContributor","status":"available","systemPrompt":"","capabilities":[],"skillIds":[],"createdAt":"2026-08-19T00:00:01Z","updatedAt":"2026-08-19T00:00:01Z"}],"skills":[],"repositories":[],"integrationRuns":[]},"deletes":{"sessions":[],"workItems":[],"objectives":[],"agents":[],"skills":["skill:one"],"repositories":[],"integrationRuns":[]}}"#
}

private final class SkillDeletionURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (status, body) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
