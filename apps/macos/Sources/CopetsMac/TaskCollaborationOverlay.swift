import SwiftUI

struct TaskCollaborationFlowEvent: Decodable {
    let messageId: String
    let channelId: String
    let senderSessionId: String
    let createdAt: String
    struct Envelope: Decodable {
        let payload: Payload
        struct Payload: Decodable { let message: TaskCollaborationFlowEvent }
    }
}

struct TaskCollaborationEdge: Decodable, Equatable, Identifiable {
    let id: String
    let sourceTaskId: String
    let targetTaskId: String
    let sourceSessionId: String
    let targetSessionId: String
    struct Response: Decodable { let edges: [TaskCollaborationEdge] }
}

/// One drawing surface; neither messages nor animation ticks invalidate Task cards.
