import { expect, test } from "bun:test";

test("the package entry point imports", async () => {
  expect(await import("@staix/agent-hosts")).toBeDefined();
});
