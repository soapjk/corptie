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

struct ScreenContentAnalysisRegion: Equatable, Sendable {
    let identifier: String
    let frame: CGRect
    let previousSignature: OrbLuminanceSignature?
}

struct ScreenContentRegionAnalysis: Equatable, Sendable {
    let identifier: String
    let analysis: OrbContentAnalysis
}

struct ScreenContentAnalysisObservation: Equatable, Sendable {
    let sourceRect: CGRect
    let pixelWidth: Int
    let pixelHeight: Int
    let durationMilliseconds: Int
    let regions: [ScreenContentRegionAnalysis]
}

enum ScreenContentSamplerError: Error, Equatable, CustomStringConvertible {
    case permissionDenied
    case displayUnavailable(CGDirectDisplayID)
    case currentProcessUnavailable
    case invalidSourceRect
    case pixelConversionFailed

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
        case .pixelConversionFailed:
            "pixel_conversion_failed"
        }
    }
}

enum ScreenContentAnalysisGeometry {
    static func outputPixelSize(for sourceRect: CGRect, maximumDimension: Int) -> CGSize? {
        guard sourceRect.width > 0, sourceRect.height > 0, maximumDimension >= 3 else {
            return nil
        }
        let scale = CGFloat(maximumDimension) / max(sourceRect.width, sourceRect.height)
        return CGSize(
            width: max(3, (sourceRect.width * scale).rounded()),
            height: max(3, (sourceRect.height * scale).rounded())
        )
    }

    static func mask(
        for regionFrame: CGRect,
        in sampleRect: CGRect,
        pixelWidth: Int,
        pixelHeight: Int
    ) -> OrbCircularMask? {
        guard sampleRect.width > 0,
              sampleRect.height > 0,
              pixelWidth >= 3,
              pixelHeight >= 3 else {
            return nil
        }
        let pixelsPerPointX = Double(pixelWidth) / sampleRect.width
        let pixelsPerPointY = Double(pixelHeight) / sampleRect.height
        return OrbCircularMask(
            centerX: (regionFrame.midX - sampleRect.minX) * pixelsPerPointX,
            centerY: (sampleRect.maxY - regionFrame.midY) * pixelsPerPointY,
            radius: min(regionFrame.width, regionFrame.height) / 2
                * min(pixelsPerPointX, pixelsPerPointY)
        )
    }
}

enum ScreenContentPixelConverter {
    static func pixelFrame(from image: CGImage) -> OrbContentPixelFrame? {
        let bytesPerRow = image.width * 4
        var bytes = Array(repeating: UInt8(0), count: bytesPerRow * image.height)
        guard let context = CGContext(
            data: &bytes,
            width: image.width,
            height: image.height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }
        context.draw(
            image,
            in: CGRect(x: 0, y: 0, width: image.width, height: image.height)
        )
        return OrbContentPixelFrame(
            width: image.width,
            height: image.height,
            bytesPerRow: bytesPerRow,
            rgbaBytes: bytes
        )
    }
}

actor AsyncSerialGate {
    private var isLocked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        guard isLocked else {
            isLocked = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func release() {
        guard !waiters.isEmpty else {
            isLocked = false
            return
        }
        waiters.removeFirst().resume()
    }
}

actor ScreenContentSampler {
    static let shared = ScreenContentSampler()

    private let outputSize = 384
    private let contentCacheLifetime: TimeInterval = 2
    private let captureGate = AsyncSerialGate()
    private var cachedContent: SCShareableContent?
    private var cachedContentDate = Date.distantPast

    func observe(target: ScreenContentCaptureTarget) async throws -> ScreenContentObservation {
        let capture = try await capture(target: target)
        return ScreenContentObservation(
            sourceRect: capture.sourceRect,
            pixelWidth: capture.image.width,
            pixelHeight: capture.image.height,
            durationMilliseconds: capture.durationMilliseconds
        )
    }

    func analyze(
        target: ScreenContentCaptureTarget,
        regions: [ScreenContentAnalysisRegion]
    ) async throws -> ScreenContentAnalysisObservation {
        let capture = try await capture(target: target)
        guard let frame = ScreenContentPixelConverter.pixelFrame(from: capture.image) else {
            throw ScreenContentSamplerError.pixelConversionFailed
        }

        let analyses = regions.map { region -> ScreenContentRegionAnalysis in
            guard let mask = ScreenContentAnalysisGeometry.mask(
                for: region.frame,
                in: target.sampleRect,
                pixelWidth: frame.width,
                pixelHeight: frame.height
            ) else {
                return ScreenContentRegionAnalysis(
                    identifier: region.identifier,
                    analysis: .unknown(.emptyMask)
                )
            }
            return ScreenContentRegionAnalysis(
                identifier: region.identifier,
                analysis: OrbContentRiskAnalyzer.analyze(
                    frame: frame,
                    mask: mask,
                    previousSignature: region.previousSignature
                )
            )
        }

        return ScreenContentAnalysisObservation(
            sourceRect: capture.sourceRect,
            pixelWidth: capture.image.width,
            pixelHeight: capture.image.height,
            durationMilliseconds: capture.durationMilliseconds,
            regions: analyses
        )
    }

    func invalidateCache() {
        cachedContent = nil
        cachedContentDate = .distantPast
    }

    private func capture(
        target: ScreenContentCaptureTarget
    ) async throws -> (sourceRect: CGRect, image: CGImage, durationMilliseconds: Int) {
        await captureGate.acquire()
        do {
            let result = try await performCapture(target: target)
            await captureGate.release()
            return result
        } catch {
            await captureGate.release()
            throw error
        }
    }

    private func performCapture(
        target: ScreenContentCaptureTarget
    ) async throws -> (sourceRect: CGRect, image: CGImage, durationMilliseconds: Int) {
        try Task.checkCancellation()
        guard ScreenCapturePermissionStatus.current == .authorized else {
            throw ScreenContentSamplerError.permissionDenied
        }
        guard let sourceRect = DetachedOrbObservationGeometry.sourceRect(
            for: target.sampleRect,
            in: target.screenFrame
        ), let outputSize = ScreenContentAnalysisGeometry.outputPixelSize(
            for: sourceRect,
            maximumDimension: outputSize
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
        configuration.width = Int(outputSize.width)
        configuration.height = Int(outputSize.height)
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.preservesAspectRatio = false

        let startedAt = Date()
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        let elapsed = max(0, Date().timeIntervalSince(startedAt))
        return (
            sourceRect,
            image,
            Int((elapsed * 1_000).rounded())
        )
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
