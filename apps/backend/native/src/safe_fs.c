#define _DARWIN_C_SOURCE 1
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct {
  uint64_t root_device;
  uint64_t root_inode;
  uint64_t target_device;
  uint64_t target_inode;
  uint64_t files;
  uint64_t bytes;
  char error_code[64];
  char error_message[256];
} CorptieSafeTreeResult;

static int fail(CorptieSafeTreeResult *out, const char *code, const char *message) {
  snprintf(out->error_code, sizeof(out->error_code), "%s", code);
  snprintf(out->error_message, sizeof(out->error_message), "%s", message);
  return -1;
}

static int fail_errno(CorptieSafeTreeResult *out, const char *code, const char *operation) {
  char message[256];
  snprintf(message, sizeof(message), "%s: %s", operation, strerror(errno));
  return fail(out, code, message);
}

static int safe_component(const char *value) {
  return value && value[0] && strcmp(value, ".") != 0 && strcmp(value, "..") != 0 && strchr(value, '/') == NULL;
}

static int publish_at(int parent, const char *name, const unsigned char *bytes, size_t length, CorptieSafeTreeResult *out) {
  char temporary[96];
  snprintf(temporary, sizeof(temporary), ".corptie-write-%ld-%08x-%08x", (long)getpid(), arc4random(), arc4random());
  int fd = openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return fail_errno(out, "ARTIFACT_WRITE_FAILED", "openat temporary");
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, bytes + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) { fail_errno(out, "ARTIFACT_WRITE_FAILED", "write temporary"); goto failed; }
    offset += (size_t)written;
  }
  if (fsync(fd)) { fail_errno(out, "ARTIFACT_WRITE_FAILED", "fsync temporary"); goto failed; }
  if (linkat(parent, temporary, parent, name, 0)) {
    fail_errno(out, errno == EEXIST ? "ARTIFACT_DESTINATION_EXISTS" : "ARTIFACT_WRITE_FAILED", "publish new file"); goto failed;
  }
  out->files = 1; out->bytes = length;
  close(fd); unlinkat(parent, temporary, 0);
  if (fsync(parent)) return fail_errno(out, "ARTIFACT_WRITE_FAILED", "fsync parent");
  return 0;
failed:
  close(fd); unlinkat(parent, temporary, 0); return -1;
}

// Bounded, descriptor-relative preparation of the reserved local state root.
// This is deliberately not recursive tree inspection/deletion.
typedef struct {
  uint64_t root_device, root_inode, directory_device, directory_inode, ignore_device, ignore_inode;
  int exists, ignore_exists, created_directory, created_ignore, retained;
  char ignore_text[65537];
  char error_code[64], error_message[256];
} CorptieLocalStateResult;

static int local_fail(CorptieLocalStateResult *out, const char *code) {
  if (!strcmp(code, "LOCAL_STATE_PATH_UNSAFE") && (errno == EACCES || errno == EPERM || errno == EROFS))
    code = "LOCAL_STATE_PERMISSION_DENIED";
  snprintf(out->error_code, sizeof(out->error_code), "%s", code);
  snprintf(out->error_message, sizeof(out->error_message), "%s", strerror(errno));
  return -1;
}

static int local_empty_except_ignore(int fd) {
  int copy = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (copy < 0) return -1;
  DIR *dir = fdopendir(copy);
  if (!dir) { close(copy); return -1; }
  struct dirent *entry;
  int empty = 1;
  errno = 0;
  while ((entry = readdir(dir))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..") || !strcmp(entry->d_name, ".gitignore")) continue;
    empty = 0; break;
  }
  if (!entry && errno) empty = -1;
  closedir(dir);
  return empty;
}

