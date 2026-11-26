import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyEntry, planEntry, realPath, resolveHostPaths, undoEntry, type HostId } from "@staix/agent-hosts";

interface FileImage { text: string; mode: number }
type Snapshot = Record<string, FileImage | null>;
interface Case {
  id: string;
  host: HostId;
  name: string;
  key: string;
  env: Record<string, string>;
  file: string;
  entry: Record<string, unknown>;
  plan: { change: "add" | "replace" | "refused"; files?: string[]; reason?: string };
  before: Snapshot;
  afterApply: Snapshot;
  afterUndo: Snapshot;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const directory = join(import.meta.dir, "../fixtures/copies");
const consumers = ["vault-mem", "agent-research", "agent-mem"] as const;
const common = ["claude", "codex", "kimi", "pi", "qwen", "jcode"];
const memoryFormatting = new Set(["claude", "kimi", "pi", "qwen", "gemini"]);
const memoryHookFiles = new Set(["claude", "codex", "kimi", "pi", "jcode"]);

function snapshot(files: readonly string[]): Snapshot {
  return Object.fromEntries(files.map((file) => [
    file,
    existsSync(file) ? { text: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777 } : null,
  ]));
}

function document(host: HostId, text: string): Record<string, unknown> {
  return (host === "codex" ? Bun.TOML.parse(text) : JSON.parse(text)) as Record<string, unknown>;
}

/** Expected byte patch for the fixed seed layout written by the recorder. */
function expectJsonPatch(item: Case, file: string, change: "add" | "replace", actual: string): void {
  const source = item.before[file]?.text;
  const field = JSON.stringify(item.name) + ":";
  const value = JSON.stringify(item.entry);
  if (!source) {
    expect(actual).toBe(`{${JSON.stringify(item.key)}:{${field}${value}}}`);
    return;
  }
  if (change === "add") {
    const sibling = '{\n      "command": "/fixture/keep"\n    }';
    expect(source).toContain(sibling);
    expect(actual).toBe(source.replace(sibling, `${sibling},${field}${value}`));
    return;
  }
  const prior = '{\n      "command": "/fixture/previous",\n      "args": [\n        "old"\n      ]\n    }';
  expect(source).toContain(`${field} ${prior}`);
  expect(actual).toBe(source.replace(`${field} ${prior}`, `${field} ${value}`));
}

for (const consumer of consumers) {
  const suite = JSON.parse(readFileSync(join(directory, `${consumer}.json`), "utf8")) as {
    copy: string; commit: string; cases: Case[];
  };
  const memory = consumer === "agent-mem";
  test(`${consumer} fixture covers every in-scope host and override case`, () => {
    const expected = common.map((host) => host + "-standard");
    expected.push(...(memory ? ["opencode-standard", "gemini-standard"] : ["qwen-tilde-home", "jcode-empty-home"]));
    expect(suite.copy).toBe(consumer);
    expect(suite.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(suite.cases.map((item) => item.id)).toEqual(expected);
  });

  for (const recorded of suite.cases) {
    test(`${consumer}: ${recorded.id} replays the plan, apply and undo`, () => {
      const home = realPath(mkdtempSync(join(tmpdir(), "agent-hosts-copy-")));
      roots.push(home);
      const item = JSON.parse(JSON.stringify(recorded).replaceAll("$FIXTURE", home)) as Case;
      const { host, name, entry } = item;
      const files = Object.keys(item.before);
      for (const [file, image] of Object.entries(item.before)) {
        if (!image) continue;
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, image.text, { mode: image.mode });
      }
      const cwd = process.cwd();
      let paths: ReturnType<typeof resolveHostPaths>;
      try {
        process.chdir(home);
        paths = resolveHostPaths({ env: item.env, home, hosts: [host], redirectManagedProfiles: memory });
      } finally {
        process.chdir(cwd);
      }
      const file = paths.paths[host]![0]!;
      const target = { host, paths, name, receiptDir: join(home, "package-receipts") };
      const preview = planEntry({ ...target, entry });
      const emptyHome = item.id === "jcode-empty-home";
      const tildeHome = item.id === "qwen-tilde-home";

      expect(snapshot(files)).toEqual(item.before);
      if (emptyHome) {
        expect(item.plan.files).toEqual([join(home, ".jcode/mcp.json")]);
        expect(item.afterApply[file]).toBeNull();
        expect(file).toBe(join(home, "mcp.json"));
      } else {
        expect(file).toBe(item.file);
      }
      if (tildeHome) {
        expect(item.plan).toMatchObject({ change: "refused" });
        expect(item.plan.reason).toContain("QWEN_HOME");
        expect(item.afterApply).toEqual(item.before);
        expect(item.afterUndo).toEqual(item.before);
        expect(file).toBe(join(home, "custom-qwen/settings.json"));
        expect(preview.change).toBe("add");
      } else {
        expect(item.plan.files?.[0]).toBe(item.file);
        expect(preview.change).toBe(item.plan.change);
      }
      if (preview.change !== "add" && preview.change !== "replace") throw new Error("expected a writable fixture");
      expect(applyEntry(preview, target).change).toBe(preview.change);

      const applied = snapshot(files);
      const installed = applied[file];
      if (!installed) throw new Error("missing package after-image");
      const parsed = document(host, installed.text);
      expect(parsed[item.key]).toMatchObject({ [name]: entry });
      expect(installed.mode).toBe(item.before[file]?.mode ?? 0o600);
      if (host === "codex") {
        const source = item.before[file]!.text;
        const prefix = "fixture = true\n\n";
        const priorHeader = `[mcp_servers.${name}]`;
        const tail = source.indexOf(priorHeader);
        expect(source.startsWith(prefix)).toBe(true);
        expect(tail).toBeGreaterThan(prefix.length);
        const unrelated = source.slice(prefix.length, tail);
        const owned = `"mcp_servers".${JSON.stringify(name)} = { "command" = ${JSON.stringify(entry.command)}, "args" = ${JSON.stringify(entry.args).replaceAll(",", ", ")} }\n`;
        expect(installed.text).toBe(prefix + owned + unrelated);
      } else {
        expectJsonPatch(item, file, preview.change, installed.text);
      }

      if (!tildeHome) {
        const legacy = item.afterApply[item.file]!;
        const sourceDoc = document(host, legacy.text);
        if (memory && host === "qwen") {
          expect(sourceDoc.hooks).toBeDefined();
          expect(parsed.hooks).toBeUndefined();
          delete sourceDoc.hooks;
        }
        expect(parsed).toEqual(sourceDoc);
        if (!memory || memoryFormatting.has(host)) expect(installed.text).not.toBe(legacy.text);
        else expect(installed).toEqual(legacy);
      }
      if (emptyHome) expect(applied[item.file]).toBeNull();
      for (const other of files.filter((path) => path !== file)) {
        expect(applied[other]).toEqual(item.before[other]);
        if (other !== item.file && memory && memoryHookFiles.has(host)) expect(item.afterApply[other]).not.toBeNull();
        expect(item.afterUndo[other]).toEqual(item.before[other]);
      }

      expect(undoEntry(target).change).toBe(preview.change === "replace" ? "restored" : "removed");
      expect(snapshot(files)).toEqual(item.before);
      expect(item.afterUndo).toEqual(item.before);
    });
  }
}
