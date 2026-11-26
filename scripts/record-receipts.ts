// Run manually on macOS with the three consumer checkouts and their installed dependencies.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureConsumerCopies, type ConsumerCopy } from "./fixture-capture.ts";

captureConsumerCopies(process.argv[2], (consumer, commit, run) => {
  for (const version of consumer === "agent-mem" ? [1, 2] : [1]) {
    const output = run(recorder(consumer), `v${version}`, [String(version), commit]);
    const fixtureDir = join(import.meta.dir, "../fixtures/receipts", consumer);
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, `v${version}.json`), output);
  }
});

function recorder(consumer: ConsumerCopy): string {
  return `
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ${consumer === "agent-mem" ? "planSetup, applySetup" : "runSetup"} } from "./src/setup.ts";

const [home, version, commit] = process.argv.slice(2);
const bin = join(home, "bin"), runtime = join(bin, "bun");
const env = {
  HOME: home, PATH: bin, TMPDIR: home, AMEM_HOME: join(home, "memory"), VMEM_HOME: join(home, "vault"),
  AGENTHUB_HOME: join(home, "hub"), CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
  KIMI_CODE_HOME: join(home, ".kimi-code"), PI_CODING_AGENT_DIR: join(home, ".pi/agent"), QWEN_HOME: join(home, ".qwen"),
  JCODE_HOME: join(home, ".jcode"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state"), GEMINI_CLI_HOME: home,
  ORCA_USER_DATA_PATH: join(home, "orca"),
};
const put = (path, text, mode = 0o600) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode });
};
put(runtime, "#!/bin/sh\\nexit 1\\n", 0o700);
put(join(bin, "kimi"), "#!/bin/sh\\necho 0.0.0-fixture\\n", 0o700);
const host = "kimi", name = ${JSON.stringify({ "vault-mem": "vmem", "agent-research": "ares", "agent-mem": "amem" }[consumer])};
const file = join(env.KIMI_CODE_HOME, "mcp.json");
const prior = { command: "/fixture/prior", args: ["mcp"] };
const before = '{\\n  "mcpServers": {\\n    "other": {\\n      "command": "keep"\\n    },\\n    "' + name + '": '
  + JSON.stringify(prior) + '\\n  },\\n  "fixture": true\\n}\\n';
put(file, before);
const hash = createHash("sha256").update(file).digest("hex").slice(0, 16);
let receiptPath;
${consumer === "vault-mem" ? `
const report = runSetup(host, "apply", { home: env.VMEM_HOME, env, cwd: home, entry: { command: runtime, args: ["mcp"] } });
if (report.actions[0]?.change !== "replace") throw new Error(JSON.stringify(report));
receiptPath = join(env.VMEM_HOME, "setup", host + "-" + hash + ".json");
` : consumer === "agent-research" ? `
const root = join(home, "release");
put(join(root, "package.json"), readFileSync(new URL("./package.json", import.meta.url), "utf8"));
put(join(root, "bin/ares.js"), "// runtime is never launched\\n");
const report = runSetup(host, "apply", { env, cwd: home, root });
if (report.actions[0]?.change !== "replace") throw new Error(JSON.stringify(report));
receiptPath = report.actions[0].receipt;
` : `
const root = join(home, "release/node_modules/@staix/agent-mem");
put(join(root, "package.json"), readFileSync(new URL("./package.json", import.meta.url), "utf8"));
put(join(root, "bin/amem.js"), "// runtime is never launched\\n");
if (version === "2") {
  const stale = join(home, "removed/node_modules/@staix/agent-mem/bin/amem.js");
  const command = "'" + runtime + "' --smol '" + stale + "' ingest kimi --json";
  put(join(env.KIMI_CODE_HOME, "config.toml"), '[[' + 'hooks]]\\nevent = "SessionEnd"\\ncommand = ' + JSON.stringify(command) + '\\ntimeout = 3\\n');
}
const options = { env, cwd: home, bun: runtime, root, native: () => { throw new Error("unexpected native registration"); } };
const plan = planSetup(host, "apply", options);
const report = applySetup(plan, options);
if (report.applied[0] !== host) throw new Error(JSON.stringify(report));
receiptPath = plan.actions[0].receipt;
`}
if (!existsSync(receiptPath)) throw new Error("setup did not emit a receipt");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
if ((receipt.version ?? receipt.v) !== Number(version)) throw new Error("unexpected receipt version: " + JSON.stringify(receipt));
const normalize = (text) => text.replaceAll(home, "$FIXTURE");
if (receipt.changes) {
  for (const row of receipt.changes) for (const key of ["before", "after", "start"]) {
    const image = row[key];
    if (image?.bytes != null) image.bytes = Buffer.from(normalize(Buffer.from(image.bytes, "base64").toString("utf8"))).toString("base64");
  }
}
const after = readFileSync(file, "utf8");
console.log(JSON.stringify({
  commit, host, name, file: normalize(file), receiptDir: normalize(dirname(receiptPath)),
  mode: statSync(file).mode & 0o777, before: normalize(before), after: normalize(after),
  receipt: JSON.parse(normalize(JSON.stringify(receipt))),
}, null, 2));
`;
}
