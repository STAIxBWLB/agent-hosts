import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let processes: typeof import("node:child_process") | undefined;
// Path/policy-only hook parents never need a process module. Node-safe synchronous users load it on demand.
const childProcess = () => processes ??= require("node:child_process") as typeof import("node:child_process");

/**
 * Resolve existing paths physically. Bun folds `..` after symlinks lexically (#403), so parent segments use the
 * system realpath. Bun versions that reject literal backslashes also use that fallback (#26, #121). It returns
 * names as stored on disk for guardPath's name checks and refuses missing paths and dangling symlinks.
 */
export function realPath(path: string): string {
  const hasParent = path.split(sep).includes("..");
  let error: unknown;
  if (!hasParent) {
    try {
      return realpathSync(path);
    } catch (caught) {
      if (!resolve(path).includes("\\")) throw caught; // a relative path can sit under a backslash directory too
      error = caught;
    }
  }
  // Keep the original spelling: resolve() would fold a `..` after a symlink by text. GNU realpath accepts a
  // dangling last component unless told -e; the BSD one on macOS refuses it by default.
  const argv = process.platform === "darwin" ? ["/bin/realpath", "--", path] : ["realpath", "-e", "--", path];
  const r = childProcess().spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.endsWith("\n")) throw error ?? new Error(`Cannot resolve existing path: ${path}`);
  return r.stdout.slice(0, -1);
}
