import Foundation

public struct ClientChildDelivery: Decodable, Sendable, Identifiable {
    public struct Artifact: Decodable, Sendable {
        public let artifactId: String
        public let title: String
        public let version: Int
    }
    public let operationId: String
    public let taskId: String
    public let parentTaskId: String
    public let title: String
    public let state: String
    public let phase: String
    public let errorMessage: String?
    public let canRetry: Bool
    public let artifacts: [Artifact]
    public var id: String { operationId }
}
public struct ClientChildDeliveryPage: Decodable, Sendable {
    public let items: [ClientChildDelivery]
    public let nextCursor: String?
}
public struct ClientChildDeliveryStatus: Decodable, Sendable {
    public let taskId: String
    public let title: String
    public let parentTaskId: String?
    public let operation: ClientChildDelivery?
    public init(taskId: String,title: String,parentTaskId: String?,operation: ClientChildDelivery?) {
        self.taskId=taskId; self.title=title; self.parentTaskId=parentTaskId; self.operation=operation
    }
}
public struct ClientChildCompletionIntent: Codable, Sendable {
    public let intentToken: String
    public let requestId: String
    public let taskId: String
}

extension ClientTaskHierarchyAPI {
    public func childDelivery(taskID: String) async throws -> ClientChildDeliveryStatus {
        try await deliveryRequest(path:["tasks",taskID,"child-delivery"])
    }
    public func childDeliveries(taskID: String, cursor: String? = nil) async throws -> ClientChildDeliveryPage {
        try await deliveryRequest(path:["tasks",taskID,"child-deliveries"],
            query:cursor.map { [URLQueryItem(name:"cursor",value:$0)] } ?? [])
    }
    public func retryChildDelivery(operationID: String) async throws -> ClientChildDelivery {
        try await deliveryRequest(path:["child-deliveries",operationID,"retry"],body:Data("{}".utf8))
    }
    public func prepareChildAcceptance(taskID: String, title: String, requestID: String) async throws -> ClientChildCompletionIntent {
        struct Body: Encodable {
            let requestId: String; let interactionId: String; let uiSurface = "task_completion_confirmation"
            let displayedTaskId: String; let displayedTaskTitle: String
        }
        return try await deliveryRequest(path:["tasks",taskID,"completion-intents"],body:JSONEncoder().encode(
            Body(requestId:requestID,interactionId:requestID,displayedTaskId:taskID,displayedTaskTitle:title)))
    }
    public func acceptChild(_ intent: ClientChildCompletionIntent) async throws -> ClientChildDelivery {
        struct Body: Encodable { let intentToken: String; let requestId: String; let idempotencyKey: String }
        struct Envelope: Decodable { let childDelivery: ClientChildDelivery }
        let result: Envelope = try await deliveryRequest(path:["tasks",intent.taskId,"confirm-completion"],body:JSONEncoder().encode(
            Body(intentToken:intent.intentToken,requestId:intent.requestId,idempotencyKey:"child-acceptance:\(intent.requestId)")))
        return result.childDelivery
    }
}
