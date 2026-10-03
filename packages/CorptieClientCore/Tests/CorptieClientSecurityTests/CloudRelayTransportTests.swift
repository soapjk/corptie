import Foundation
import Testing
import CorptieClientCore
@testable import CorptieClientSecurity

struct CloudRelayTransportTests {
    @Test func customBackendTransportMultiplexesDataAndStreamingResponses() async throws {
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:4311")!)
        let channel = RelayLoopbackChannel()
        let client = CloudRelayHTTPClient(endpoint: endpoint, channel: channel)
        let transport = client.transport()

        var post = try endpoint.request(path: ["client", "v1", "messages"], query: [URLQueryItem(name: "after", value: "2")])
        post.httpMethod = "POST"
        post.setValue("application/json", forHTTPHeaderField: "Content-Type")
        post.setValue("must-not-cross", forHTTPHeaderField: "Authorization")
        post.httpBody = Data(#"{"text":"hello"}"#.utf8)
        let (body, response) = try await transport.data(for: post)
        #expect(response.statusCode == 201)
        #expect(body == Data("accepted".utf8))

        var events = try endpoint.request(path: ["client", "v2", "events"])
        events.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let (bytes, streamResponse) = try await transport.bytes(for: events)
        #expect(streamResponse.value(forHTTPHeaderField: "Content-Type") == "text/event-stream")
        var streamed = Data()
        for try await byte in bytes { streamed.append(byte) }
        #expect(streamed == Data("event: heartbeat\ndata: {}\n\n".utf8))

        let requests = await channel.requests
        #expect(requests.count == 2)
        #expect(requests[0].path == "/client/v1/messages?after=2")
        #expect(requests[0].headers?["authorization"] == nil)
        #expect(requests[0].body == post.httpBody)
        await client.close()
    }

    @Test func relayTransportRejectsBodiesOverTheExplicitLimitBeforeSending() async throws {
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:4311")!)
        let channel = RelayLoopbackChannel()
        let client = CloudRelayHTTPClient(endpoint: endpoint, channel: channel)
        let transport = client.transport()
        var request = try endpoint.request(path: ["upload"])
        request.httpMethod = "POST"
        request.httpBody = Data(repeating: 1, count: CloudRelayHTTPClient.maximumRequestBytes + 1)
        await #expect(throws: CloudRelayTransportError.unsupportedRequest) {
            try await transport.data(for: request)
        }
        #expect(await channel.requests.isEmpty)
    }
}

private actor RelayLoopbackChannel: CloudRelaySecureChannel {
    private(set) var requests: [CloudRelayApplicationMessage] = []
    private var responses: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    private var uploads: [UUID: (CloudRelayApplicationMessage, Data)] = [:]

    func send(_ plaintext: Data) async throws {
        let message = try JSONDecoder().decode(CloudRelayApplicationMessage.self, from: plaintext)
        if message.kind == .chunk, var upload = uploads[message.id], let body = message.body {
            upload.1.append(body)
            if message.final == true {
                uploads.removeValue(forKey: message.id)
                let complete = CloudRelayApplicationMessage.request(
                    id: upload.0.id, method: upload.0.method!, path: upload.0.path!,
                    headers: upload.0.headers ?? [:], body: upload.1
                )
                try respond(to: complete)
            } else { uploads[message.id] = upload }
            return
        }
        guard message.kind == .request else { return }
        if message.final == false {
            uploads[message.id] = (message, Data())
            return
        }
        try respond(to: message)
    }

    private func respond(to message: CloudRelayApplicationMessage) throws {
        requests.append(message)
        if message.path?.contains("/events") == true {
            enqueue(try JSONEncoder().encode(CloudRelayApplicationMessage.response(
                id: message.id, status: 200, headers: ["Content-Type": "text/event-stream"]
            )))
            enqueue(try JSONEncoder().encode(CloudRelayApplicationMessage.chunk(
                id: message.id, body: Data("event: heartbeat\ndata: {}\n\n".utf8), final: true
            )))
        } else {
            enqueue(try JSONEncoder().encode(CloudRelayApplicationMessage.response(id: message.id, status: 201, headers: [:])))
            enqueue(try JSONEncoder().encode(CloudRelayApplicationMessage.chunk(id: message.id, body: Data("accepted".utf8), final: true)))
        }
    }

    func receive() async throws -> Data {
        if !responses.isEmpty { return responses.removeFirst() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }

    func close() async {
        waiter?.resume(throwing: CloudRelayTransportError.disconnected)
        waiter = nil
    }

    private func enqueue(_ data: Data) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: data)
        } else {
            responses.append(data)
        }
    }
}
