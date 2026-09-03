import AppKit
import XCTest
@testable import CorptieMac

final class ArtifactTests: XCTestCase {
    func testArtifactCollectionLoadStateDistinguishesIdleLoadingEmptyAndFailure() {
        XCTAssertNil(ArtifactCollectionLoadState.idle.value)
        XCTAssertNil(ArtifactCollectionLoadState.loading(previousValue: nil).value)
        XCTAssertEqual(ArtifactCollectionLoadState.loaded([]).value, [])
        XCTAssertNil(ArtifactCollectionLoadState.failed(message: "timeout", previousValue: nil).value)
        XCTAssertNotEqual(
            ArtifactCollectionLoadState.loaded([]),
            ArtifactCollectionLoadState.failed(message: "timeout", previousValue: nil)
        )
    }

    func testArtifactEndpointEncodesCanonicalIdentifiersExactlyOnce() {
        let url = ArtifactAPIClient.endpointURL(
            baseURL: URL(string: "http://127.0.0.1:47321/")!,
            path: "works/work:196ee12b/artifacts"
        )
        XCTAssertEqual(url.absoluteString, "http://127.0.0.1:47321/works/work:196ee12b/artifacts")
        XCTAssertFalse(url.absoluteString.contains("%253A"))
    }

    func testLargeContentPagingRemainsBoundedAndReplacesPages() {
        XCTAssertEqual(ArtifactContentPagingPolicy.pageBytes, 65_536)
        XCTAssertNil(ArtifactContentPagingPolicy.previousOffset(currentOffset: 0))
        XCTAssertEqual(ArtifactContentPagingPolicy.previousOffset(currentOffset: 65_536), 0)
        XCTAssertEqual(ArtifactContentPagingPolicy.previousOffset(currentOffset: 131_072), 65_536)
    }