int corptie_local_state(const char *root, int create, uint64_t expected_device, uint64_t expected_inode,
                       uint64_t expected_directory_device, uint64_t expected_directory_inode,
                       CorptieLocalStateResult *out) {
  int root_fd = -1, directory = -1, ignore = -1;
  struct stat root_stat, dir_stat, file_stat, current;
  root_fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0 || fstat(root_fd, &root_stat)) goto unsafe;
  out->root_device = root_stat.st_dev; out->root_inode = root_stat.st_ino;
  if (expected_inode && (out->root_device != expected_device || out->root_inode != expected_inode)) goto changed;
  if (fstatat(root_fd, ".corptie", &dir_stat, AT_SYMLINK_NOFOLLOW)) {
    if (errno != ENOENT) goto unsafe;
    if (!create) { close(root_fd); return 0; }
    if (!mkdirat(root_fd, ".corptie", 0700)) out->created_directory = 1;
    else if (errno != EEXIST) goto unsafe;
  }
  directory = openat(root_fd, ".corptie", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0 || fstat(directory, &dir_stat)) goto unsafe;
  out->exists = 1; out->directory_device = dir_stat.st_dev; out->directory_inode = dir_stat.st_ino;
  if (expected_directory_inode && (out->directory_device != expected_directory_device
      || out->directory_inode != expected_directory_inode)) goto changed;
  if (create && faccessat(directory, ".", W_OK | X_OK, 0)) goto unsafe;
  if (fstatat(directory, ".gitignore", &file_stat, AT_SYMLINK_NOFOLLOW)) {
    if (errno != ENOENT) goto unsafe;
    if (!create) goto verified;
    int empty = local_empty_except_ignore(directory);
    if (empty != 1) { errno = empty == 0 ? ENOTEMPTY : errno; local_fail(out, "LOCAL_STATE_EXISTING_CONTENT"); goto failed; }
    CorptieSafeTreeResult publication = {0};
    if (publish_at(directory, ".gitignore", (const unsigned char *)"*\n", 2, &publication)) {
      if (strcmp(publication.error_code, "ARTIFACT_DESTINATION_EXISTS")) goto unsafe;
    } else out->created_ignore = 1;
  }
  ignore = openat(directory, ".gitignore", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (ignore < 0 || fstat(ignore, &file_stat) || !S_ISREG(file_stat.st_mode)
      || file_stat.st_size <= 0 || file_stat.st_size > 65536) goto unsafe;
  out->ignore_exists = 1; out->ignore_device = file_stat.st_dev; out->ignore_inode = file_stat.st_ino;
  ssize_t count = pread(ignore, out->ignore_text, (size_t)file_stat.st_size, 0);
  if (count != file_stat.st_size || memchr(out->ignore_text, 0, count)) goto unsafe;
  out->ignore_text[count] = 0;
verified:
  if (lstat(root, &current) || !S_ISDIR(current.st_mode) || current.st_dev != root_stat.st_dev || current.st_ino != root_stat.st_ino) goto changed;
  if (fstatat(root_fd, ".corptie", &current, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(current.st_mode)
      || current.st_dev != dir_stat.st_dev || current.st_ino != dir_stat.st_ino) goto changed;
  if (out->ignore_exists && (fstatat(directory, ".gitignore", &current, AT_SYMLINK_NOFOLLOW)
      || !S_ISREG(current.st_mode) || current.st_dev != file_stat.st_dev || current.st_ino != file_stat.st_ino)) goto changed;
  if (ignore >= 0) close(ignore);
  close(directory); close(root_fd); return 0;
unsafe:
  local_fail(out, "LOCAL_STATE_PATH_UNSAFE"); goto failed;
changed:
  errno = ESTALE; local_fail(out, "LOCAL_STATE_PATH_CHANGED");
failed:
  if (ignore >= 0) close(ignore);
  if (directory >= 0) close(directory);
  // Return ownership evidence even on failure. Cleanup is an explicit operation,
  // not a racy check-then-unlink hidden in a failed preparation call.
  if (root_fd >= 0) close(root_fd);
  return -1;
}

int corptie_local_state_rollback(const char *root, CorptieLocalStateResult *receipt) {
  if (!receipt->created_directory && !receipt->created_ignore) return 0;
  CorptieLocalStateResult current = {0};
  if (corptie_local_state(root, 0, receipt->root_device, receipt->root_inode,
      receipt->directory_device, receipt->directory_inode, &current)) return local_fail(receipt, current.error_code);
  if (!current.exists || current.directory_device != receipt->directory_device || current.directory_inode != receipt->directory_inode) {
    errno = ESTALE; return local_fail(receipt, "LOCAL_STATE_PATH_CHANGED");
  }
  int parent = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int dir = parent < 0 ? -1 : openat(parent, ".corptie", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat actual, base;
  if (dir < 0 || fstat(parent, &base) || fstat(dir, &actual)
      || (uint64_t)base.st_dev != receipt->root_device || base.st_ino != receipt->root_inode
      || (uint64_t)actual.st_dev != receipt->directory_device || actual.st_ino != receipt->directory_inode) {
    if (dir >= 0) close(dir); if (parent >= 0) close(parent);
    errno = ESTALE; return local_fail(receipt, "LOCAL_STATE_PATH_CHANGED");
  }
  // Other content means another operation adopted the base. Keep its ignore rule.
  if (local_empty_except_ignore(dir) != 1) { receipt->retained = 1; close(dir); close(parent); return 0; }
  if (receipt->created_ignore) {
    char bytes[3] = {0};
    char quarantine[96];
    snprintf(quarantine, sizeof(quarantine), ".corptie-rollback-%ld-%08x", (long)getpid(), arc4random());
    if (renameatx_np(dir, ".gitignore", dir, quarantine, RENAME_EXCL)) {
      close(dir); close(parent); return local_fail(receipt, "LOCAL_STATE_CLEANUP_FAILED");
    }
    int fd = openat(dir, quarantine, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &actual) || (uint64_t)actual.st_dev != receipt->ignore_device || actual.st_ino != receipt->ignore_inode
        || actual.st_size != 2 || pread(fd, bytes, 3, 0) != 2 || memcmp(bytes, "*\n", 2)) {
      if (fd >= 0) close(fd);
      if (renameatx_np(dir, quarantine, dir, ".gitignore", RENAME_EXCL)) receipt->retained = 1;
      close(dir); close(parent);
      errno = ESTALE; return local_fail(receipt, "LOCAL_STATE_PATH_CHANGED");
    }
    close(fd);
    if (unlinkat(dir, quarantine, 0)) { close(dir); close(parent); return local_fail(receipt, "LOCAL_STATE_CLEANUP_FAILED"); }
  }
  close(dir);
  // Never unlink a replacement directory; rmdir refuses concurrent content.
  if (receipt->created_directory) {
    char quarantine[96];
    snprintf(quarantine, sizeof(quarantine), ".corptie-rollback-dir-%ld-%08x", (long)getpid(), arc4random());
    if (renameatx_np(parent, ".corptie", parent, quarantine, RENAME_EXCL)) {
      close(parent); return local_fail(receipt, "LOCAL_STATE_CLEANUP_FAILED");
    }
    if (fstatat(parent, quarantine, &actual, AT_SYMLINK_NOFOLLOW) || (uint64_t)actual.st_dev != receipt->directory_device
        || actual.st_ino != receipt->directory_inode || !S_ISDIR(actual.st_mode)
        || unlinkat(parent, quarantine, AT_REMOVEDIR)) {
      receipt->retained = 1;
      renameatx_np(parent, quarantine, parent, ".corptie", RENAME_EXCL);
      close(parent); return local_fail(receipt, "LOCAL_STATE_CLEANUP_FAILED");
    }
  }
  close(parent); return 0;
}

// Atomically publish a new file relative to a trusted project directory.
// Every descendant is descriptor-relative and symlinks are never followed.
static int write_relative_at(int trusted_root, const char *relative,
                          const unsigned char *bytes, size_t length,
                          CorptieSafeTreeResult *out) {
  if (!relative || !relative[0] || relative[0] == '/' || strchr(relative, '\\'))
    return fail(out, "ARTIFACT_PATH_INVALID", "Expected a safe relative path.");
  char *copy = strdup(relative);
  if (!copy) return fail_errno(out, "ARTIFACT_WRITE_FAILED", "copy path");
  // Validate the complete path before creating any directories.
  char *cursor = copy, *part;
  while ((part = strsep(&cursor, "/")) != NULL) {
    if (!safe_component(part)) { free(copy); return fail(out, "ARTIFACT_PATH_INVALID", "Unsafe path component."); }
  }
  strcpy(copy, relative);
  int parent = openat(trusted_root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent < 0) { free(copy); return fail_errno(out, "ARTIFACT_PATH_UNSAFE", "open project root"); }
  cursor = copy;
  while ((part = strsep(&cursor, "/")) != NULL && cursor != NULL) {
    if (mkdirat(parent, part, 0700) != 0 && errno != EEXIST) {
      fail_errno(out, "ARTIFACT_WRITE_FAILED", "mkdirat"); goto failed_write;
    }
    int next = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) { fail_errno(out, "ARTIFACT_PATH_UNSAFE", "openat parent"); goto failed_write; }
    close(parent); parent = next;
  }
  int published = publish_at(parent, part, bytes, length, out);
  close(parent); free(copy); return published;
failed_write:
  close(parent); free(copy); return -1;
}

