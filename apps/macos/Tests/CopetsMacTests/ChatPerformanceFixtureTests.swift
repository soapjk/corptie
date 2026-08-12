import Testing
@testable import CorptieMac

struct ChatPerformanceFixtureTests {
    @Test
    func standardFixtureIsDeterministicAndCoversHighPressureContent() {
        let fixture = ChatPerformanceFixture.make()
        let items = fixture.detail.items

        #expect(items.count == 10_000)
        #expect(fixture.detail.turnCount == 400)
        #expect(Set(items.map(\.id)).count == items.count)
        #expect(Set(items.map(\.turnId)).count == 400)
        #expect(items.contains { $0.type == "approval" })
        #expect(items.contains { $0.type == "commandExecution" })
        #expect(items.contains { $0.type == "fileChange" })
        #expect(items.contains { $0.text.contains("```swift") })
        #expect(items.contains { $0.text.count >= 10_000 })
    }

    @Test
    func streamingReplayChangesOnlyTheLastStableItem() {
        let fixture = ChatPerformanceFixture.make(
            configuration: .init(turnCount: 4, rawItemCount: 20, longMessageCharacters: 1_000)
        )
        let updated = ChatPerformanceFixture.appendingStreamStep(1, to: fixture.detail)

        #expect(updated.items.count == fixture.detail.items.count)
        #expect(updated.items.dropLast() == fixture.detail.items.dropLast())
        #expect(updated.items.last?.id == fixture.detail.items.last?.id)
        #expect(updated.items.last?.text.hasSuffix("fixture-token-1") == true)
        #expect(updated.status == .running)
    }

    @Test
    func configurableFinalStreamStepCompletesOnlyAtRequestedBoundary() {
        let fixture = ChatPerformanceFixture.make()
        let beforeFinal = ChatPerformanceFixture.appendingStreamStep(499, to: fixture.detail, finalStep: 500)
        let final = ChatPerformanceFixture.appendingStreamStep(500, to: beforeFinal, finalStep: 500)

        #expect(beforeFinal.status == .running)
        #expect(beforeFinal.items.last?.turnStatus == "running")
        #expect(final.status == .complete)
        #expect(final.items.last?.turnStatus == "completed")
    }

    @Test
    func performanceCountersCanBeSnapshottedAndReset() {
        let recorder = ChatPerformanceRecorder()
        recorder.increment(.sseSnapshots)
        recorder.increment(.sseSnapshotBytes, by: 42)

        #expect(recorder.snapshot()[.sseSnapshots] == 1)
        #expect(recorder.snapshot()[.sseSnapshotBytes] == 42)

        recorder.reset()
        #expect(recorder.snapshot()[.sseSnapshots] == 0)
    }
}
