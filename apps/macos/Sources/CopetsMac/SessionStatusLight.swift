import SwiftUI

/// 极简会话状态指示灯，替代列表中原先的复合头像（StatusHalo + AgentAvatar + ConnectionIndicatorLight）。
///
/// 三态映射：
/// - running               → 绿色，缓慢呼吸（渐隐渐现）
/// - failed / cancelled    → 红色（中断或出错）
/// - blocked / complete    → 鲜艳橙色（空闲）
///
/// 设计目标：纯 SwiftUI 圆点，无离屏 ImageRenderer、无 CALayer 旋转、无磁盘图片加载，
/// 避免大量会话行各自持有昂贵的离屏渲染与持续动画导致主线程/合成层压力。
struct SessionStatusLight: View {
    let status: TaskStatus
    let diameter: CGFloat

    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: diameter, height: diameter)
            .shadow(color: color.opacity(0.45), radius: diameter * 0.55)
            .opacity(isBreathing ? breathOpacity : 1.0)
            .animation(
                accessibilityReduceMotion ? nil : .easeInOut(duration: 1.4).repeatForever(autoreverses: true),
                value: breathPhase
            )
            .onAppear { startBreathingIfNeeded() }
            .onChange(of: status) { _, _ in startBreathingIfNeeded() }
    }

    private var isBreathing: Bool {
        status == .running
    }

    private var color: Color {
        switch status {
        case .running:
            CorptiePalette.connected
        case .failed, .cancelled:
            .red
        case .blocked, .complete:
            .orange
        }
    }

    @State private var breathPhase = false
    private var breathOpacity: Double { breathPhase ? 0.35 : 1.0 }

    private func startBreathingIfNeeded() {
        guard isBreathing, !accessibilityReduceMotion else {
            breathPhase = false
            return
        }
        breathPhase = false
        DispatchQueue.main.async {
            guard self.isBreathing else { return }
            breathPhase = true
        }
    }
}
