import Testing
@testable import CorptieMac

struct SessionListPerformanceFlagsTests {
    @Test
    func productionIgnoresDiagnosticOverrides() {
        let flags = SessionListPerformanceFlags.resolve(environment: [
            "CORPTIE_ENV": "production",
            "CORPTIE_SESSION_PERF_LIMIT": "3",
            "CORPTIE_SESSION_PERF_HALO_ANIMATIONS": "0",
            "CORPTIE_SESSION_PERF_GLASS_EFFECTS": "0",
            "CORPTIE_SESSION_PERF_POLLING": "0"
        ])

        #expect(flags.sessionLimit == nil)
        #expect(flags.haloAnimationsEnabled)
        #expect(flags.glassEffectsEnabled)
        #expect(flags.pollingEnabled)
        #expect(!flags.forcesCardDisplayMode)
        #expect(!flags.layoutLoggingEnabled)
    }

    @Test
    func developmentAcceptsDiagnosticOverrides() {
        let flags = SessionListPerformanceFlags.resolve(environment: [
            "CORPTIE_ENV": "development",
            "CORPTIE_SESSION_PERF_LIMIT": "12",
            "CORPTIE_SESSION_PERF_HALO_ANIMATIONS": "false",
            "CORPTIE_SESSION_PERF_GLASS_EFFECTS": "no",
            "CORPTIE_SESSION_PERF_POLLING": "off",
            "CORPTIE_SESSION_PERF_FORCE_CARDS": "1",
            "CORPTIE_LAYOUT_DEBUG": "1"
        ])

        #expect(flags.sessionLimit == 12)
        #expect(!flags.haloAnimationsEnabled)
        #expect(!flags.glassEffectsEnabled)
        #expect(!flags.pollingEnabled)
        #expect(flags.forcesCardDisplayMode)
        #expect(flags.layoutLoggingEnabled)
    }

    @Test
    func invalidLimitFallsBackToTheFullList() {
        let flags = SessionListPerformanceFlags.resolve(environment: [
            "CORPTIE_ENV": "development",
            "CORPTIE_SESSION_PERF_LIMIT": "0"
        ])

        #expect(flags.sessionLimit == nil)
    }
}
