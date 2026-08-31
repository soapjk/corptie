#!/usr/bin/python3
"""Launch one Development process in a new session without supervising it."""

import os
import sys


if len(sys.argv) != 3:
    raise SystemExit("usage: launch-development-detached.py EXECUTABLE LOG_PATH")

executable, log_path = sys.argv[1:]
if not executable.startswith("/Volumes/") or not log_path.startswith("/Volumes/"):
    raise SystemExit("Development executable and log must use the external volume")

os.setsid()
log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(log_fd, sys.stdout.fileno())
os.dup2(log_fd, sys.stderr.fileno())
os.close(log_fd)
os.execve(executable, [executable], os.environ)
