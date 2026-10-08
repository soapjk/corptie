import Foundation
import Testing
@testable import CorptieMobileState

struct PadTimelineDiagnosticTests {
    @Test func writesDecodableLocalSnapshotsAndRotatesWithinBudget() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let log = PadTimelineDiagnosticLog(directory: directory, limit: 1024)
        let page = UUID()
        for index in 0..<20 {
            log.append(.init(event: "keyboard", page: page,
                flags: ["followsLatest": true], numbers: ["offsetY": Double(index)]))
        }
        log.drainForTesting()
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        #expect(Set(files.map(\.lastPathComponent)) == ["current.jsonl", "previous.jsonl"])
        for file in files {
            let data = try Data(contentsOf: file)
            #expect(data.count <= 1024)
            for line in data.split(separator: 10) {
                let record = try JSONDecoder().decode(PadTimelineDiagnosticRecord.self, from: Data(line))
                #expect(record.page == page && record.flags["followsLatest"] == true)
                let object = try #require(JSONSerialization.jsonObject(with: Data(line)) as? [String: Any])
                #expect(Set(object.keys) == ["timestamp", "uptime", "event", "page", "flags", "numbers"])
            }
        }
    }
    @Test func oversizedRecordDoesNotCreateUnboundedFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let log = PadTimelineDiagnosticLog(directory: directory, limit: 32)
        log.append(.init(event: "probe", page: UUID(), flags: [:], numbers: [:]))
        log.drainForTesting()
        #expect(!FileManager.default.fileExists(atPath: directory.path))
    }
}
