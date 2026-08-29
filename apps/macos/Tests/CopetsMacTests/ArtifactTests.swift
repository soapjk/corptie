import AppKit
import XCTest
@testable import CorptieMac

final class ArtifactTests: XCTestCase {
    func testArtifactEndpointEncodesCanonicalIdentifiersExactlyOnce() {
        let url = ArtifactAPIClient.endpointURL(
            baseURL: URL(string: "http://127.0.0.1:47321/")!,
            path: "objectives/objective:196ee12b/artifacts"
        )
        XCTAssertEqual(url.absoluteString, "http://127.0.0.1:47321/objectives/objective:196ee12b/artifacts")
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
          "artifact": {
            "artifactId":"artifact:1","objectiveId":"objective:1","title":"Spec","summary":"summary",
            "visibility":"objective_private","boundWorkItemId":null,"boundSessionId":null,"repositoryLocator":null,
            "currentVersion":2,"approvedVersion":2,"status":"active","sourceSessionId":"session:source","sourceEventId":"event:1",
            "createdByActorId":"agent:1","createdAt":"2026-08-23T00:00:00Z","updatedAt":"2026-08-23T00:00:00Z","resourceVersion":2,
            "versions":[{"artifactId":"artifact:1","version":2,"contentHash":"abc","byteLength":70000,"mimeType":"text/markdown","storageKey":"objects/ab/abc","sourceSessionId":"session:source","sourceEventId":"event:1","supersedesVersion":1,"approvalStatus":"approved","createdByActorId":"agent:1","createdAt":"2026-08-23T00:00:00Z"}],
            "references":[{"referenceId":"artifact_reference:1","artifactId":"artifact:1","objectiveId":"objective:1","workItemId":"work_item:1","sessionId":null,"relation":"implementation_spec","required":true,"versionPolicy":"fixed","pinnedVersion":2,"pinnedHash":"abc","pendingVersion":null,"pendingHash":null,"authorizedByActorId":"agent:1","authorizedAt":"2026-08-23T00:00:00Z","revokedAt":null,"revokedByActorId":null,"revocationReason":null,"resourceVersion":1}],
            "audit":[]
          },
          "version":{"artifactId":"artifact:1","version":2,"contentHash":"abc","byteLength":70000,"mimeType":"text/markdown","storageKey":"objects/ab/abc","sourceSessionId":"session:source","sourceEventId":"event:1","supersedesVersion":1,"approvalStatus":"approved","createdByActorId":"agent:1","createdAt":"2026-08-23T00:00:00Z"},
          "content":"first page","offset":0,"nextOffset":65536,"truncated":true,
          "references":[{"referenceId":"artifact_reference:1","artifactId":"artifact:1","objectiveId":"objective:1","workItemId":"work_item:1","sessionId":null,"relation":"implementation_spec","required":true,"versionPolicy":"fixed","pinnedVersion":2,"pinnedHash":"abc","pendingVersion":null,"pendingHash":null,"authorizedByActorId":"agent:1","authorizedAt":"2026-08-23T00:00:00Z","revokedAt":null,"revokedByActorId":null,"revocationReason":null,"resourceVersion":1}]
        }
        """#.data(using: .utf8)!
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let detail = try decoder.decode(ArtifactDetailEnvelope.self, from: json)
        XCTAssertEqual(detail.artifact.visibility, .objectivePrivate)
        XCTAssertEqual(detail.version.contentHash, "abc")
        XCTAssertTrue(detail.references[0].required)
        XCTAssertEqual(detail.nextOffset, 65_536)
        XCTAssertTrue(detail.truncated)
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
