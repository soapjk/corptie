import Foundation
import os

/// 轻量打点：dev 版把关键路径耗时直接打印到日志，供性能迭代测量。
/// 生产环境（`CorptieAppEnvironment.isDevelopment == false`）下所有打点编译期短路为零成本。
///
/// 用法：
///   PerfStopwatch.measure("切Tab.sessions") { ... }
///   PerfStopwatch.event("会话切换", value: 1)
enum PerfStopwatch {
    private static let logger = Logger(subsystem: "com.corptie.mac", category: "PerfInstrument")

    private static var enabled: Bool {
        let value = ProcessInfo.processInfo.environment["CORPTIE_ENV"]?.lowercased() ?? "production"
        return ["dev", "development"].contains(value)
    }

    /// 同步测量代码块耗时，结束时打印。
    @inline(__always)
    static func measure<T>(_ name: String, _ body: () throws -> T) rethrows -> T {
        guard enabled else { return try body() }
        let clock = ContinuousClock()
        let start = clock.now
        defer {
            let elapsed = start.duration(to: clock.now)
            logger.info("⏱ \(name, privacy: .public) = \(String(format: "%.2f", elapsed.milliseconds), privacy: .public) ms")
        }
        return try body()
    }

    /// 异步测量（主线程场景）。
    @inline(__always)
    @MainActor
    static func measure<T>(_ name: String, _ body: () async throws -> T) async rethrows -> T {
        guard enabled else { return try await body() }
        let clock = ContinuousClock()
        let start = clock.now
        defer {
            let elapsed = start.duration(to: clock.now)
            logger.info("⏱ \(name, privacy: .public) = \(String(format: "%.2f", elapsed.milliseconds), privacy: .public) ms")
        }
        return try await body()
    }

    /// 关键事件打点（计数型），用于观察某路径被触发的频率。
    @inline(__always)
    static func event(_ name: String, value: Int = 1) {
        guard enabled else { return }
        logger.info("• \(name, privacy: .public) (\(value, privacy: .public))")
    }
}

private extension Duration {
    var milliseconds: Double {
        Double(components.seconds) * 1000 + Double(components.attoseconds) / 1e15
    }
}
