import Foundation
import Testing
@testable import CorptieMac

@Suite(.serialized) @MainActor struct FoundationModelDraftTests {
    private let response = #"{"mode":"api","providerId":"","model":"synthetic","reasoning":"","baseURL":"https://model.invalid/v1","hasApiKey":true}"#

    private func setup() -> (FoundationModelDraft, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SettingsModelURLProtocol.self]
        let session = URLSession(configuration: configuration)
        return (FoundationModelDraft(baseURL: URL(string: "http://settings.invalid")!, session: session), session)
    }

    @Test func remountLoadPreservesUnsavedValuesAndDoesNotRepeatRequest() async {
        let response = self.response
        let (draft, session) = setup()
        defer { session.invalidateAndCancel() }
        SettingsModelURLProtocol.handler = { _ in (200, response) }
        await draft.load()
        #expect(draft.loaded)
        draft.value.model = "edited"
        draft.apiKey = "synthetic-input"
        SettingsModelURLProtocol.handler = { _ in
            Issue.record("Already loaded draft must not fetch again on remount")
            return (500, "{}")
        }
        await draft.load()
        #expect(draft.value.model == "edited")
        #expect(draft.apiKey == "synthetic-input")
        #expect(draft.isDirty)
    }

    @Test func failedAndForbiddenWritesRetainSecretAndDoNotReportClean() async {
        let response = self.response
        let (draft, session) = setup()
        defer { session.invalidateAndCancel() }
        SettingsModelURLProtocol.handler = { _ in (200, response) }
        await draft.load()
        draft.apiKey = "synthetic-input"
        SettingsModelURLProtocol.handler = { request in
            #expect(request.httpMethod == "PUT")
            return (503, "secret error body must never be displayed")
        }
        await draft.save()
        #expect(draft.isDirty)
        #expect(draft.apiKey == "synthetic-input")
        #expect(!draft.status.contains("secret error body"))
        #expect(!draft.busy)
        SettingsModelURLProtocol.handler = { _ in (403, "{}") }
        await draft.save()
        #expect(draft.readOnly)
        #expect(draft.isDirty)
        draft.discard()
        #expect(draft.apiKey.isEmpty)
    }

    @Test func blankSecretIsOmittedAndExplicitClearSendsEmptyValue() async {
        let response = self.response
        let (draft, session) = setup()
        defer { session.invalidateAndCancel() }
        SettingsModelURLProtocol.handler = { _ in (200, response) }
        await draft.load()
        draft.value.model = "changed"
        SettingsModelURLProtocol.handler = { request in
            let body = try SettingsModelURLProtocol.body(request)
            #expect(body["apiKey"] == nil)
            return (200, response.replacingOccurrences(of: "synthetic", with: "changed"))
        }
        await draft.save()
        #expect(!draft.isDirty)
        draft.clearKey = true
        SettingsModelURLProtocol.handler = { request in
            let body = try SettingsModelURLProtocol.body(request)
            #expect(body["apiKey"] as? String == "")
            return (200, response.replacingOccurrences(of: "true", with: "false"))
        }
        await draft.save()
        #expect(!draft.isDirty)
        #expect(!draft.value.hasApiKey)
    }
}

private final class SettingsModelURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
                httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}

    static func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
}
