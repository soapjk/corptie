import XCTest
@testable import CorptieMac

final class AgentProviderDescriptorTests: XCTestCase {
    func testProviderCatalogDecodesCapabilitiesAndConfiguration() throws {
        let data = Data(#"""
        {
          "providers": [{
            "id": "openclacky",
            "displayName": "OpenClacky",
            "transport": "http-websocket",
            "aliases": ["clacky"],
            "capabilities": ["session.create", "configuration.model.list"],
            "runtime": { "lifecycle": "external" },
            "configuration": {
              "fields": [{
                "id": "baseURL",
                "type": "url",
                "label": "Server URL",
                "required": true,
                "defaultValue": "http://127.0.0.1:7070"
              }]
            }
          }]
        }
        """#.utf8)

        let response = try JSONDecoder().decode(AgentProvidersResponse.self, from: data)
        let provider = try XCTUnwrap(response.providers.first)
        XCTAssertEqual(provider.id, "openclacky")
        XCTAssertTrue(provider.supports("session.create"))
        XCTAssertEqual(provider.configuration.fields.first?.defaultValue, "http://127.0.0.1:7070")
    }
}
