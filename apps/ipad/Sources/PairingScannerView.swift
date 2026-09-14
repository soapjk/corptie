import SwiftUI
import VisionKit
import AVFoundation

struct PairingScannerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let onScan: (String) -> Void
    @State private var ready = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Group {
                if ready, scenePhase == .active, error.isEmpty {
                    NativePairingScanner(onScan: { payload in onScan(payload); dismiss() }, onError: { error = $0 })
                        .overlay(alignment: .bottom) {
                            Text("扫描 Mac「设备接入」中的配对二维码")
                                .font(.callout).padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)).padding()
                        }
                } else if !error.isEmpty {
                    ContentUnavailableView("无法扫码", systemImage: "camera", description: Text(error))
                } else { ProgressView("正在准备相机") }
            }
            .navigationTitle("扫码配对").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .task {
                guard DataScannerViewController.isSupported else {
                    error = "此设备不支持系统扫码，请返回手动填写配对信息。"; return
                }
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                guard !Task.isCancelled else { return }
                guard granted, DataScannerViewController.isAvailable else {
                    error = "请在系统设置中允许 Corptie 使用相机；也可返回手动配对。"; return
                }
                ready = true
            }
        }
    }
}

private struct NativePairingScanner: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onError: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan, onError: onError) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }
    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        guard !scanner.isScanning, !context.coordinator.finished else { return }
        do { try scanner.startScanning() }
        catch {
            let coordinator = context.coordinator
            Task { @MainActor in coordinator.fail() }
        }
    }
    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        coordinator.finished = true
        scanner.stopScanning(); scanner.delegate = nil
    }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        let onError: (String) -> Void
        var finished = false
        init(onScan: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
            self.onScan = onScan; self.onError = onError
        }
        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            consume(addedItems, scanner: scanner)
        }
        func dataScanner(_ scanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            consume(updatedItems, scanner: scanner)
        }
        private func consume(_ items: [RecognizedItem], scanner: DataScannerViewController) {
            guard !finished else { return }
            for item in items {
                if case .barcode(let code) = item, let payload = code.payloadStringValue {
                    finished = true; scanner.stopScanning(); onScan(payload); return
                }
            }
        }
        func dataScanner(_ scanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            scanner.stopScanning(); fail()
        }
        func fail() {
            guard !finished else { return }
            finished = true
            onError("相机暂不可用，请关闭后重试，或使用手动配对。")
        }
    }
}
