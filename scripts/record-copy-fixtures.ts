// Usage: bun scripts/record-copy-fixtures.ts <directory-containing-consumer-checkouts>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureConsumerCopies, type ConsumerCopy } from "./fixture-capture.ts";

const common = ["claude", "codex", "kimi", "pi", "qwen", "jcode"];
const destination = join(import.meta.dir, "../fixtures/copies");
mkdirSync(destination, { recursive: true });
captureConsumerCopies(process.argv[2], (copy, commit, run) => {
  const hosts = copy === "agent-mem" ? [...common, "opencode", "gemini"] : common;
  const cases: Array<readonly [string, "standard" | "tilde-home" | "empty-home"]> =
    hosts.map((host) => [host, "standard"]);
  if (copy !== "agent-mem") cases.push(["qwen", "tilde-home"], ["jcode", "empty-home"]);
  const recordings = cases.map(([host, variant]) =>
    JSON.parse(run(recorder(copy), `${host}-${variant}`, [host, variant])),
  );
  writeFileSync(join(destination, `${copy}.json`), JSON.stringify({ copy, commit, cases: recordings }, null, 2) + "\n");
});

function recorder(copy: ConsumerCopy): string {
  const memory = copy === "agent-mem";
  const vault = copy === "vault-mem";
  return `
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ${memory ? "planSetup, applySetup, undoSetup" : "runSetup"} } from "./src/setup.ts";

const [home, host, variant] = process.argv.slice(2);
const name = ${JSON.stringify(memory ? "amem" : vault ? "vmem" : "ares")}, bin = join(home, "bin"), runtime = join(bin, "bun");
const env = {
  HOME: home, PATH: bin, TMPDIR: home, AMEM_HOME: join(home, "memory"), VMEM_HOME: join(home, "vault"),
  AGENTHUB_HOME: join(home, "hub"), CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
  KIMI_CODE_HOME: join(home, ".kimi-code"), PI_CODING_AGENT_DIR: join(home, ".pi/agent"), QWEN_HOME: join(home, ".qwen"),
  JCODE_HOME: join(home, ".jcode"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state"), GEMINI_CLI_HOME: home,
  ORCA_USER_DATA_PATH: join(home, "orca"),
};
if (variant === "tilde-home") env.QWEN_HOME = "~/custom-qwen";
if (variant === "empty-home") env.JCODE_HOME = "";
const put = (file, text, mode = 0o600) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode });
};
put(runtime, "#!/bin/sh\\nexit 1\\n", 0o700);
put(join(bin, host), "#!/bin/sh\\necho 0.0.0-fixture\\n", 0o700);
const table = {
  claude: [join(env.CLAUDE_CONFIG_DIR, ".claude.json"), join(env.CLAUDE_CONFIG_DIR, "settings.json")],
  codex: [join(env.CODEX_HOME, "config.toml"), join(env.CODEX_HOME, "hooks.json")],
  kimi: [join(env.KIMI_CODE_HOME, "mcp.json"), join(env.KIMI_CODE_HOME, "config.toml")],
  pi: [join(env.PI_CODING_AGENT_DIR, "mcp.json"), join(env.PI_CODING_AGENT_DIR, "extensions/amem-session.ts")],
  qwen: [join(variant === "tilde-home" ? join(home, "custom-qwen") : env.QWEN_HOME, "settings.json")],
  jcode: [join(env.JCODE_HOME || join(home, ".jcode"), "mcp.json"), join(env.JCODE_HOME || join(home, ".jcode"), "config.toml")],
  opencode: [join(env.XDG_CONFIG_HOME, "opencode/opencode.json")],
  gemini: [join(env.GEMINI_CLI_HOME, ".gemini/settings.json")],
};
const files = ${memory ? "table[host]" : "table[host].slice(0, 1)"};
const file = files[0];
if (variant === "empty-home") files.push(join(home, "mcp.json"));
const key = host === "codex" ? "mcp_servers" : host === "jcode" ? "servers" : host === "opencode" ? "mcp" : "mcpServers";
const replace = variant === "standard" && ["codex", "kimi", "jcode"].includes(host);
const old = { command: "/fixture/previous", args: ["old"] };
const seed = host === "codex"
  ? 'fixture = true\\n\\n[mcp_servers.other]\\ncommand = "/fixture/keep"\\n'
      + (replace ? '\\n[mcp_servers.' + name + ']\\ncommand = "/fixture/previous"\\nargs = ["old"]\\n' : '')
  : JSON.stringify({ [key]: { other: { command: "/fixture/keep" }, ...(replace ? { [name]: old } : {}) }, fixture: true }, null, 2) + "\\n";
if (variant !== "empty-home") put(file, seed);
const snapshot = () => Object.fromEntries(files.map((path) => [path, existsSync(path)
  ? { text: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777 }
  : null]));
const before = snapshot();

${memory ? `
const root = join(home, "release/node_modules/@staix/agent-mem");
put(join(root, "package.json"), readFileSync(new URL("./package.json", import.meta.url), "utf8"));
put(join(root, "bin/amem.js"), "// fixture runtime is not executed\\n");
// Feed the setup code its documented native registration seam. The native
// adapter creates only a scratch stdio record; the consumer owns every actual
// preview, capture edit, publication, receipt, and undo in the recording.
const native = (argv, staged) => {
  const paths = {
    claude: join(staged.CLAUDE_CONFIG_DIR, ".claude.json"),
    codex: join(staged.CODEX_HOME, "config.toml"),
    pi: join(staged.PI_CODING_AGENT_DIR, "mcp.json"),
    qwen: join(staged.QWEN_HOME, "settings.json"),
    gemini: join(staged.GEMINI_CLI_HOME, ".gemini/settings.json"),
  };
  const stagedFile = paths[host];
  if (!stagedFile) throw new Error("unexpected native registration: " + host);
  const parse = host === "codex" ? Bun.TOML.parse : JSON.parse;
  const doc = existsSync(stagedFile) ? parse(readFileSync(stagedFile, "utf8")) : {};
  const servers = doc[key] ??= {};
  if (argv[2] === "remove") delete servers[name];
  else {
    const marker = argv.indexOf("--");
    const launch = host === "qwen" || host === "gemini" ? [argv[marker - 1], ...argv.slice(marker + 1)] : argv.slice(marker + 1);
    if (launch[0] !== runtime) throw new Error("unexpected native command layout: " + JSON.stringify(argv));
    servers[name] = { ...(host === "claude" ? { type: "stdio" } : {}), command: launch[0], args: launch.slice(1), ...(host === "claude" ? { env: {} } : {}) };
  }
  put(stagedFile, host === "codex" ? Bun.TOML.stringify(doc) : JSON.stringify(doc, null, 2) + "\\n");
};
const options = { env, cwd: home, root, bun: runtime, native };` : vault ? `
const options = { env, cwd: home, home: env.VMEM_HOME, entry: { command: runtime, args: ["mcp"] } };` : `
const root = join(home, "release");
put(join(root, "package.json"), readFileSync(new URL("./package.json", import.meta.url), "utf8"));
put(join(root, "bin/ares.js"), "// fixture runtime is not executed\\n");
const options = { env, cwd: home, root };`}
const preview = () => ${memory ? 'planSetup(host, "preview", options)' : 'runSetup(host, "dry-run", options)'};
const apply = () => ${memory ? 'applySetup(planSetup(host, "apply", options), options)' : 'runSetup(host, "apply", options)'};
const undo = () => ${memory ? 'undoSetup(planSetup(host, "undo", options), options)' : 'runSetup(host, "undo", options)'};
const assertChange = (actual, expected) => { if (actual !== expected) throw new Error("expected " + expected + ", got " + actual); };

let plan;
if (variant === "tilde-home") {
  const refusal = (operation) => {
    try { operation(); }
    catch (error) {
      if (error.message.includes("QWEN_HOME")) return { change: "refused", reason: error.message };
      throw error;
    }
    throw new Error("expected a QWEN_HOME refusal");
  };
  plan = refusal(preview);
  refusal(apply);
  const afterApply = snapshot();
  refusal(undo);
  console.log(JSON.stringify({
    id: host + "-" + variant, host, name, key, file, env, plan, before, afterApply, afterUndo: snapshot(),
    entry: ${vault ? "options.entry" : '{ command: "bun", args: ["--smol", join(root, "bin/ares.js"), "mcp"] }'},
  }).replaceAll(home, "$FIXTURE"));
} else {
  const action = preview().actions[0];
  const change = action.mcpChange ?? action.change;
  assertChange(change, replace ? "replace" : "add");
  plan = { change, files: action.files ?? [action.file], ...(action.registration ? { registration: action.registration } : {}) };
  const applied = apply();
  ${memory ? 'if (applied.applied[0] !== host) throw new Error(JSON.stringify(applied));' : 'assertChange(applied.actions[0]?.change, change);'}
  const afterApply = snapshot();
  const entry = (host === "codex" ? Bun.TOML.parse(afterApply[file].text) : JSON.parse(afterApply[file].text))[key][name];
  const undone = undo();
  ${memory ? 'if (undone.restored[0] !== host) throw new Error(JSON.stringify(undone));' : 'assertChange(undone.actions[0]?.change, replace ? "restore" : "remove");'}
  console.log(JSON.stringify({ id: host + "-" + variant, host, name, key, file, env, plan, before, afterApply, afterUndo: snapshot(), entry }).replaceAll(home, "$FIXTURE"));
}
`;
}
