import path from "node:path";

const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR"]);
const SYMLINK_OPEN_CODES = new Set(["ELOOP", "EINVAL", "ENOTSUP"]);

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return Boolean(
    value && typeof value === "object" && "code" in (value as Record<string, unknown>),
  );
}

export function hasNodeErrorCode(value: unknown, code: string): boolean {
  return isNodeError(value) && value.code === code;
}

export function isNotFoundPathError(value: unknown): boolean {
  return isNodeError(value) && typeof value.code === "string" && NOT_FOUND_CODES.has(value.code);
}

export function isSymlinkOpenError(value: unknown): boolean {
  return isNodeError(value) && typeof value.code === "string" && SYMLINK_OPEN_CODES.has(value.code);
}

export function isPathInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);

  if (process.platform === "win32") {
    const relative = path.win32.relative(resolvedRoot.toLowerCase(), resolvedTarget.toLowerCase());
    return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
  }

  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Normalize a Windows path for boundary math whose result is handed back to callers.
 *
 * This preserves case because `path.win32.relative` already matches roots
 * case-insensitively while Windows filesystems preserve the supplied case.
 */
export function normalizeWindowsPathPreservingCase(input: string): string {
  const normalized = path.win32.normalize(input).trim();
  if (!normalized.startsWith("\\\\?\\")) {
    return normalized;
  }
  const withoutPrefix = normalized.slice(4);
  return withoutPrefix.toUpperCase().startsWith("UNC\\")
    ? `\\\\${withoutPrefix.slice(4)}`
    : withoutPrefix;
}
