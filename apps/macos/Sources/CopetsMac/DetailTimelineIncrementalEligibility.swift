enum DetailTimelineIncrementalEligibility {
    /// Tail-only reuse is valid only while the requested history window stays
    /// unchanged. Increasing the window means older entries must be rebuilt
    /// from the full detail; reusing the cached tail would make “Load earlier”
    /// update its counter without inserting any rows.
    static func canReuseCachedWindow(
        cachedVisibleMessageLimit: Int,
        requestedVisibleMessageLimit: Int
    ) -> Bool {
        cachedVisibleMessageLimit == requestedVisibleMessageLimit
    }
}
