import XCTest
import UIKit
import CorptieClientCore
@testable import CorptieMobile

@MainActor final class ImageGalleryLoadingTests: XCTestCase {
    private let resource = ClientMessageImageResource(sessionID: "s", sourceItemID: "m", source: .managed(path: "owned"))
    private func waitUntil(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("Image state did not settle")
    }
    func testPreviewIsImmediateAndOriginalNeedsExplicitSingleRequest() async throws {
        let preview = UIImage(systemName: "photo")!
        let png = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).pngData { _ in UIColor.red.setFill(); UIRectFill(CGRect(x: 0,y: 0,width: 2,height: 2)) }
        var requests = 0
        let model = PadImageGallerySession(resources: [resource], selected: 0, previews: [preview], download: { _, progress in
            requests += 1
            progress(.init(received: 1, total: 100))
            try await Task.sleep(for: .milliseconds(30))
            return png
        })
        XCTAssertTrue(model.image === preview)
        XCTAssertFalse(model.canSave)
        XCTAssertEqual(requests, 0)
        let connection = PadConnection()
        model.requestOriginal(connection: connection)
        model.requestOriginal(connection: connection)
        try await waitUntil { requests == 1 }
        XCTAssertTrue(model.image === preview)
        XCTAssertFalse(model.canSave)
        try await waitUntil { !model.loading }
        XCTAssertTrue(model.canSave)
        model.requestOriginal(connection: connection)
        XCTAssertEqual(requests, 1)
    }
    func testSwitchAndCloseCancelWithoutLoadingAnotherOriginal() async throws {
        let preview = UIImage(systemName: "photo")!
        var requests = 0, cancellations = 0
        let model = PadImageGallerySession(resources: [resource, resource], selected: 0, previews: [preview, preview], download: { _, _ in
            requests += 1
            do { try await Task.sleep(for: .seconds(30)); return Data() }
            catch { cancellations += 1; throw error }
        })
        let connection = PadConnection()
        model.requestOriginal(connection: connection)
        try await waitUntil { requests == 1 }
        model.selection = 1
        try await waitUntil { cancellations == 1 }
        XCTAssertEqual(requests, 1)
        XCTAssertTrue(model.image === preview)
        model.requestOriginal(connection: connection)
        try await waitUntil { requests == 2 }
        model.cancel()
        try await waitUntil { cancellations == 2 }
        XCTAssertFalse(model.canSave)
    }
    func testLateCallbacksAndCompletionsCannotOverwriteNewSelectionOrClosedViewer() async throws {
        let firstPreview = UIImage(systemName: "photo")!
        let secondPreview = UIImage(systemName: "photo.fill")!
        var completions: [CheckedContinuation<Data, Error>] = []
        var callbacks: [@MainActor (ClientImageProgress) -> Void] = []
        var returned = 0
        let model = PadImageGallerySession(resources: [resource, resource], selected: 0,
            previews: [firstPreview, secondPreview], download: { _, progress in
                callbacks.append(progress)
                defer { returned += 1 }
                // Deliberately ignores cancellation to model a late transport callback.
                return try await withCheckedThrowingContinuation { completions.append($0) }
            })
        let connection = PadConnection()
        model.requestOriginal(connection: connection)
        try await waitUntil { completions.count == 1 }
        model.selection = 1
        XCTAssertTrue(model.image === secondPreview)
        XCTAssertNil(model.progress)
        XCTAssertEqual(completions.count, 1)
        model.requestOriginal(connection: connection)
        try await waitUntil { completions.count == 2 }
        callbacks[1](.init(received: 2, total: 100))
        callbacks[0](.init(received: 99, total: 100))
        XCTAssertEqual(model.progress?.received, 2)
        completions[0].resume(returning: Data([1, 2, 3]))
        try await waitUntil { returned == 1 }
        XCTAssertTrue(model.image === secondPreview)
        XCTAssertNil(model.failure)
        XCTAssertFalse(model.canSave)
        model.cancel()
        callbacks[1](.init(received: 100, total: 100))
        completions[1].resume(throwing: URLError(.timedOut))
        try await waitUntil { returned == 2 }
        XCTAssertTrue(model.image === secondPreview)
        XCTAssertEqual(model.progress?.received, 2)
        XCTAssertNil(model.failure)
        XCTAssertFalse(model.loading)
        XCTAssertFalse(model.canSave)
    }
    func testCloseBeforeRequestTaskStartsMakesNoRequest() async throws {
        var requests = 0
        let model = PadImageGallerySession(resources: [resource], selected: 0, download: { _, _ in
            requests += 1
            return Data()
        })
        model.requestOriginal(connection: PadConnection())
        model.cancel()
        await Task.yield()
        XCTAssertEqual(requests, 0)
        XCTAssertFalse(model.loading)
    }
    func testFailureKeepsPreviewAndCannotSave() async throws {
        let preview = UIImage(systemName: "photo")!
        let model = PadImageGallerySession(resources: [resource], selected: 0, previews: [preview], download: { _, _ in
            throw URLError(.timedOut)
        })
        model.requestOriginal(connection: PadConnection())
        try await waitUntil { !model.loading }
        XCTAssertNotNil(model.failure)
        XCTAssertTrue(model.image === preview)
        XCTAssertFalse(model.canSave)
    }
}
