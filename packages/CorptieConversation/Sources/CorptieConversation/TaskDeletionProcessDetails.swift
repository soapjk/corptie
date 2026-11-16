import SwiftUI
import CorptieClientCore

/// No polling or view-owned inspection: renders the deletion plan's snapshot.
public struct TaskDeletionProcessDetails: View {
    private let processes: [ClientDeletionProcess]
    public init(processes: [ClientDeletionProcess]) { self.processes = processes }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("进程正在使用工作区；停止可能中断任务并丢失未保存的数据。")
                .font(.callout).foregroundStyle(.orange)
            ForEach(processes) { process in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(process.applicationName ?? process.processName ?? "未知进程") · PID \(process.pid)")
                        .font(.callout.weight(.semibold))
                    Text(status(process)).font(.caption)
                    Text(process.purpose ?? "用途未知：系统信息不能确认它正在执行什么任务。")
                        .font(.caption).foregroundStyle(.secondary)
                    DisclosureGroup("查看进程路径与详情") {
                        VStack(alignment: .leading, spacing: 4) {
                            field("应用程序路径", process.applicationPath ?? "未识别到应用程序包")
                            field("可执行文件", process.executablePath ?? "无法读取")
                            field("工作目录", process.workingDirectory ?? "无法读取")
                            field("父进程 PID", process.parentPid.map(String.init) ?? "未知")
                            field("已运行时间", process.elapsed ?? "未知")
                            if process.detailError != nil {
                                Text("部分详情无法读取，进程可能已退出或权限不足；请重新检查。")
                            }
                            if process.canStop == false {
                                Text("当前无法安全核验此进程的停止权限或身份。")
                            }
                        }
                        .font(.caption).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .font(.caption)
                }
            }
            Text("选择停止后，将先请求退出；未退出时强制终止。确认进程停止后才继续删除。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func field(_ title: String, _ value: String) -> some View {
        Text("\(title)：\(value)").fixedSize(horizontal: false, vertical: true)
    }

    private func status(_ process: ClientDeletionProcess) -> String {
        let state = switch process.state {
        case "zombie": "已退出，等待父进程回收（僵尸进程）；再次终止无效"
        case "running": "正在运行"
        case "waiting": "等待中／休眠；不代表僵尸或无响应"
        case "stopped": "已暂停；尚未退出"
        default: "状态未知"
        }
        return process.orphaned == true ? state + " · 父进程已退出或由系统托管，不等于僵尸进程" : state
    }
}
