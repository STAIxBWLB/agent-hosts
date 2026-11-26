import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type { ConfigImage } from "./json.ts";
import { realPath } from "./platform.ts";
import { EntryRefusal } from "./refusal.ts";

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const sameNode = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;
export const sameImage = (left: ConfigImage, right: ConfigImage): boolean =>
  left.bytes === right.bytes && left.mode === right.mode;

function checkPath(file: string, directory = false): Stats | undefined {
  if (!isAbsolute(file) || resolve(file) !== file) {
    throw new EntryRefusal("unsafe-path", `${file}: supply an absolute path without redirects or parent segments`, { file: file });
  }
  const root = parse(file).root;
  let path = root;
  const parts = file.slice(root.length).split(sep).filter(Boolean);
  let stat: Stats | undefined;
  let existing = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (missing(error)) {
        assertPhysical(file, existing);
        return undefined;
      }
      throw error;
    }
    const needsDirectory = directory || index < parts.length - 1;
    if (stat.isSymbolicLink() || (needsDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
      throw new EntryRefusal("unsafe-path", `${file}: unsafe path component ${path}; use a plain file and directories without links`, { file: file });
    }
    existing = path;
  }
  assertPhysical(file, existing);
  return stat;
}

function assertPhysical(file: string, existing: string): void {
  if (realPath(existing) !== existing) {
    throw new EntryRefusal("unsafe-path", `${file}: redirected path; use the exact physical path spelling`, { file: file });
  }
}

function ensureDirectory(directory: string): void {
  checkPath(directory, true);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkPath(directory, true);
}

export function readImage(file: string, limit: number): ConfigImage {
  const absent = { bytes: null, mode: 0o600 };
  const named = checkPath(file);
  if (!named) return absent;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !sameNode(named, stat)) {
      throw new EntryRefusal("file-changed", `${file}: path changed while opening; check the file and retry`, { file: file });
    }
    if (stat.size > limit) throw new EntryRefusal("size-limit", `${file}: exceeds ${limit} bytes; reduce the file size before retrying`, { file: file });
    // Read one extra byte to detect growth, with a fixed upper bound even for a changing file.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const end = fstatSync(fd);
    if (length !== stat.size || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || end.ctimeMs !== stat.ctimeMs) {
      throw new EntryRefusal("file-changed", `${file}: changed while reading; rerun after the writer finishes`, { file: file });
    }
    const current = checkPath(file);
    if (!current || !sameNode(current, end)) throw new EntryRefusal("file-changed", `${file}: path changed while reading; check the file and retry`, { file: file });
    return { bytes: buffer.subarray(0, length).toString("base64"), mode: stat.mode & 0o7777 };
  } finally {
    closeSync(fd);
  }
}

function verifyImage(file: string, limit: number, expected: ConfigImage): void {
  if (!sameImage(readImage(file, limit), expected)) {
    throw new EntryRefusal("file-changed", `${file}: changed before publication; rerun the operation using the current file`, { file: file });
  }
}

export function publishImage(file: string, limit: number, expected: ConfigImage, next: ConfigImage): void {
  verifyImage(file, limit, expected);
  if (sameImage(expected, next)) return;
  if (next.bytes === null) {
    unlinkSync(file);
    return;
  }
  const bytes = Buffer.from(next.bytes, "base64");
  if (bytes.length > limit) throw new EntryRefusal("size-limit", `${file}: output exceeds ${limit} bytes; reduce the entry size before retrying`, { file: file });
  const directory = dirname(file);
  ensureDirectory(directory);
  const parent = lstatSync(directory);
  const temporary = join(directory, `.agent-hosts-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, next.mode);
    fsyncSync(fd);
    verifyImage(file, limit, expected);
    const named = checkPath(temporary);
    if (!named || !sameNode(named, fstatSync(fd)) || !sameNode(parent, lstatSync(directory))) {
      throw new EntryRefusal("file-changed", `${file}: directory or temporary file changed; check the path and retry`, { file: file });
    }
    renameSync(temporary, file);
  } finally {
    try {
      const named = checkPath(temporary);
      if (named && sameNode(named, fstatSync(fd))) unlinkSync(temporary);
    } finally {
      closeSync(fd);
    }
  }
}

export function withConfigLock<T>(file: string, work: () => T): T {
  checkPath(file);
  ensureDirectory(dirname(file));
  const lock = file + ".agent-hosts.lock";
  let fd: number;
  try {
    fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    throw new EntryRefusal("lock-held", `${lock}: another apply or undo holds this lock; wait for it, or remove the lock manually after confirming the writer has stopped`, { file: lock });
  }
  try {
    return work();
  } finally {
    try {
      const named = checkPath(lock);
      if (named && sameNode(named, fstatSync(fd))) unlinkSync(lock);
    } finally {
      closeSync(fd);
    }
  }
}
