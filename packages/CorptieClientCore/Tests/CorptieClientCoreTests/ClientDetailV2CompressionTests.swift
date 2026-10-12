import Foundation
import Testing
@testable import CorptieClientCore

#if os(macOS)
struct ClientDetailV2CompressionTests {
    /// A real loopback gzip response, not a mock DataHandler. This verifies
    /// rejection before publication; it does NOT assert bounded download RAM.
    @Test func maliciousGzipExpansionIsRejectedAtTheDecodedDocumentLimit() async throws {
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "--input-type=module", "-e", """
        import http from 'node:http';
        import { gzipSync } from 'node:zlib';
        import { writeSync, closeSync } from 'node:fs';
        const raw = Buffer.from(JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }));
        const compressed = gzipSync(raw);
        const server = http.createServer((request, response) => {
          response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': compressed.length });
          response.end(compressed);
        });
        server.listen(0, '127.0.0.1', () => { writeSync(1, String(server.address().port)); closeSync(1); });
        """]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        let rawPort = try output.fileHandleForReading.read(upToCount: 128)
        let portData = try #require(rawPort)
        let port = try #require(Int(String(decoding: portData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "http://127.0.0.1:\(port)")!))
        do {
            _ = try await ClientDetailV2API(transport: transport, route: .desktop).snapshot(sessionID: "synthetic")
            Issue.record("expanded malicious document must never be returned")
        } catch {
            guard case ClientDetailV2Canonical.Failure.limit = error else {
                Issue.record("unexpected gzip rejection: \(error)"); return
            }
        }
    }
}
#endif
