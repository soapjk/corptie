import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@MainActor
struct PadLANConnectionTests {
    private func fixture(_ probe: LANProbe, cloudTarget: UUID? = nil) -> PadConnection {
        let connection = PadConnection(cloudTargetMacID: cloudTarget,
            relayFactory: { _ in probe.relayRecoveries += 1; throw URLError(.cannotConnectToHost) },
            lanAuthDependencies: .init(
            load: { _, _ in probe.saved },
            save: { credentials, _, _ in probe.saved = credentials; probe.saves += 1 },
            refresh: { _, _ in
                probe.refreshes += 1
                if probe.delay { try await Task.sleep(for: .milliseconds(30)) }
                if let error = probe.refreshError { throw error }
                return probe.credential(token: "new", expired: probe.refreshReturnsExpired)
            },
            transport: { credentials, endpoint in
                BackendTransport(endpoint: endpoint, data: { request in
                    try await probe.verify(request, token: credentials.accessToken)
                }, bytes: { _ in throw URLError(.cancelled) })
            }))
        connection.address = "https://127.0.0.1:55633"
        connection.serverID = "server"
        connection.hasSavedPairing = true
        return connection
    }

    @Test func expiredTokenRefreshesBeforeVerification() async throws {
        let probe = LANProbe(expired: true), connection = fixture(probe)
        await connection.reconnect()
        #expect(connection.connected)
        #expect(connection.deviceID == "device")
        #expect(probe.tokens == ["new"])
        #expect(probe.refreshes == 1 && probe.saves == 1)
        #expect(probe.saved?.certificate == "pinned-certificate")
        #expect(connection.lanConnectionNotice == "局域网连接成功。")
        #expect(!connection.lanConnecting && !connection.busy)
    }

    @Test func validCredentialDoesNotRefresh() async {
        let probe = LANProbe(), connection = fixture(probe)
        await connection.reconnect()
        #expect(connection.connected)
        #expect(probe.tokens == ["old"] && probe.refreshes == 0)
    }

    @Test func serverRejectsTokenRefreshesAndRetriesOnlyOnce() async {
        let probe = LANProbe(), connection = fixture(probe)
        probe.rejectOld = true
        await connection.reconnect()
        #expect(connection.connected)
        #expect(probe.tokens == ["old", "new"] && probe.refreshes == 1)
        probe.rejectAll = true
        await connection.reconnect()
        #expect(probe.refreshes == 2)
        #expect(probe.tokens == ["old", "new", "new", "new"])
        #expect(connection.connected) // Previous working connection remains.
        #expect(connection.lanConnectionNotice.contains("重新扫码"))
        #expect(probe.saved != nil)
    }

    @Test func failedRefreshKeepsPairingAndOriginalConnection() async {
        let probe = LANProbe(expired: true), connection = fixture(probe)
        connection.connected = true
        probe.refreshError = URLError(.timedOut)
        await connection.reconnect()
        #expect(connection.connected && connection.hasSavedPairing)
        #expect(probe.saved?.accessToken == "old")
        #expect(probe.tokens.isEmpty && probe.saves == 0)
        #expect(!connection.lanConnectionNotice.isEmpty)
        let error = connection.lanConnectionNotice
        await connection.perform { }
        #expect(connection.lanConnectionNotice == error)
    }

    @Test func identityMismatchDoesNotCommitCandidate() async {
        let probe = LANProbe(), connection = fixture(probe)
        probe.wrongIdentity = true
        let generation = connection.deliveryTransportGeneration
        await connection.reconnect()
        #expect(!connection.connected && connection.deviceID == nil)
        #expect(connection.deliveryTransportGeneration == generation)
        #expect(connection.lanConnectionNotice.contains("身份"))
        #expect(probe.saved != nil && probe.refreshes == 0)
    }

