import { expect, test } from "bun:test";
import { createJsonMcpCodec, SETUP_CONFIG_BYTES, type ConfigImage } from "@staix/agent-hosts";

const label = "fixture/config.json";
const codec = createJsonMcpCodec({ canonicalKey: "servers", aliases: ["mcpServers"], entryName: 'owned"entry', label });
const image = (text: string): ConfigImage => ({ bytes: Buffer.from(text).toString("base64"), mode: 0o640 });
const key = JSON.stringify('owned"entry');

test("canonicalizes an alias and restores it without rewriting unrelated or later edits", () => {
  const original = '{ "mcpServers": {"other":{"command":"user-server","raw":9007199254740993}}, "unknown":1e99 }\r\n';
  const before = image(original);
  const entry = { command: "bun", args: ["mcp"] };
  const after = codec.put(before, entry);
  const installed = original.replace('"mcpServers"', '"servers"').replace(
    '"raw":9007199254740993}', '"raw":9007199254740993},' + key + ':' + JSON.stringify(entry),
  );
  expect(after).toEqual(image(installed));
  expect(codec.read(after)).toEqual(entry);

  const current = image(installed.replace('"unknown":1e99', '"unknown":2e99'));
  expect(codec.restore(before, after, current)).toEqual(image(original.replace('"unknown":1e99', '"unknown":2e99')));
});

test("replacing one JSON entry preserves every byte outside that value", () => {
  const original = `{\r\n "servers": { ${key} : { "command" : "old" }, "other" : { "keep" : 9007199254740995 } },\r\n "unknown":1e99\r\n}\r\n`;
  const before = image(original);
  const entry = { command: "new" };
  expect(codec.put(before, entry)).toEqual(image(original.replace('{ "command" : "old" }', JSON.stringify(entry))));
});

test.each([
  '{// JSONC is outside the codec boundary\n"servers":{}}',
  '{"servers":[]}',
  '{"mcpServers":{},"servers":{}}',
  '{"servers":{},"servers":{}}',
  `{"servers":{${key}:{},${key}:{}}}`,
  `{"servers":{${key}:{"args":[{"x":1,"x":2}]}}}`,
])("names the file when it refuses malformed or ambiguous JSON (%s)", (text) => {
  expect(() => codec.put(image(text), { command: "bun" })).toThrow(label);
});

test("refuses a JSON image over the 8 MiB limit", () => {
  const oversized = image('{"padding":"' + "x".repeat(SETUP_CONFIG_BYTES) + '"}');
  expect(() => codec.read(oversized)).toThrow(label);
});
