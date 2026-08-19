import XCTest
@testable import CorptieMac

final class AgentProviderDescriptorTests: XCTestCase {
    func testProviderCatalogDecodesCapabilitiesAndConfiguration() throws {
        let data = Data(#"""
        {
          "defaultProviderId": "openclacky",
          "providers": [
            {
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
            },
            {
              "id": "read-only-provider",
              "displayName": "Read Only",
              "transport": "test",
              "aliases": [],
              "capabilities": ["configuration.model.list"],
              "runtime": { "lifecycle": "managed" },
              "configuration": { "fields": [] }
            },
            {
              "id": "codex-app-server",
              "displayName": "Codex",
              "transport": "app-server",
              "aliases": ["codex"],
              "capabilities": ["session.create"],
              "runtime": { "lifecycle": "managed" },
              "configuration": { "fields": [] }
            }
          ]
        }
        """#.utf8)

        let response = try JSONDecoder().decode(AgentProvidersResponse.self, from: data)
        let provider = try XCTUnwrap(response.providers.first)
        XCTAssertEqual(provider.id, "openclacky")
        XCTAssertEqual(response.defaultProviderId, "openclacky")
        XCTAssertTrue(provider.supports("session.create"))
        XCTAssertEqual(provider.configuration.fields.first?.defaultValue, "http://127.0.0.1:7070")
        XCTAssertEqual(response.providers.canonicalProviderId(for: "clacky"), "openclacky")
        XCTAssertEqual(response.providers.displayName(for: "clacky"), "OpenClacky")
        XCTAssertEqual(
            response.providers.sessionProviderAlternatives(to: "clacky").map(\.id),
            ["codex-app-server"]
        )
        XCTAssertEqual(
            response.providers.sessionProviderAlternatives(to: "unknown").map(\.id),
            ["openclacky", "codex-app-server"]
        )
    }
}
