import Foundation
import Testing
@testable import CorptieClientCore

@Suite struct ClientResourceTests {
    static let item = """
    {"id":"artifact:one","type":"artifact","title":"SDK","summary":"plan","owner":{"type":"session","id":"session:one"},"workId":null,"workName":"","sourceSessionId":"session:one","sourceTitle":"Source","updatedAt":"2026-10-18T00:00:00Z","createdAt":"2026-10-18T00:00:00Z","revision":1,"status":"active","currentVersion":1,"approvedVersion":null,"previewHash":null,"previewState":"draft","capabilities":["read"]}
    """
    @Test func legalSessionOwnershipAndPartialMalformedRowsDoNotEraseThePage() throws {
        let data = Data("{\"schemaVersion\":1,\"items\":[\(Self.item),{\"id\":\"bad\"}],\"hasMore\":false,\"nextCursor\":null}".utf8)
        let page = try JSONDecoder().decode(ClientResourcePage.self, from: data)
        #expect(page.items.count == 1); #expect(page.invalidItemCount == 1)
        #expect(page.items[0].workId == nil); #expect(page.items[0].owner.id == "session:one")
        #expect(page.items[0].approvedVersion == nil)
    }
    @Test func invalidSchemaAndCursorContractsFailInsteadOfBecomingEmpty() {
        for json in ["{\"schemaVersion\":2,\"items\":[],\"hasMore\":false}", "{\"schemaVersion\":1,\"items\":[],\"hasMore\":true,\"nextCursor\":null}"] {
            #expect(throws: (any Error).self) { try JSONDecoder().decode(ClientResourcePage.self, from: Data(json.utf8)) }
        }
    }
    @Test func desktopAndPairedRoutesKeepVersionHashAndReadScope() async throws {
        for route in [ClientResourceAPI.Route.desktop, .pairedDevice] {
            let prefix = route == .desktop ? "/resources/" : "/client/v1/resources/"
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:47321")!), data: { request in
                #expect(request.url!.path.hasPrefix(prefix))
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
                #expect(query.first { $0.name == "version" }?.value == "3")
                #expect(query.first { $0.name == "hash" }?.value == String(repeating: "a", count: 64))
                #expect(query.first { $0.name == "offset" }?.value == "0")
                let json = "{\"artifactId\":\"artifact:one\",\"version\":3,\"contentHash\":\"\(String(repeating: "a", count: 64))\",\"mimeType\":\"text/markdown\",\"content\":\"中文公式\",\"encoding\":\"utf-8\",\"range\":{\"offset\":0,\"nextOffset\":null},\"complete\":true}"
                return (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }, bytes: { _ in throw ClientConnectionError.invalidResponse })
            let page = try await ClientResourceAPI(transport: transport, route: route).read("artifact:one", version: 3, hash: String(repeating: "a", count: 64), offset: 0, readId: "test-read-123")
            #expect(page.content == "中文公式")
        }
    }
}
