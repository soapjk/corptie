import SwiftUI
import CorptieClientCore

/// Shared by Mac, iPhone and iPad; no networking, timers or local persistence.
public struct CloudDeviceRow: View {
    private let device: CloudDevice
    private let isCurrentDevice: Bool
    private let isConnected: Bool
    private let hasDuplicateName: Bool
    private let busy: Bool
    private let connect: (() -> Void)?
    private let remove: () -> Void

    public init(device: CloudDevice, isCurrentDevice: Bool, isConnected: Bool = false,
                hasDuplicateName: Bool, busy: Bool, connect: (() -> Void)? = nil,
                remove: @escaping () -> Void) {
        self.device = device
        self.isCurrentDevice = isCurrentDevice
        self.isConnected = isConnected
        self.hasDuplicateName = hasDuplicateName
        self.busy = busy
        self.connect = connect
        self.remove = remove
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: device.kind == .mac ? "desktopcomputer" : "ipad.and.iphone")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                if let connect, !isConnected {
                    Button(action: connect) { Text(device.displayName).foregroundStyle(.primary) }
                        .buttonStyle(.plain)
                        .disabled(busy)
                        .accessibilityLabel("连接 \(device.displayName)")
                } else {
                    Text(device.displayName)
                }
                if isCurrentDevice {
                    Text(device.kind == .mac ? "此 Mac" : "此设备")
                        .font(.caption).foregroundStyle(.secondary)
                } else if isConnected {
                    Text("当前连接").font(.caption).foregroundStyle(.secondary)
                }
                Text("注册于 \(device.createdAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
                Text("最近联系 \(device.lastSeenAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
                if hasDuplicateName {
                    Text("设备编号 \(String(device.id.uuidString.prefix(8)))")
                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if !isCurrentDevice {
                Menu {
                    Button("移除设备…", role: .destructive, action: remove)
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .frame(minWidth: 28, minHeight: 28)
                }
                .menuIndicator(.hidden)
                .disabled(busy)
                .accessibilityLabel("管理设备 \(device.displayName)")
            }
        }
    }
}

public struct CloudDeviceRemovalMessage: View {
    private let device: CloudDevice?
    private let disconnectsCurrentMac: Bool

    public init(device: CloudDevice?, disconnectsCurrentMac: Bool = false) {
        self.device = device
        self.disconnectsCurrentMac = disconnectsCurrentMac
    }

    public var body: some View {
        if let device {
            Text("\(device.displayName)\n注册于 \(device.createdAt.formatted(date: .abbreviated, time: .shortened))\n设备编号 \(device.id.uuidString)\n\n这台设备将失去 Cloud 访问权限，现有远程连接会关闭。不会删除业务数据，也不会移除独立的局域网配对。\(disconnectsCurrentMac ? "\n\n你正在连接这台 Mac；移除后当前连接将断开，需要在 Mac 上重新登录才能再次接入。" : "")\n\n此操作需要最近重新验证账号。")
        }
    }
}
