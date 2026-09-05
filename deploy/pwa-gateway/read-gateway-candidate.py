#!/usr/bin/python3

import hashlib
import os
import stat
import sys


MAX_CANDIDATE_BYTES = 1024 * 1024


def fail(message: str) -> "NoReturn":
    print(message, file=sys.stderr)
    raise SystemExit(1)


if len(sys.argv) != 3:
    fail("Usage: read-gateway-candidate.py <candidate> <sha256>")

candidate_path = sys.argv[1]
expected_sha256 = sys.argv[2]
if len(expected_sha256) != 64 or any(
    character not in "0123456789abcdef" for character in expected_sha256
):
    fail("Invalid gateway candidate checksum.")
if not hasattr(os, "O_NOFOLLOW"):
    fail("This platform cannot safely open gateway candidates.")

flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
try:
    candidate_fd = os.open(candidate_path, flags)
except OSError as error:
    fail(f"Could not safely open gateway candidate: {error}")

try:
    before = os.fstat(candidate_fd)
    if not stat.S_ISREG(before.st_mode):
        fail("Gateway candidate must be a regular file.")
    if before.st_uid != os.geteuid() or before.st_gid != os.getegid():
        fail("Gateway candidate must be owned by the deployment account.")
    if stat.S_IMODE(before.st_mode) != 0o600 or before.st_nlink != 1:
        fail("Gateway candidate has unsafe permissions or links.")
    if before.st_size <= 0 or before.st_size > MAX_CANDIDATE_BYTES:
        fail("Gateway candidate has an unsafe size.")

    candidate = bytearray()
    while len(candidate) <= MAX_CANDIDATE_BYTES:
        chunk = os.read(
            candidate_fd,
            min(65536, MAX_CANDIDATE_BYTES + 1 - len(candidate)),
        )
        if not chunk:
            break
        candidate.extend(chunk)
    if len(candidate) > MAX_CANDIDATE_BYTES:
        fail("Gateway candidate grew beyond the size limit while being read.")

    after = os.fstat(candidate_fd)
    stable_attributes = (
        "st_dev",
        "st_ino",
        "st_mode",
        "st_uid",
        "st_gid",
        "st_nlink",
        "st_size",
        "st_mtime_ns",
        "st_ctime_ns",
    )
    if any(getattr(before, name) != getattr(after, name) for name in stable_attributes):
        fail("Gateway candidate changed while being read.")
    if len(candidate) != before.st_size:
        fail("Gateway candidate size changed while being read.")
    if hashlib.sha256(candidate).hexdigest() != expected_sha256:
        fail("Gateway candidate checksum mismatch.")

    output_fd = sys.stdout.fileno()
    remaining = memoryview(candidate)
    while remaining:
        written = os.write(output_fd, remaining)
        remaining = remaining[written:]
finally:
    os.close(candidate_fd)
