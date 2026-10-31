import Foundation
import Testing
@testable import CorptieMac

struct AgentCreationSubmissionTests {
    @Test
    func standaloneCreationRunsInBackgroundButPickerCreationWaitsForTheAgent() {
        #expect(RoleCreateSubmissionPolicy.submitsInBackground(requiresCreatedRole: false))
        #expect(!RoleCreateSubmissionPolicy.submitsInBackground(requiresCreatedRole: true))
    }

    @Test
    func repeatedClickWhileRequestIsInFlightIsRejected() {
        var submission = RoleCreationSubmission(idempotencyKey: "create-agent-1")

        #expect(submission.begin() == "create-agent-1")
        #expect(submission.begin() == nil)
    }

    @Test
    func retryAfterAmbiguousFailureReusesTheBusinessRequestKey() {
        var submission = RoleCreationSubmission(idempotencyKey: "create-agent-1")

        #expect(submission.begin() == "create-agent-1")
        submission.finishAfterFailure()
        #expect(submission.begin() == "create-agent-1")
    }

    @Test
    @MainActor
    func installationIdentityIsStableForOneDeviceProfile() {
        let suite = "AgentCreationSubmissionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        #expect(CorptieInstallationIdentity.id(defaults: defaults) == CorptieInstallationIdentity.id(defaults: defaults))
    }
}
