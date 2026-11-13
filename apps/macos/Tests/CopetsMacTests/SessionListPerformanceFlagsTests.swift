import Testing
@testable import CorptieMac

struct SessionListPerformanceFlagsTests {
    @Test
    func productionIgnoresHaloDiagnosticOverride() {
        let flags = SessionListPerformanceFlags.resolve(environment: [
            "CORPTIE_ENV": "production",
            "CORPTIE_SESSION_PERF_HALO_ANIMATIONS": "0"
        ])
        #expect(flags.haloAnimationsEnabled)
    }

    @Test
    func developmentAcceptsHaloDiagnosticOverride() {
        let flags = SessionListPerformanceFlags.resolve(environment: [
            "CORPTIE_ENV": "development",
            "CORPTIE_SESSION_PERF_HALO_ANIMATIONS": "false"
        ])
        #expect(!flags.haloAnimationsEnabled)
    }

    @Test
    func developmentEnablesHaloAnimationsByDefault() {
        let flags = SessionListPerformanceFlags.resolve(environment: ["CORPTIE_ENV": "development"])
        #expect(flags.haloAnimationsEnabled)
    }
}
