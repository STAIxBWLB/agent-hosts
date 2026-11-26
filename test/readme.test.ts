import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { HOSTS, type HostDefinition } from "@staix/agent-hosts";

test("the README host table matches the package's verified host definitions", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.split("\n## Supported hosts\n")[1]?.split("\n## ")[0];
  if (!section) throw new Error("README is missing the supported hosts section");
  const rows = section.split("\n").filter((line) => line.startsWith("| `"));
  const expected = Object.values<HostDefinition>(HOSTS).map(({ id, files, format, verified }) => {
    const defaults = files.map((file) => {
      const path = file.scope === "user" ? posix.join("~", file.override?.directory ?? "", file.path) : file.path;
      return `${file.scope} \`${path}\``;
    }).join(" / ");
    const layout = format.kind === "toml"
      ? `TOML \`${format.table.join(".")}\``
      : `JSON \`${format.key}\`${format.aliases?.map((alias) => ` (alias \`${alias}\`)`).join("") ?? ""}`;
    return `| \`${id}\` | ${defaults} | ${layout} | ${verified.map((version) => `\`${version}\``).join(", ")} |`;
  });
  expect(rows).toEqual(expected);
});
