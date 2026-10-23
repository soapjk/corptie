import Foundation

/// Account-management presentation only; never derives identity from a device name.
public enum CloudDeviceManagement {
    public static func validateRevocation(_ receipt: CloudDevice, requestedID: UUID) throws {
        guard receipt.id == requestedID, receipt.revokedAt != nil else {
            throw ClientConnectionError.invalidResponse
        }
    }

    public static func failureMessage(_ error: any Error) -> String {
        if let failure = error as? ClientServiceFailure {
            if failure.code == "RECENT_AUTHENTICATION_REQUIRED" {
                return "为保护账号，移除设备需要最近 5 分钟内重新验证账号。验证后请重新确认要移除的设备。"
            }
            return statusMessage(failure.statusCode)
        }
        if let failure = error as? ClientConnectionError, case .httpStatus(let status) = failure {
            return statusMessage(status)
        }
        if error is URLError {
            return "暂时无法确认设备是否已移除。请检查网络并刷新设备列表后核对，不要重复操作。"
        }
        return "尚未确认设备移除成功，请刷新设备列表后核对。不会自动清除账号或配对凭据。"
    }

    private static func statusMessage(_ status: Int) -> String {
        switch status {
        case 401: return "Cloud 登录授权已失效，请重新登录后再确认要移除的设备。"
        case 403: return "当前账号没有移除此设备的权限，设备未移除。"
        case 404: return "此设备已不可见，请刷新设备列表核对。"
        case 500...599: return "Cloud 暂时无法确认移除结果，请稍后刷新设备列表核对。"
        default: return "设备移除未完成（HTTP \(status)），请刷新设备列表后重试。"
        }
    }
}
