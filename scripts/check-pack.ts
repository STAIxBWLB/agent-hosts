import { execFileSync } from "node:child_process";
import manifest from "../package.json";

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
  const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
  if (!pack) throw new Error("npm pack did not report a tarball");

  const rootFiles = new Set(["package.json", "README.md", "LICENSE"]);
  for (const { path } of pack.files) {
    if (!rootFiles.has(path) && !path.startsWith("src/") && !path.startsWith("fixtures/")) {
      throw new Error(`unexpected package file: ${path}`);
    }
  }
}

checkPack();
