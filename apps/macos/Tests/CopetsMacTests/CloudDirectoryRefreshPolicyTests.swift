import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMac

struct CloudDirectoryRefreshPolicyTests {
    @Test func authorizationFailuresStopButGatewayFailuresKeepRecoveryAvailable() {
        #expect(CloudDirectoryRefreshPolicy.requiresReauthentication(ClientConnectionError.httpStatus(401), credentialStage: false))
        #expect(CloudDirectoryRefreshPolicy.requiresReauthentication(ClientConnectionError.httpStatus(403), credentialStage: false))
        #expect(!CloudDirectoryRefreshPolicy.requiresReauthentication(ClientConnectionError.httpStatus(400), credentialStage: true))
        #expect(CloudDirectoryRefreshPolicy.requiresReauthentication(CloudOAuthRefreshError.invalidGrant, credentialStage: true))
        #expect(!CloudDirectoryRefreshPolicy.requiresReauthentication(ClientConnectionError.httpStatus(400), credentialStage: false))
        #expect(!CloudDirectoryRefreshPolicy.requiresReauthentication(ClientConnectionError.httpStatus(502), credentialStage: true))
        #expect(!CloudDirectoryRefreshPolicy.requiresReauthentication(URLError(.timedOut), credentialStage: false))
    }
    @Test func shortReconnectsReuseRegistrationButIdentityChangesDoNot() {
        var policy = CloudDirectoryRefreshPolicy()
        let id = UUID(), now = Date(timeIntervalSince1970: 1000)
        #expect(policy.requiresRegistration(id))
        policy.reconciled(id, at: now)
        #expect(!policy.requiresRegistration(id))
        #expect(!policy.requiresRefresh(at: now.addingTimeInterval(299)))
        #expect(policy.requiresRefresh(at: now.addingTimeInterval(300)))
        #expect(policy.requiresRefresh(at: now.addingTimeInterval(-1)))
        #expect(policy.requiresRegistration(UUID()))
        policy.invalidate()
        #expect(policy.requiresRegistration(id))
        #expect(policy.requiresRefresh(at: now))
    }
}