int corptie_write_new_file(const char *root, const char *relative,
                         const unsigned char *bytes, size_t length, CorptieSafeTreeResult *out) {
  int fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return fail_errno(out, "ARTIFACT_PATH_UNSAFE", "open project root");
  int status = write_relative_at(fd, relative, bytes, length, out);
  close(fd); return status;
}

int corptie_write_local_file(const char *root, const char *relative, const unsigned char *bytes, size_t length,
                            CorptieLocalStateResult *receipt, CorptieSafeTreeResult *out) {
  int parent = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int dir = parent < 0 ? -1 : openat(parent, ".corptie", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat base, local, ignore_stat;
  int ignore = dir < 0 ? -1 : openat(dir, ".gitignore", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  char rules[65537] = {0};
  if (parent < 0 || dir < 0 || ignore < 0 || fstat(parent, &base) || fstat(dir, &local) || fstat(ignore, &ignore_stat)
      || (uint64_t)base.st_dev != receipt->root_device || base.st_ino != receipt->root_inode
      || (uint64_t)local.st_dev != receipt->directory_device || local.st_ino != receipt->directory_inode
      || !S_ISREG(ignore_stat.st_mode) || (uint64_t)ignore_stat.st_dev != receipt->ignore_device || ignore_stat.st_ino != receipt->ignore_inode
      || ignore_stat.st_size <= 0 || ignore_stat.st_size > 65536
      || pread(ignore, rules, ignore_stat.st_size, 0) != ignore_stat.st_size || strcmp(rules, receipt->ignore_text)) {
    if (ignore >= 0) close(ignore); if (dir >= 0) close(dir); if (parent >= 0) close(parent);
    return fail(out, "ARTIFACT_PATH_UNSAFE", "Bound local state directory or ignore rules changed.");
  }
  int status = write_relative_at(dir, relative, bytes, length, out);
  close(ignore); close(dir); close(parent); return status;
}

static int duplicate_dir(int fd, CorptieSafeTreeResult *out) {
  int result = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (result < 0) fail_errno(out, "RUN_OPENAT_FAILED", "openat directory descriptor");
  return result;
}

static int open_relative_dir(int root_fd, const char *relative, CorptieSafeTreeResult *out) {
  if (!relative || !relative[0] || relative[0] == '/' || relative[strlen(relative) - 1] == '/') {
    fail(out, "RUN_PATH_INVALID", "Relative path is empty, absolute, or has an empty component.");
    return -1;
  }
  char *copy = strdup(relative);
  if (!copy) { fail_errno(out, "RUN_MEMORY_FAILED", "copy relative path"); return -1; }
  int current = duplicate_dir(root_fd, out);
  char *cursor = copy;
  char *component;
  while (current >= 0 && (component = strsep(&cursor, "/")) != NULL) {
    if (!safe_component(component)) {
      close(current); current = -1;
      fail(out, "RUN_PATH_INVALID", "Relative path contains an unsafe component.");
      break;
    }
    int next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) {
      close(current); current = -1;
      fail_errno(out, "RUN_OPENAT_FAILED", "openat relative directory");
      break;
    }
    close(current); current = next;
  }
  free(copy);
  return current;
}

static int open_parent(int root_fd, const char *relative, char **leaf, CorptieSafeTreeResult *out) {
  if (!relative || !relative[0] || relative[0] == '/' || relative[strlen(relative) - 1] == '/') {
    fail(out, "RUN_PATH_INVALID", "Relative path is empty, absolute, or has an empty component.");
    return -1;
  }
  char *copy = strdup(relative);
  if (!copy) { fail_errno(out, "RUN_MEMORY_FAILED", "copy parent path"); return -1; }
  char *slash = strrchr(copy, '/');
  int parent;
  if (slash) {
    *slash = '\0';
    *leaf = strdup(slash + 1);
    parent = open_relative_dir(root_fd, copy, out);
  } else {
    *leaf = strdup(copy);
    parent = duplicate_dir(root_fd, out);
  }
  free(copy);
  if (!*leaf || !safe_component(*leaf)) {
    if (parent >= 0) close(parent);
    free(*leaf); *leaf = NULL;
    fail(out, "RUN_PATH_INVALID", "Relative path has an unsafe leaf.");
    return -1;
  }
  return parent;
}

// Return an owned descriptor, not bytes read through a check-then-open path.
// Node closes it after a bounded read (and optional permission tightening).
int corptie_open_local_file(const char *root, const char *relative, CorptieLocalStateResult *receipt,
                           CorptieSafeTreeResult *out) {
  CorptieLocalStateResult current = {0};
  if (corptie_local_state(root, 0, receipt->root_device, receipt->root_inode,
      receipt->directory_device, receipt->directory_inode, &current)
      || current.ignore_inode != receipt->ignore_inode || current.ignore_device != receipt->ignore_device
      || strcmp(current.ignore_text, receipt->ignore_text)) {
    fail(out, "LOCAL_STATE_PATH_CHANGED", "Bound directory changed."); return -1;
  }
  int parent = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int dir = parent < 0 ? -1 : openat(parent, ".corptie", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat base, local, info;
  if (dir < 0 || fstat(parent, &base) || fstat(dir, &local)
      || (uint64_t)base.st_dev != receipt->root_device || base.st_ino != receipt->root_inode
      || (uint64_t)local.st_dev != receipt->directory_device || local.st_ino != receipt->directory_inode) {
    if (dir >= 0) close(dir); if (parent >= 0) close(parent);
    fail(out, "LOCAL_STATE_PATH_CHANGED", "Bound directory changed."); return -1;
  }
  char *leaf = NULL;
  int location = open_parent(dir, relative, &leaf, out);
  int file = location < 0 ? -1 : openat(location, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (location >= 0) close(location);
  free(leaf); close(dir); close(parent);
  if (file < 0 || fstat(file, &info) || !S_ISREG(info.st_mode) || info.st_nlink != 1) {
    if (file >= 0) close(file);
    fail(out, "LOCAL_STATE_FILE_UNSAFE", "Expected a private regular file without links."); return -1;
  }
  return file;
}

static int list_and_inspect(int fd, dev_t root_device, CorptieSafeTreeResult *out) {
  struct stat root;
  if (fstat(fd, &root) != 0) return fail_errno(out, "RUN_FSTAT_FAILED", "fstat directory");
  out->files += 1;
  if (root.st_size > 0) out->bytes += (uint64_t)root.st_size;
  int scan_fd = duplicate_dir(fd, out);
  if (scan_fd < 0) return -1;
  DIR *directory = fdopendir(scan_fd);
  if (!directory) { close(scan_fd); return fail_errno(out, "RUN_READDIR_FAILED", "fdopendir"); }
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    const char *name = entry->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
    struct stat info;
    if (fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) != 0) {
      closedir(directory); return fail_errno(out, "RUN_FSTATAT_FAILED", "fstatat descendant");
    }
    if (info.st_dev != root_device) { closedir(directory); return fail(out, "RUN_MOUNT_CROSSING", "A descendant crosses a filesystem boundary."); }
    if (S_ISLNK(info.st_mode)) { closedir(directory); return fail(out, "RUN_SYMLINK_FORBIDDEN", "A symlink exists below the Run root."); }
    if (S_ISDIR(info.st_mode)) {
      int child = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) { closedir(directory); return fail_errno(out, "RUN_OPENAT_FAILED", "openat child directory"); }
      int status = list_and_inspect(child, root_device, out);
      close(child);
      if (status != 0) { closedir(directory); return status; }
    } else {
      if (info.st_nlink > 1) { closedir(directory); return fail(out, "RUN_HARDLINK_FORBIDDEN", "A multiply-linked file exists below the Run root."); }
      out->files += 1;
      if (info.st_size > 0) out->bytes += (uint64_t)info.st_size;
    }
    errno = 0;
  }
  int saved = errno;
  closedir(directory);
  if (saved != 0) { errno = saved; return fail_errno(out, "RUN_READDIR_FAILED", "readdir"); }
  return 0;
}

