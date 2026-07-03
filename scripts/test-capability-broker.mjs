import assert from "node:assert/strict";

const { listCapabilities, compactCapabilityContext, shouldInjectCapabilityContext } = await import(
  "../src/main/capability-broker.js"
);

const capabilities = listCapabilities();
assert.ok(capabilities.some((item) => item.id === "dependency.install"));
assert.ok(capabilities.some((item) => item.id === "file.index"));
assert.ok(capabilities.some((item) => item.id === "process.job"));
assert.ok(capabilities.some((item) => item.id === "artifact.reveal"));

for (const item of capabilities) {
  assert.match(item.id, /^[a-z][a-z0-9.-]+$/);
  assert.ok(item.title);
  assert.ok(item.family);
  assert.ok(Array.isArray(item.triggers));
  assert.ok(item.route);
  assert.ok(item.failOpen);
}

const context = compactCapabilityContext({ maxChars: 2500 });
assert.ok(context.includes("dependency.install"));
assert.ok(context.includes("process.job"));
assert.ok(context.includes("fail open"));
assert.ok(context.length <= 2500);

const tinyContext = compactCapabilityContext({ maxChars: 500 });
assert.ok(tinyContext.length <= 500);

assert.equal(shouldInjectCapabilityContext({ text: "你好", files: [] }), false);
assert.equal(shouldInjectCapabilityContext({ text: "分析这个 PDF", files: [{ path: "/tmp/a.pdf" }] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "安装能处理大 PDF 的依赖", files: [] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "继续", files: [], dependencyAdvisory: { text: "missing" } }), true);

console.log("capability-broker: ok");
