import Foundation
import Testing
@testable import CorptieClientCore

struct TaskCoordinationTests {
    @Test func modeDefaultsOffAndDispatchStateDecodesWithoutChangingAcceptance() throws {
        let legacy = #"{"id":"task:1","title":"T","workId":"work:1","lifecycleState":"active","executionStatus":"idle","updatedAt":"now"}"#
        let previous = try JSONDecoder().decode(ClientTask.self, from: Data(legacy.utf8))
        #expect(!previous.coordinationEnabled)
        #expect(previous.coordinationDispatches.isEmpty)
        var object = try #require(JSONSerialization.jsonObject(with: Data(legacy.utf8)) as? [String: Any])
        object["coordinationEnabled"] = true
        object["coordinationDispatches"] = [["dispatchId": "dispatch:1", "taskId": "task:child", "title": "Child", "status": "completed"]]
        let current = try JSONDecoder().decode(ClientTask.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(current.coordinationEnabled)
        #expect(current.coordinationDispatches.count == 1)
        #expect(current.coordinationDispatches[0].statusLabel.contains("未代表验收"))
        #expect(current.lifecycleState == previous.lifecycleState)
    }
    @Test func waitingForParentWorkspaceIsNotAReportedFailure() throws {
        let payload = #"{"dispatchId":"dispatch:waiting","taskId":null,"title":"Child","status":"waiting_workspace","errorCode":"TASK_HIERARCHY_BUSY"}"#
        let dispatch = try JSONDecoder().decode(ClientTaskCoordinationDispatch.self, from: Data(payload.utf8))
        #expect(dispatch.statusLabel == "等待父工作区操作完成")
    }
    @Test func updateUsesOneTypedUserCommand() throws {
        var command = ClientTaskUpdate(requestId: "coordination:1")
        command.coordinationEnabled = true
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any])
        #expect(object["coordinationEnabled"] as? Bool == true)
        #expect(object.keys.sorted() == ["coordinationEnabled", "requestId"])
    }
    @Test func nativeTaskPayloadCarriesTheSameModeAndStates() throws {
        let payload = #"{"taskId":"task:1","title":"T","status":"in_progress","description":"","acceptanceCriteria":"","verificationCriteria":"","resourceRevision":"2","summary":{"state":"pending","focus":"","progress":"","intervention":"none","reason":"","nextAction":"","current":false},"coordinationEnabled":true,"coordinationDispatches":[{"dispatchId":"dispatch:1","taskId":null,"title":"准备子任务","status":"preparing","errorCode":null}]}"#
        let task = try JSONDecoder().decode(ClientDetailBusinessTask.self, from: Data(payload.utf8))
        #expect(task.coordinationEnabled == true)
        #expect(task.coordinationDispatches?.first?.status == "preparing")
        #expect(task.coordinationExecution == nil)
        var object = try #require(JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        for (status, label) in [("pending", "等待生效"), ("enforced", "强协调已启用"), ("unsupported", "当前运行环境不支持")] {
            object["coordinationExecution"] = ["status": status, "reason": "server authority"]
            let updated = try JSONDecoder().decode(ClientDetailBusinessTask.self, from: JSONSerialization.data(withJSONObject: object))
            #expect(updated.coordinationExecution?.statusLabel == label)
            #expect(updated.coordinationExecution?.reason == "server authority")
        }
    }
}