static int remove_contents(int fd, dev_t root_device, CorptieSafeTreeResult *out) {
  int scan_fd = duplicate_dir(fd, out);
  if (scan_fd < 0) return -1;
  DIR *directory = fdopendir(scan_fd);
  if (!directory) { close(scan_fd); return fail_errno(out, "RUN_READDIR_FAILED", "fdopendir delete"); }
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    const char *name = entry->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
    struct stat info;
    if (fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) != 0) { closedir(directory); return fail_errno(out, "RUN_FSTATAT_FAILED", "fstatat during deletion"); }
    if (info.st_dev != root_device) { closedir(directory); return fail(out, "RUN_MOUNT_CROSSING", "A descendant crossed a filesystem boundary during deletion."); }
    if (S_ISLNK(info.st_mode)) { closedir(directory); return fail(out, "RUN_SYMLINK_FORBIDDEN", "A symlink appeared during deletion."); }
    if (S_ISDIR(info.st_mode)) {
      int child = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) { closedir(directory); return fail_errno(out, "RUN_OPENAT_FAILED", "openat during deletion"); }
      int status = remove_contents(child, root_device, out);
      close(child);
      if (status != 0) { closedir(directory); return status; }
      if (unlinkat(fd, name, AT_REMOVEDIR) != 0) { closedir(directory); return fail_errno(out, "RUN_UNLINKAT_FAILED", "unlinkat directory"); }
    } else {
      if (info.st_nlink > 1) { closedir(directory); return fail(out, "RUN_HARDLINK_FORBIDDEN", "A multiply-linked file appeared during deletion."); }
      if (unlinkat(fd, name, 0) != 0) { closedir(directory); return fail_errno(out, "RUN_UNLINKAT_FAILED", "unlinkat file"); }
    }
    errno = 0;
  }
  int saved = errno;
  closedir(directory);
  if (saved != 0) { errno = saved; return fail_errno(out, "RUN_READDIR_FAILED", "readdir during deletion"); }
  return 0;
}

