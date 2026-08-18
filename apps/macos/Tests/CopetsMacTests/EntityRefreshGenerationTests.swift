import Testing
@testable import CorptieMac

struct EntityRefreshGenerationTests {
    @Test
    func newerBackendReadyRefreshSupersedesColdStartRequest() {
        var generation = EntityRefreshGeneration()

        let coldStartRequest = generation.begin()
        let backendReadyRequest = generation.begin()

        #expect(!generation.isCurrent(coldStartRequest))
        #expect(generation.isCurrent(backendReadyRequest))
    }
}
