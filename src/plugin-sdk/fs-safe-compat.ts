import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError, root } from "../infra/fs-safe.js";

export type SafeOpenErrorCode =
  | "invalid-path"
  | "not-found"
  | "symlink"
  | "not-file"
  | "path-mismatch"
  | "too-large";

/**
 * @deprecated Use FsSafeError from openclaw/plugin-sdk.
 */
export class SafeOpenError extends Error {
  code: SafeOpenErrorCode;

  constructor(code: SafeOpenErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "SafeOpenError";
  }
}

/**
 * @deprecated Use OpenResult from openclaw/plugin-sdk.
 */
export type SafeOpenResult = {
  handle: FileHandle;
  realPath: string;
  stat: Stats;
};

/**
 * @deprecated Use root(rootDir).open(relativePath, options).
 */
export async function openFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
}): Promise<SafeOpenResult> {
  try {
    const scopedRoot = await root(params.rootDir);
    return await scopedRoot.open(params.relativePath, {
      hardlinks: "allow",
      nonBlockingRead: true,
      symlinks: "reject",
    });
  } catch (error) {
    if (error instanceof FsSafeError) {
      const code = error.code === "not-found" ? "not-found" : "invalid-path";
      throw new SafeOpenError(code, error.message, { cause: error });
    }
    throw error;
  }
}
