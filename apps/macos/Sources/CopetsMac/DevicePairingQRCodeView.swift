import SwiftUI
import CoreImage.CIFilterBuiltins
import CorptieClientCore

enum DevicePairingQRImage {
    static func make(_ payload: String) -> CGImage? {
        let generator = CIFilter.qrCodeGenerator()
        generator.message = Data(payload.utf8)
        generator.correctionLevel = "M"
        guard let output = generator.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 6, y: 6))
        return CIContext(options: [.useSoftwareRenderer: true]).createCGImage(scaled, from: scaled.extent)
    }
}

/// Render once per invitation/address, not on every settings update or clock tick.
struct DevicePairingQRCodeView: View {
    let invite: ClientDeviceInvite
    @State private var address = ""
    @State private var image: CGImage?
    @State private var notice = "请输入已配置的 HTTPS 设备接入地址，不是 Mac 的本地 HTTP 地址。"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if invite.address == nil {
                TextField("iPad 可访问的 HTTPS 地址（含端口）", text: $address)
                    .textFieldStyle(.roundedBorder)
                Button("显示配对二维码") { generate() }
            }
            if let image {
                Image(decorative: image, scale: 1)
                    .interpolation(.none).resizable().scaledToFit()
                    .frame(width: 280, height: 280).padding(20).background(.white)
                    .accessibilityLabel("一次性配对二维码，请使用 Corptie iPad 客户端扫描")
                Text("在手机或 iPad 点击「扫码配对 Mac」，然后在此页批准设备。两台设备需要处于同一局域网。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(notice).font(.caption).foregroundStyle(.secondary)
        }
        .onChange(of: address) { if invite.address == nil { image = nil } }
        .task(id: invite.pairingId) {
            if let configured = invite.address { address = configured; generate() }
            let seconds = max(0, invite.expiresAt / 1000 - Date().timeIntervalSince1970)
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            image = nil; notice = "二维码已过期，请重新生成配对信息。"
        }
        .onDisappear { image = nil }
    }
    private func generate() {
        do {
            let code = DevicePairingCode(address: address.trimmingCharacters(in: .whitespacesAndNewlines),
                serverId: invite.serverId, pairingId: invite.pairingId,
                pairingSecret: invite.pairingSecret, expiresAt: invite.expiresAt, certificate: invite.certificate)
            image = DevicePairingQRImage.make(try code.encoded())
            notice = image == nil ? "二维码生成失败，请重试。" : "5 分钟内有效，请勿分享截图。扫码会校验这台 Mac 的安全身份。"
        } catch DevicePairingCode.CodeError.expired {
            image = nil; notice = "二维码已过期，请重新生成配对信息。"
        } catch {
            image = nil; notice = "请填写有效 HTTPS 地址，不能使用 localhost、127.0.0.1 或 0.0.0.0。"
        }
    }
}
