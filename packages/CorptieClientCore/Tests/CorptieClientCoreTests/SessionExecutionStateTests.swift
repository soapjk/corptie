import Foundation
import Testing
@testable import CorptieClientCore

struct SessionExecutionStateTests {
    @Test func activityDecodesAdditivelyAndInvalidatesOnlyOnChange() throws {
        let base = #"{"id":"s","title":"Session","executionStatus":"running","updatedAt":"now"}"#
        let decoder = JSONDecoder()
        let legacy = try decoder.decode(ClientSession.self, from: Data(base.utf8))
        #expect(legacy.activityStatus == nil)
        let json = base.dropLast() + #", "activityStatus":"Running command"}"#
        let current = try decoder.decode(ClientSession.self, from: Data(json.utf8))
        #expect(current.activityStatus == "Running command")
        #expect(current != legacy)
        #expect(current == (try decoder.decode(ClientSession.self, from: Data(json.utf8))))
        let cleared = base.dropLast() + #", "activityStatus":null}"#
        #expect(legacy == (try decoder.decode(ClientSession.self, from: Data(cleared.utf8))))
    }
    @Test func normalizesExecutionContractAndAliases() {
        let groups: [(SessionExecutionState, [String])] = [
            (.running, ["running", "working", "processing"]),
            (.blocked, ["blocked"]), (.complete, ["completed", "complete", "idle"]),
            (.failed, ["failed"]), (.cancelled, ["cancelled", "canceled", "interrupted"])
        ]
        for (expected, aliases) in groups {
            for alias in aliases {
                #expect(SessionExecutionState(executionStatus: " \(alias.uppercased())\n") == expected)
            }
        }
    }

    @Test func unknownIsNotMisrepresentedAsSuccessOrWorking() {
        for raw in [nil, "", "unknown", "reconnecting"] as [String?] {
            #expect(SessionExecutionState(executionStatus: raw) == nil)
        }
        #expect(SessionExecutionState.allCases.map(\.label) ==
            ["Running", "Blocked", "Complete", "Failed", "Interrupted"])
    }
}
