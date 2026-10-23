import Foundation
#if os(macOS)
import Darwin

public enum LocalCredentialError: Error, LocalizedError, Sendable {
    case unavailable, corrupt, busy, conflict, migrationRequired, unsupportedVersion, commitUnknown
    public var errorDescription: String? {
        switch self {
        case .unavailable: "本地凭据存储不可用，请检查目录和权限"
        case .corrupt: "本地凭据文件损坏，原文件已保留"
        case .busy: "凭据正在被其他操作使用，请稍后重试"
        case .conflict: "凭据已发生变化，请重新操作"
        case .migrationRequired: "需要导入旧缓存密钥，原有恢复记录已保留"
        case .unsupportedVersion: "凭据文件由较新版本创建，请更新应用"
        case .commitUnknown: "凭据保存结果需要重新核对，请重试"
        }
    }
}

/// Called from a storage actor, never the UI executor. The lock inode remains
/// stable across atomic replacement of the data file. No Keychain fallback.
struct PrivateCredentialFile: Sendable {
    let directory: URL
    let name: String
    let maximumBytes: Int

    private func validate(_ fd: Int32, directory: Bool) throws {
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(),
              (info.st_mode & S_IFMT) == (directory ? S_IFDIR : S_IFREG),
              directory || info.st_nlink == 1 else { throw LocalCredentialError.unavailable }
        guard fchmod(fd, directory ? 0o700 : 0o600) == 0 else { throw LocalCredentialError.unavailable }
    }

    func access<T>(_ operation: (Int32) throws -> T) throws -> T {
        do { return try accessChecked(operation) }
        catch let error as LocalCredentialError { throw error }
        catch { throw LocalCredentialError.unavailable }
    }

    private func accessChecked<T>(_ operation: (Int32) throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let root = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else { throw LocalCredentialError.unavailable }
        defer { close(root) }
        try validate(root, directory: true)
        let lock = openat(root, "credentials.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lock >= 0 else { throw LocalCredentialError.unavailable }
        defer { close(lock) }
        try validate(lock, directory: false)
        guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw LocalCredentialError.busy }
        defer { _ = flock(lock, LOCK_UN) }
        return try operation(root)
    }

    func read(at root: Int32) throws -> Data? {
        let fd = openat(root, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else {
            if errno == ENOENT { return nil }
            throw LocalCredentialError.unavailable
        }
        defer { close(fd) }
        try validate(fd, directory: false)
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_size >= 0, info.st_size <= maximumBytes else {
            throw LocalCredentialError.corrupt
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        guard let data = try handle.read(upToCount: maximumBytes + 1), data.count <= maximumBytes else {
            throw LocalCredentialError.corrupt
        }
        return data
    }

    func write(_ data: Data, at root: Int32) throws {
        guard data.count <= maximumBytes else { throw LocalCredentialError.unavailable }
        let temporary = ".credentials-\(UUID().uuidString).tmp"
        let fd = openat(root, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw LocalCredentialError.unavailable }
        defer { close(fd); _ = unlinkat(root, temporary, 0) }
        try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: data)
        guard fsync(fd) == 0, renameat(root, temporary, root, name) == 0 else {
            throw LocalCredentialError.unavailable
        }
        guard fsync(root) == 0 else { throw LocalCredentialError.commitUnknown }
    }
}
#endif
