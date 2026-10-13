import Foundation
import Testing
@testable import CorptieClientCore

struct ClientSessionPreparationTests {
    @Test func failedPreparationShowsReasonAndNetworkErrorsRemainDistinct() throws {
        let value = try JSONDecoder().decode(ClientSessionPreparation.self, from: Data(Self.state.utf8))
        #expect(value.failureDetail?.contains("Provider 会话核验超时") == true)
        #expect(value.failureDetail?.contains("PROVIDER_RPC_TIMEOUT") == true)
        let timeout = ClientSessionPreparation.requestFailureDetail(URLError(.timedOut))
        #expect(timeout.contains("15 秒") && timeout.contains("-1001"))
        let disconnected = ClientSessionPreparation.requestFailureDetail(URLError(.networkConnectionLost))
        #expect(disconnected.contains("连接中断") && disconnected.contains("-1005"))
        #expect(ClientSessionPreparation.requestFailureDetail(ClientConnectionError.httpStatus(503)).contains("HTTP 503"))
        #expect(ClientSessionPreparation.requestFailureDetail(ClientConnectionError.invalidResponse).contains("INVALID_RESPONSE"))
    }

    @Test func serverFailureMessageSurvivesDesktopAndPairedTransport() async throws {
        for route in [ClientSessionPreparationAPI.Route.desktop, .paired] {
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1")!), data: { request in
                (Data(#"{"code":"SESSION_PREPARATION_STORAGE_UNAVAILABLE","error":"Preparation storage is unavailable."}"#.utf8),
                 HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!)
            }, bytes: { _ in throw ClientConnectionError.invalidResponse })
            do {
                _ = try await ClientSessionPreparationAPI(transport: transport, route: route).start(sessionID: "session")
                Issue.record("Expected preparation failure")
            } catch {
                let detail = ClientSessionPreparation.requestFailureDetail(error)
                #expect(detail.contains("Preparation storage is unavailable."))
                #expect(detail.contains("SESSION_PREPARATION_STORAGE_UNAVAILABLE"))
                #expect(detail.contains("HTTP 503"))
            }
        }
    }

    static let state = #"{"id":"attempt","state":"failed","reasonCode":"PROVIDER_RPC_TIMEOUT","remoteDisposition":"unknown","retryable":false,"createdAt":"2026-10-13T00:00:00Z","deadlineAt":"2026-10-13T00:02:00Z"}"#

    @Test func desktopAndPairedUseSameVersionedStateAndExactRoutes() async throws {
        for route in [ClientSessionPreparationAPI.Route.desktop, .paired] {
            let prefix = route == .desktop ? "/sessions" : "/client/v1/sessions"
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1")!), data: { request in
                #expect(request.url!.path.hasPrefix(prefix + "/session/preparation"))
                #expect(request.timeoutInterval == 15)
                if request.httpMethod == "POST" { #expect(request.httpBody == Data("{}".utf8)) }
                let data = Data("{\"schemaVersion\":1,\"preparation\":\(Self.state)}".utf8)
                return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }, bytes: { _ in throw ClientConnectionError.invalidResponse })
            let api = ClientSessionPreparationAPI(transport: transport, route: route)
            let start = try await api.start(sessionID: "session")
            #expect(start == (try await api.current(sessionID: "session")))
            #expect(start == (try await api.cancel(sessionID: "session", attemptID: "attempt")))
            #expect(start?.isReady == false)
            #expect(start?.isActive == false)
            #expect(start?.statusText.contains("未重发消息") == true)
        }
    }

    @Test func unknownFutureStateCannotBePresentedAsReadyAndUnsupportedSchemaFails() async throws {
        let value = try JSONDecoder().decode(ClientSessionPreparation.self,
            from: Data(Self.state.replacingOccurrences(of: "failed", with: "future-state").utf8))
        #expect(!value.isReady && !value.isActive)
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1")!), data: { request in
            (Data(#"{"schemaVersion":2,"preparation":null}"#.utf8),
             HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, bytes: { _ in throw ClientConnectionError.invalidResponse })
        await #expect(throws: ClientConnectionError.invalidResponse) {
            try await ClientSessionPreparationAPI(transport: transport, route: .paired).current(sessionID: "session")
        }
    }
}
