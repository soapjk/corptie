import XCTest
@testable import CorptieMac

final class AsyncSerialGateTests: XCTestCase {
    func testGateAllowsOnlyOneConcurrentOperation() async {
        let gate = AsyncSerialGate()
        let recorder = ConcurrencyRecorder()

        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<12 {
                group.addTask {
                    await gate.acquire()
                    await recorder.enter()
                    try? await Task.sleep(for: .milliseconds(5))
                    await recorder.leave()
                    await gate.release()
                }
            }
        }

        let maximumConcurrency = await recorder.maximumConcurrency
        XCTAssertEqual(maximumConcurrency, 1)
    }
}

private actor ConcurrencyRecorder {
    private var activeCount = 0
    private(set) var maximumConcurrency = 0

    func enter() {
        activeCount += 1
        maximumConcurrency = max(maximumConcurrency, activeCount)
    }

    func leave() {
        activeCount -= 1
    }
}
