import Foundation
import Testing
@testable import CorptieMac

struct WorkCanvasLayoutSnapshotTests {
    @Test func concurrentReadersReceiveCompleteIndependentSnapshots() {
        let snapshot = WorkCanvasLayoutSnapshot()
        snapshot.frames = ["first": .zero, "second": .zero]

        DispatchQueue.concurrentPerform(iterations: 500) { index in
            let frame = CGRect(x: index, y: index, width: 240, height: 100)
            snapshot.frames = ["first": frame, "second": frame]
            var captured = snapshot.frames
            #expect(captured.count == 2)
            #expect(captured["first"] == captured["second"])

            // A drag can adjust its own copy without changing Layout's output.
            captured["local-only"] = frame
            #expect(snapshot.frames["local-only"] == nil)
        }
    }
}