    @Test func duplicateClicksCoalesceAndCancelledVerificationDoesNotCommit() async {
        let probe = LANProbe(expired: true), connection = fixture(probe)
        probe.delay = true
        async let first: Void = connection.reconnect()
        async let second: Void = connection.reconnect()
        _ = await (first, second)
        #expect(probe.refreshes == 1 && probe.tokens.count == 1)
        #expect(connection.connected)
        probe.verifyError = CancellationError()
        let generation = connection.deliveryTransportGeneration
        await connection.reconnect()
        #expect(connection.deliveryTransportGeneration == generation)
        #expect(connection.connected && probe.saved != nil)
        #expect(connection.lanConnectionNotice.contains("取消"))
    }

    @Test func revokedDeviceDoesNotTryToBypassRevocation() async {
        let probe = LANProbe(), connection = fixture(probe)
        probe.verifyError = ClientServiceFailure(statusCode: 401, code: "DEVICE_REVOKED")
        await connection.reconnect()
        #expect(!connection.connected && probe.refreshes == 0)
        #expect(probe.saved != nil && connection.hasSavedPairing)
    }

    @Test func backgroundTransportAndManualConnectShareOneTokenRotation() async throws {
        let probe = LANProbe(expired: true), connection = fixture(probe)
        probe.refreshReturnsExpired = true
        await connection.reconnect()
        #expect(connection.connected && probe.refreshes == 1)
        probe.refreshReturnsExpired = false
        probe.delay = true
        let read = Task { try await connection.transport() }
        let click = Task { await connection.reconnect() }
        do { _ = try await read.value } catch is CancellationError { }
        await click.value
        #expect(probe.refreshes == 2 && probe.saves == 2)
        #expect(connection.connected)
    }

    @Test func successfulLANSwitchClearsOldCloudTarget() async throws {
        let probe = LANProbe(), connection = fixture(probe, cloudTarget: UUID())
        connection.connected = true
        let generation = connection.deliveryTransportGeneration
        await connection.reconnect()
        #expect(connection.deliveryTransportGeneration != generation)
        #expect(connection.recoveryRevision == 1)
        let transport = try await connection.transport()
        #expect(transport.endpoint.baseURL.host == "127.0.0.1")
        #expect(probe.relayRecoveries == 0)
    }

    @Test func missingPairingAndBusyConnectionHaveExplicitResults() async {
        let probe = LANProbe(), connection = fixture(probe)
        connection.busy = true
        await connection.reconnect()
        #expect(connection.lanConnectionNotice.contains("其他连接"))
        #expect(probe.tokens.isEmpty)
        connection.busy = false
        probe.saved = nil
        await connection.reconnect()
        #expect(connection.lanConnectionNotice.contains("没有已保存"))
        #expect(!connection.hasSavedPairing)
    }
}

@MainActor
private final class LANProbe {
    var saved: DeviceCredentials?
    var refreshes = 0, saves = 0, relayRecoveries = 0
    var tokens: [String] = []
    var delay = false, rejectOld = false, rejectAll = false, wrongIdentity = false
    var refreshReturnsExpired = false
    var refreshError: Error?, verifyError: Error?
    init(expired: Bool = false) { saved = credential(token: "old", expired: expired) }
    func credential(token: String, expired: Bool) -> DeviceCredentials {
        .init(certificate: "pinned-certificate", serverId: "server", deviceId: "device",
            accessToken: token, refreshToken: "refresh-\(token)",
            accessExpiresAt: expired ? 0 : Date().timeIntervalSince1970 * 1000 + 900_000,
            refreshExpiresAt: Date().timeIntervalSince1970 * 1000 + 86_400_000)
    }
    func verify(_ request: URLRequest, token: String) throws -> (Data, HTTPURLResponse) {
        tokens.append(token)
        #expect(request.url?.path == "/client/v1/me")
        #expect(request.value(forHTTPHeaderField: "X-Corptie-Connection-ID") != nil)
        if let verifyError { throw verifyError }
        if rejectAll || (rejectOld && token == "old") {
            throw ClientServiceFailure(statusCode: 401, code: "INVALID_CREDENTIAL")
        }
        let data = try JSONSerialization.data(withJSONObject: ["serverId": wrongIdentity ? "wrong" : "server", "deviceId": "device"])
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