    func testArtifactDetailDecodesPinnedVersionHashReferencesAndLazyPageCursor() throws {
        let json = #"""
        {
          "artifactId":"artifact:1","version":2,"contentHash":"abc","mimeType":"text/markdown",
          "totalBytes":70000,"encoding":"utf-8","content":"first page",
          "range":{"offset":0,"byteLength":65536,"nextOffset":65536},
          "complete":false,
          "pendingUpdate":{"version":3,"contentHash":"def"},
          "readReceiptId":"artifact_read_receipt:1","deduplicated":false,
          "turnBudget":{"uniqueBytesUsed":65536,"uniqueBytesLimit":131072,"uniquePagesUsed":1,"uniquePagesLimit":16}
        }
        """#.data(using: .utf8)!
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let detail = try decoder.decode(ArtifactDetailEnvelope.self, from: json)
        XCTAssertEqual(detail.artifactId, "artifact:1")
        XCTAssertEqual(detail.version, 2)
        XCTAssertEqual(detail.contentHash, "abc")
        XCTAssertEqual(detail.range.nextOffset, 65_536)
        XCTAssertFalse(detail.complete)
        XCTAssertEqual(detail.pendingUpdate?.version, 3)
        XCTAssertEqual(detail.turnBudget.uniqueBytesLimit, 131_072)
    }

    func testCorptieTaskPinnedVersionWinsOverStaleApprovedVersion() throws {
        let json = #"{"artifactId":"artifact:1","workId":"work:1","title":"Spec","summary":"","visibility":"task_private","boundTaskId":"task:1","boundSessionId":null,"repositoryLocator":null,"currentVersion":2,"approvedVersion":1,"status":"active","sourceSessionId":null,"sourceEventId":null,"createdByActorId":"session:1","createdAt":"2026-09-01T00:00:00Z","updatedAt":"2026-09-01T00:01:00Z","resourceVersion":2,"versions":[],"references":[{"referenceId":"reference:1","artifactId":"artifact:1","workId":"work:1","taskId":"task:1","sessionId":null,"relation":"implementation_spec","required":true,"versionPolicy":"fixed","pinnedVersion":2,"pinnedHash":"hash-v2","pendingVersion":null,"pendingHash":null,"authorizedByActorId":"session:1","authorizedAt":"2026-09-01T00:00:00Z","revokedAt":null,"revokedByActorId":null,"revocationReason":null,"resourceVersion":2}],"audit":[],"availableActions":[]}"#.data(using: .utf8)!
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let artifact = try decoder.decode(WorkArtifact.self, from: json)

        XCTAssertEqual(
            ArtifactVersionSelectionPolicy.preferredVersion(for: artifact, taskId: "task:1"),
            2
        )
        XCTAssertEqual(
            ArtifactVersionSelectionPolicy.preferredVersion(for: artifact, taskId: nil),
            1
        )
    }

    func testLocalFileReceiptUsesSuggestedMarkdownNameOnlyForDefaultApplicationLookup() throws {
        let json = #"{"artifactId":"artifact:1","version":2,"path":"/data/artifacts/objects/ab/hash","suggestedFilename":"Spec.md","mimeType":"text/markdown"}"#.data(using: .utf8)!
        let receipt = try JSONDecoder().decode(ArtifactLocalFileReceipt.self, from: json)

        XCTAssertEqual(receipt.fileURL.path, "/data/artifacts/objects/ab/hash")
        XCTAssertEqual(receipt.applicationLookupURL.lastPathComponent, "Spec.md")
        XCTAssertEqual(receipt.applicationLookupURL.pathExtension, "md")
        XCTAssertNotEqual(receipt.fileURL, receipt.applicationLookupURL)
    }

    @MainActor
    func testMarkdownLocalFileUsesTheSystemsRegisteredDefaultApplication() throws {
        let receipt = ArtifactLocalFileReceipt(
            artifactId: "artifact:1",
            version: 1,
            path: "/data/artifacts/objects/ab/hash",
            suggestedFilename: "Spec.md",
            mimeType: "text/markdown"
        )
        XCTAssertNotNil(ArtifactSystemApplicationOpener.defaultApplicationURL(for: receipt))
    }

    @MainActor
    func testUnknownArtifactFileTypeHasNoRegisteredDefaultApplication() {
        let receipt = ArtifactLocalFileReceipt(
            artifactId: "artifact:1",
            version: 1,
            path: "/data/artifacts/objects/ab/hash",
            suggestedFilename: "Spec.corptie-unregistered-file-type-6d0d6b",
            mimeType: "application/octet-stream"
        )
        XCTAssertNil(ArtifactSystemApplicationOpener.defaultApplicationURL(for: receipt))
    }

    @MainActor
    func testArtifactContentPreviewUsesOneNativeScrollViewAndDoesNotReplaceUnchangedText() {
        let content = String(repeating: "A line of bounded Artifact content\n", count: 2_048)
        let scrollView = ArtifactContentPreview.makeScrollView(content: content)
        let textView = scrollView.documentView as? NSTextView

        XCTAssertTrue(scrollView.hasVerticalScroller)
        XCTAssertFalse(scrollView.hasHorizontalScroller)
        XCTAssertEqual(textView?.isEditable, false)
        XCTAssertEqual(textView?.isSelectable, true)
        XCTAssertEqual(textView?.string, content)
        XCTAssertFalse(ArtifactContentPreview.update(textView: textView!, content: content))

        scrollView.frame = NSRect(x: 0, y: 0, width: 680, height: 360)
        textView?.frame.size.width = scrollView.contentSize.width
        if let layoutManager = textView?.layoutManager, let textContainer = textView?.textContainer {
            layoutManager.ensureLayout(for: textContainer)
            textView?.frame.size.height = layoutManager.usedRect(for: textContainer).height + 20
        }
        let maximumOffset = max(0, (textView?.frame.height ?? 0) - scrollView.contentSize.height)
        let startedAt = CFAbsoluteTimeGetCurrent()
        for step in 0...240 {
            scrollView.contentView.scroll(to: NSPoint(x: 0, y: maximumOffset * CGFloat(step) / 240))
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }
        let elapsed = CFAbsoluteTimeGetCurrent() - startedAt
        XCTAssertGreaterThan(maximumOffset, 0)
        XCTAssertEqual(scrollView.contentView.bounds.origin.y, maximumOffset, accuracy: 1)
        XCTAssertLessThan(elapsed, 1, "Repeated downward scrolling must remain responsive")

        XCTAssertTrue(ArtifactContentPreview.update(textView: textView!, content: "next page"))
    }
}
