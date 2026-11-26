import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const revisions = { "vault-mem": "9b9a4a5", "agent-research": "05699c2", "agent-mem": "e37eb63" } as const;
export type ConsumerCopy = keyof typeof revisions;
type RunCapture = (script: string, label: string, args: readonly string[]) => string;

export function captureConsumerCopies(
  checkouts: string | undefined,
  capture: (consumer: ConsumerCopy, commit: string, run: RunCapture) => void,
): void {
  if (process.platform !== "darwin" || !checkouts) {
    throw new Error("Run the recorder on macOS with the directory containing the three consumer checkouts.");
  }
  const temp = mkdtempSync(join(realpathSync(tmpdir()), "agent-hosts-record-"));
  const sandbox = `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(temp)}))`;
  try {
    // Seatbelt blocks macOS's setuid ps. This fixture identity is used only by
    // agent-mem's transient setup lock inside the isolated single-writer run.
    const system = join(temp, "system");
    mkdirSync(system);
    writeFileSync(join(system, "ps"), '#!/bin/sh\n[ "$1" = -p ] || exit 1\nprintf "fixture setup writer %s\\n" "$2"\n', { mode: 0o700 });
    for (const consumer of Object.keys(revisions) as ConsumerCopy[]) {
      const checkout = resolve(checkouts, consumer);
      const source = join(temp, consumer);
      mkdirSync(source);
      const git = (args: string[]) => execFileSync("git", ["-C", checkout, ...args], { maxBuffer: 32 * 1024 * 1024 });
      const commit = git(["rev-parse", revisions[consumer]]).toString().trim();
      const directories = git(["ls-tree", "--name-only", commit]).toString().trim().split("\n");
      const archived = ["src", "package.json", "bin", "skills"].filter((name) => directories.includes(name));
      execFileSync("tar", ["-xf", "-", "-C", source], { input: git(["archive", commit, ...archived]) });
      const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
      for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
        const installed = Object.keys(revisions).map((repo) => resolve(checkouts, repo, "node_modules", name))
          .find((candidate) => {
            const pkg = join(candidate, "package.json");
            return existsSync(pkg) && Bun.semver.satisfies(JSON.parse(readFileSync(pkg, "utf8")).version, version);
          });
        if (!installed) throw new Error(`${consumer}: no local dependency ${name}@${version}; provide it in a consumer checkout`);
        mkdirSync(join(source, "node_modules", name, ".."), { recursive: true });
        symlinkSync(installed, join(source, "node_modules", name), "dir");
      }
      capture(consumer, commit, (code, label, args) => {
        const script = join(source, "record.ts"), home = join(temp, `${consumer}-${label}`);
        writeFileSync(script, code);
        mkdirSync(home, { mode: 0o700 });
        return execFileSync("/usr/bin/sandbox-exec", ["-p", sandbox, process.execPath, script, home, ...args], {
          cwd: home, env: { HOME: home, PATH: `${system}:/usr/bin:/bin`, TMPDIR: home }, encoding: "utf8", timeout: 30_000,
        });
      });
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
