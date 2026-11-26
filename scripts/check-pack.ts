import { execFileSync } from "node:child_process";
import manifest from "../package.json";

type PackReport = { files: Array<{ path: string }> };

function checkPack(): void {
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    if (Object.hasOwn(manifest, section)) {
      throw new Error(`remove ${section} from package.json`);
    }
  }

  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { encoding: "utf8" },
  );
  const reports = JSON.parse(output) as PackReport[] | Record<string, PackReport> | null;
  const pack = Object.values(reports ?? {})[0];
  if (!Array.isArray(pack?.files)) {
    throw new Error(
      "npm pack did not report a tarball with a file list; inspect npm pack --dry-run --json --ignore-scripts output",
    );
  }

  const rootFiles = new Set(["package.json", "README.md", "LICENSE"]);
  for (const { path } of pack.files) {
    if (!rootFiles.has(path) && !path.startsWith("src/") && !path.startsWith("fixtures/")) {
      throw new Error(`unexpected package file: ${path}; adjust package.json files or the tarball allowlist`);
    }
  }
}

checkPack();
