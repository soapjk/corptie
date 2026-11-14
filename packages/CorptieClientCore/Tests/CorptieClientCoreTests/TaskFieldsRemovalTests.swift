import Foundation
import Testing
@testable import CorptieClientCore

struct TaskFieldsRemovalTests {
    @Test func taskPayloadsDecodeWithoutDefinitionFieldsAndCommandsNeverEncodeThem() throws {
        let decoder = JSONDecoder()
        let row = Data(#"{"id":"task:1","title":"Task","workId":"work:1","lifecycleState":"todo","executionStatus":"idle","updatedAt":"now"}"#.utf8)
        let task = try decoder.decode(ClientTask.self, from: row)
        #expect(task.title == "Task")
        let business = Data(#"{"taskId":"task:1","title":"Task","status":"todo","resourceRevision":"1","summary":{"state":"ready","focus":"Focus","progress":"Progress","intervention":"not_required","reason":"","nextAction":"","generatedAt":"now","current":true}}"#.utf8)
        #expect(try decoder.decode(ClientDetailBusinessTask.self, from: business).summary.focus == "Focus")
        let creation = ClientTaskCreation(requestId:"request:1",workId:"work:1",title:"Task",mainRoleId:"agent:1",providerId:"provider:test")
        var update = ClientTaskUpdate(requestId:"request:2"); update.title = "Renamed"
        for data in [try JSONEncoder().encode(creation), try JSONEncoder().encode(update)] {
            let object = try #require(JSONSerialization.jsonObject(with:data) as? [String:Any])
            for key in ["description", "acceptanceCriteria", "verificationCriteria"] { #expect(object[key] == nil) }
            #expect(object["title"] != nil)
        }
    }
}
