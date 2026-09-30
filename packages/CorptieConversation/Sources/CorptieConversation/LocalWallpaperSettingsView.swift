import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import PhotosUI
#endif

/// The same device-local appearance control is used by both settings windows.
public struct LocalWallpaperSettingsView: View {
    @ObservedObject private var wallpaper = LocalWallpaperStore.shared
    @State private var presentsFileImporter = false
    @State private var isProcessing = false
    @State private var pickerError: String?
    #if os(iOS)
    @State private var selectedPhoto: PhotosPickerItem?
    #endif

    public init() {}

    public var body: some View {
        Form {
            Section {
                preview
                HStack(spacing: 12) {
                    Button("选择图片…", systemImage: "photo.on.rectangle") {
                        presentsFileImporter = true
                    }
                    .disabled(isProcessing)
                    .accessibilityIdentifier("appearance.wallpaper.chooseFile")

                    #if os(iOS)
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        Label("从照片选择", systemImage: "photo")
                    }
                    .disabled(isProcessing)
                    .accessibilityIdentifier("appearance.wallpaper.choosePhoto")
                    #endif

                    Button("恢复默认") {
                        pickerError = nil
                        wallpaper.restoreDefault()
                    }
                        .disabled(!wallpaper.hasWallpaper || isProcessing)
                        .accessibilityIdentifier("appearance.wallpaper.reset")
                }
                if isProcessing {
                    ProgressView("正在处理图片…")
                        .accessibilityIdentifier("appearance.wallpaper.progress")
                }
                if let error = pickerError ?? wallpaper.errorMessage {
                    Text(error)
                        .foregroundStyle(.red)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            } header: {
                Text("全局背景")
            } footer: {
                Text("图片只保存在当前设备，不会同步。导入时会自动缩小尺寸，以保持滚动流畅。")
            }
        }
        .fileImporter(
            isPresented: $presentsFileImporter,
            allowedContentTypes: [.image]
        ) { result in
            switch result {
            case .success(let url):
                pickerError = nil
                isProcessing = true
                Task {
                    await wallpaper.importFile(url)
                    isProcessing = false
                }
            case .failure(let error):
                pickerError = "无法打开所选文件：\(error.localizedDescription)"
            }
        }
        #if os(iOS)
        .onChange(of: selectedPhoto) { _, photo in
            guard let photo else { return }
            pickerError = nil
            isProcessing = true
            Task {
                defer {
                    isProcessing = false
                    selectedPhoto = nil
                }
                do {
                    guard let data = try await photo.loadTransferable(type: Data.self) else {
                        pickerError = "无法读取所选照片。"
                        return
                    }
                    await wallpaper.importImageData(data)
                } catch {
                    pickerError = "无法读取所选照片：\(error.localizedDescription)"
                }
            }
        }
        #endif
    }

    private var preview: some View {
        GeometryReader { geometry in
            Group {
                if let image = wallpaper.image {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .scaledToFill()
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .clipped()
                } else {
                    WorkbenchCanvasSurface.defaultColor
                        .overlay {
                            Text("默认背景")
                                .foregroundStyle(.secondary)
                        }
                }
            }
        }
        .frame(height: 190)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
        }
        .accessibilityLabel(wallpaper.hasWallpaper ? "当前自定义背景预览" : "当前使用默认背景")
    }
}