int corptie_inspect_tree(const char *root_path, const char *relative, CorptieSafeTreeResult *out) {
  memset(out, 0, sizeof(*out));
  int root_fd = open(root_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) return fail_errno(out, "RUN_OPENAT_FAILED", "open canonical DataRoot");
  struct stat root, target;
  if (fstat(root_fd, &root) != 0) { close(root_fd); return fail_errno(out, "RUN_FSTAT_FAILED", "fstat DataRoot"); }
  int target_fd = open_relative_dir(root_fd, relative, out);
  if (target_fd < 0) { close(root_fd); return -1; }
  if (fstat(target_fd, &target) != 0) { close(target_fd); close(root_fd); return fail_errno(out, "RUN_FSTAT_FAILED", "fstat Run root"); }
  out->root_device = (uint64_t)root.st_dev; out->root_inode = (uint64_t)root.st_ino;
  out->target_device = (uint64_t)target.st_dev; out->target_inode = (uint64_t)target.st_ino;
  int status = target.st_dev == root.st_dev ? list_and_inspect(target_fd, root.st_dev, out) : fail(out, "RUN_MOUNT_CROSSING", "Run root crosses the DataRoot filesystem boundary.");
  close(target_fd); close(root_fd); return status;
}

int corptie_remove_tree(const char *root_path, const char *source_relative, const char *trash_relative,
    uint64_t expected_root_device, uint64_t expected_root_inode, uint64_t expected_target_device,
    uint64_t expected_target_inode, CorptieSafeTreeResult *out) {
  memset(out, 0, sizeof(*out));
  int root_fd = open(root_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) return fail_errno(out, "RUN_OPENAT_FAILED", "open canonical DataRoot");
  struct stat root;
  if (fstat(root_fd, &root) != 0) { close(root_fd); return fail_errno(out, "RUN_FSTAT_FAILED", "fstat DataRoot"); }
  if ((uint64_t)root.st_dev != expected_root_device || (uint64_t)root.st_ino != expected_root_inode) { close(root_fd); return fail(out, "RUN_IDENTITY_CHANGED", "DataRoot identity changed."); }
  char *source_name = NULL, *trash_name = NULL;
  int source_parent = open_parent(root_fd, source_relative, &source_name, out);
  if (source_parent < 0) { close(root_fd); return -1; }
  int trash_parent = open_parent(root_fd, trash_relative, &trash_name, out);
  if (trash_parent < 0) { free(source_name); close(source_parent); close(root_fd); return -1; }
  struct stat source;
  if (fstatat(source_parent, source_name, &source, AT_SYMLINK_NOFOLLOW) != 0) { fail_errno(out, "RUN_FSTATAT_FAILED", "fstatat Run root"); goto failed; }
  if (!S_ISDIR(source.st_mode) || (uint64_t)source.st_dev != expected_target_device || (uint64_t)source.st_ino != expected_target_inode) { fail(out, "RUN_IDENTITY_CHANGED", "Run root identity changed."); goto failed; }
  if (source.st_dev != root.st_dev) { fail(out, "RUN_MOUNT_CROSSING", "Run root crosses the DataRoot filesystem boundary."); goto failed; }
  if (renameatx_np(source_parent, source_name, trash_parent, trash_name, RENAME_EXCL) != 0) { fail_errno(out, "RUN_RENAMEAT_FAILED", "renameatx_np quarantine"); goto failed; }
  int target_fd = openat(trash_parent, trash_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (target_fd < 0) { fail_errno(out, "RUN_OPENAT_FAILED", "open quarantined Run root"); goto failed; }
  struct stat target;
  if (fstat(target_fd, &target) != 0 || (uint64_t)target.st_dev != expected_target_device || (uint64_t)target.st_ino != expected_target_inode) {
    fail(out, "RUN_IDENTITY_CHANGED", "Quarantined Run root identity changed."); close(target_fd); goto failed;
  }
  out->root_device = (uint64_t)root.st_dev; out->root_inode = (uint64_t)root.st_ino;
  out->target_device = (uint64_t)target.st_dev; out->target_inode = (uint64_t)target.st_ino;
  if (list_and_inspect(target_fd, root.st_dev, out) != 0 || remove_contents(target_fd, root.st_dev, out) != 0) { close(target_fd); goto failed; }
  close(target_fd);
  if (unlinkat(trash_parent, trash_name, AT_REMOVEDIR) != 0) { fail_errno(out, "RUN_UNLINKAT_FAILED", "unlinkat quarantined Run root"); goto failed; }
  free(source_name); free(trash_name); close(source_parent); close(trash_parent); close(root_fd); return 0;
failed:
  free(source_name); free(trash_name); close(source_parent); close(trash_parent); close(root_fd); return -1;
}

int corptie_delete_tree(const char *root_path, const char *relative, uint64_t expected_root_device,
    uint64_t expected_root_inode, uint64_t expected_target_device, uint64_t expected_target_inode,
    CorptieSafeTreeResult *out) {
  memset(out, 0, sizeof(*out));
  int root_fd = open(root_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) return fail_errno(out, "RUN_OPENAT_FAILED", "open canonical DataRoot");
  struct stat root;
  if (fstat(root_fd, &root) != 0) { close(root_fd); return fail_errno(out, "RUN_FSTAT_FAILED", "fstat DataRoot"); }
  if ((uint64_t)root.st_dev != expected_root_device || (uint64_t)root.st_ino != expected_root_inode) { close(root_fd); return fail(out, "RUN_IDENTITY_CHANGED", "DataRoot identity changed."); }
  char *name = NULL;
  int parent = open_parent(root_fd, relative, &name, out);
  if (parent < 0) { close(root_fd); return -1; }
  int target_fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (target_fd < 0) { fail_errno(out, "RUN_OPENAT_FAILED", "open quarantined Run root"); goto failed_delete; }
  struct stat target;
  if (fstat(target_fd, &target) != 0 || (uint64_t)target.st_dev != expected_target_device || (uint64_t)target.st_ino != expected_target_inode) {
    fail(out, "RUN_IDENTITY_CHANGED", "Quarantined Run root identity changed."); close(target_fd); goto failed_delete;
  }
  if (target.st_dev != root.st_dev) { fail(out, "RUN_MOUNT_CROSSING", "Quarantined Run root crosses the DataRoot filesystem boundary."); close(target_fd); goto failed_delete; }
  out->root_device = (uint64_t)root.st_dev; out->root_inode = (uint64_t)root.st_ino;
  out->target_device = (uint64_t)target.st_dev; out->target_inode = (uint64_t)target.st_ino;
  if (list_and_inspect(target_fd, root.st_dev, out) != 0 || remove_contents(target_fd, root.st_dev, out) != 0) { close(target_fd); goto failed_delete; }
  close(target_fd);
  if (unlinkat(parent, name, AT_REMOVEDIR) != 0) { fail_errno(out, "RUN_UNLINKAT_FAILED", "unlinkat quarantined Run root"); goto failed_delete; }
  free(name); close(parent); close(root_fd); return 0;
failed_delete:
  free(name); close(parent); close(root_fd); return -1;
}
