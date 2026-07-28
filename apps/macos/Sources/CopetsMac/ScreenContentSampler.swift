import CoreGraphics
import Foundation
import ScreenCaptureKit

enum ScreenCapturePermissionStatus: Equatable, Sendable {
    case authorized
    case notGranted

    static var current: Self {
        CGPreflightScreenCaptureAccess() ? .authorized : .notGranted
    }
}

struct ScreenContentCaptureTarget: Sendable {
    let displayID: CGDirectDisplayID
    let screenFrame: CGRect
    let sampleRect: CGRect
}

struct ScreenContentObservation: Equatable, Sendable {
    let sourceRect: CGRect
    let pixelWidth: Int
    let pixelHeight: Int
    let durationMilliseconds: Int
}

enum ScreenContentSamplerError: Error, Equatable, CustomStringConvertible {
    case permissionDenied
    case displayUnavailable(CGDirectDisplayID)
    case currentProcessUnavailable
    case invalidSourceRect

    var description: String {
        switch self {
        case .permissionDenied:
            "permission_denied"
        case let .displayUnavailable(displayID):
            "display_unavailable_\(displayID)"
        case .currentProcessUnavailable:
            "current_process_unavailable"
        case .invalidSourceRect:
            "invalid_source_rect"
        }
    }
}

actor ScreenContentSampler {
    static let shared = ScreenContentSampler()

    private let outputSize = 256
    private let contentCacheLifetime: TimeInterval = 2
    private var cachedContent: SCShareableContent?
    private var cachedContentDate = Date.distantPast

    func observe(target: ScreenContentCaptureTarget) async throws -> ScreenContentObservation {
        guard ScreenCapturePermissionStatus.current == .authorized else {
            throw ScreenContentSamplerError.permissionDenied
        }
        guard let sourceRect = DetachedOrbObservationGeometry.sourceRect(
            for: target.sampleRect,
            in: target.screenFrame
        ) else {
            throw ScreenContentSamplerError.invalidSourceRect
        }

        let content = try await shareableContent()
        guard let display = content.displays.first(where: { $0.displayID == target.displayID }) else {
            throw ScreenContentSamplerError.displayUnavailable(target.displayID)
        }

        let currentProcessID = ProcessInfo.processInfo.processIdentifier
        let filter: SCContentFilter
        if let currentApplication = content.applications.first(where: {
            $0.processID == currentProcessID
        }) {
            filter = SCContentFilter(
                display: display,
                excludingApplications: [currentApplication],
                exceptingWindows: []
            )
        } else {
            let currentProcessWindows = content.windows.filter {
                $0.owningApplication?.processID == currentProcessID
            }
            guard !currentProcessWindows.isEmpty else {
                throw ScreenContentSamplerError.currentProcessUnavailable
            }
            filter = SCContentFilter(display: display, excludingWindows: currentProcessWindows)
        }

        let configuration = SCStreamConfiguration()
        configuration.sourceRect = sourceRect
        configuration.width = outputSize
        configuration.height = outputSize
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.preservesAspectRatio = false

        let startedAt = Date()
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        let elapsed = max(0, Date().timeIntervalSince(startedAt))

        return ScreenContentObservation(
            sourceRect: sourceRect,
            pixelWidth: image.width,
            pixelHeight: image.height,
            durationMilliseconds: Int((elapsed * 1_000).rounded())
        )
    }

    func invalidateCache() {
        cachedContent = nil
        cachedContentDate = .distantPast
    }

    private func shareableContent() async throws -> SCShareableContent {
        if let cachedContent,
           Date().timeIntervalSince(cachedContentDate) < contentCacheLifetime {
            return cachedContent
        }

        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        cachedContent = content
        cachedContentDate = Date()
        return content
    }
}
