import Foundation
import Testing
@testable import CorptieClientCore

struct PinnedTLSTests {
    @Test func actualTLSRequiresScannedCertificateAndCorrectHostname() async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("TLSFixture.mjs")
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", script.path]
        process.standardOutput = pipe
        try process.run()
        defer { process.terminate(); process.waitUntilExit() }
        struct Fixture: Decodable { let port: Int; let certificate: String; let otherCertificate: String }
        let fixture = try JSONDecoder().decode(Fixture.self, from: pipe.fileHandleForReading.availableData)
        let endpoint = try BackendEndpoint(URL(string: "https://127.0.0.1:\(fixture.port)")!)
        let transport = try BackendTransport(endpoint: endpoint, certificate: fixture.certificate)
        let (data, _) = try await transport.data(for: endpoint.request(path: ["test"]))
        #expect(String(data: data, encoding: .utf8) == "ok")
        let unpinned = try BackendTransport(endpoint: endpoint)
        await #expect(throws: (any Error).self) { try await unpinned.data(for: endpoint.request(path: ["test"])) }
        let wrongPin = try BackendTransport(endpoint: endpoint, certificate: fixture.otherCertificate)
        await #expect(throws: (any Error).self) { try await wrongPin.data(for: endpoint.request(path: ["test"])) }
        let wrongHost = try BackendEndpoint(URL(string: "https://localhost:\(fixture.port)")!)
        let mismatch = try BackendTransport(endpoint: wrongHost, certificate: fixture.certificate)
        await #expect(throws: (any Error).self) { try await mismatch.data(for: wrongHost.request(path: ["test"])) }
        let code = DevicePairingCode(address: "https://192.168.1.2:\(fixture.port)", serverId: "test",
            pairingId: UUID().uuidString, pairingSecret: String(repeating: "a", count: 43),
            expiresAt: Date().timeIntervalSince1970 * 1000 + 300_000, certificate: fixture.certificate)
        #expect(try DevicePairingCode.decode(code.encoded()) == code)
        #expect(code.version == 2)
    }
}
