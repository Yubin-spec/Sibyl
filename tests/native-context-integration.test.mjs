/**
 * 原生 MCP 上下文集成测试。
 *
 * 启动真实控制面和真实 stdio MCP 子进程，验证三件事：
 * - 来源会话能从当前项目解析出已保存的跨工具目标；
 * - DeepSeek Harness 注册后能看到桥接工具；
 * - 上下文、会话和工具列表不是测试桩模拟出来的。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createControl } from "../src/app/control.mjs";

/**
 * 创建一个最小的 MCP stdio 客户端。
 *
 * 子进程启动 native-mcp.mjs 后，按 JSON-RPC 行协议发送请求；
 * 每个请求用递增 id 关联响应，超时或子进程退出时拒绝等待中的请求。
 */
function mcpClient(dir, cwd, tool = "codex") {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../src/native/native-mcp.mjs", import.meta.url)),
      "--dir",
      dir,
      "--tool",
      tool,
    ],
    { cwd, stdio: ["pipe", "pipe", "pipe"] },
  );

  const pending = new Map();
  let serial = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  // 逐行解析 stdout；只处理当前客户端发出且仍在等待的请求。
  createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line);
    const waiter = pending.get(value.id);
    if (!waiter) return;
    pending.delete(value.id);
    if (value.error) waiter.reject(Error(value.error.message));
    else waiter.resolve(value.result);
  });

  // 子进程退出时，把所有未完成的请求统一拒掉，避免测试一直挂住。
  child.on("close", () => {
    for (const waiter of pending.values())
      waiter.reject(Error("MCP exited: " + stderr));
    pending.clear();
  });

  return {
    /**
     * 调用一个 JSON-RPC 方法。
     *
     * 每个请求 5 秒超时；超时后从 pending 中移除，防止迟到响应串到下一个请求。
     */
    async call(method, params = {}) {
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("MCP timeout"));
        }, 5000);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    },

    /**
     * 调用一个 MCP 工具，并解析工具返回的 JSON 文本。
     *
     * isError 为真时直接抛错，让测试断言能定位到具体失败工具。
     */
    async tool(name, args = {}) {
      const value = await this.call("tools/call", { name, arguments: args });
      if (value.isError) throw Error(value.content[0].text);
      return JSON.parse(value.content[0].text);
    },

    /**
     * 关闭 MCP 子进程。
     *
     * 已退出时直接返回；否则关闭 stdin 并等待 close 事件。
     */
    async close() {
      if (child.exitCode !== null) return;
      child.stdin.end();
      await new Promise((resolve) => child.once("close", resolve));
    },
  };
}

test("bridge_context resolves the saved cross-tool target from the current project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-context-integration-"));
  const control = await createControl({
    dir,
    detect: async () => ({ claude: "test", codex: "test" }),
  });
  let mcp;

  await new Promise((resolve) =>
    control.server.listen(0, "127.0.0.1", resolve),
  );
  const base = `http://127.0.0.1:${control.server.address().port}`;

  // 所有控制面请求都必须带同源 Origin 和 CSRF 头，和桌面 UI 的行为保持一致。
  const call = async (path, body) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        origin: base,
        "x-bridge-ui": control.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };

  try {
    // 准备两个项目，并把 claude 目标绑定到 Target。
    const targetPath = join(dir, "target");
    await mkdir(targetPath);
    const source = await call("/api/projects/save", {
      name: "Source",
      path: dir,
    });
    const target = await call("/api/projects/save", {
      name: "Target",
      path: targetPath,
    });
    await call("/api/bindings/save", {
      sourceProjectId: source.id,
      targetTool: "claude",
      targetProjectId: target.id,
    });

    // 从 Source 项目启动 MCP 会话，未登记时也应能只读返回保存的目标。
    mcp = mcpClient(dir, dir);
    await mcp.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    let preview = await mcp.tool("bridge_context");
    for (let i = 0; i < 40 && preview.targets[0]?.available === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      preview = await mcp.tool("bridge_context");
    }
    assert.equal(preview.registered, false);
    assert.deepEqual(preview.targets, [
      {
        tool: "claude",
        projectId: target.id,
        projectName: "Target",
        available: true,
      },
    ]);
    assert.equal(preview.caller.project.name, "Source");

    // 真正决定通信后才登记，登记后的上下文仍保留同一套目标路由。
    const session = await mcp.tool("bridge_open_session", {
      title: "source task",
    });
    const context = await mcp.tool("bridge_context", {
      sessionId: session.id,
    });
    assert.equal(context.registered, true);
    assert.equal(context.caller.title, "source task");
    assert.match(context.guidance.routing, /saved project binding/);
  } finally {
    await mcp?.close();
    await control.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("DeepSeek Harness MCP registration exposes the bridge tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-deepseek-mcp-"));
  const control = await createControl({
    dir,
    detect: async () => ({ deepseek: "test" }),
  });
  let mcp;

  await new Promise((resolve) =>
    control.server.listen(0, "127.0.0.1", resolve),
  );

  try {
    // DeepSeek Harness 以自己的工具身份连接，工具列表必须包含 bridge_consult。
    mcp = mcpClient(dir, dir, "deepseek");
    await mcp.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const listed = await mcp.call("tools/list");
    assert.ok(listed.tools.some((tool) => tool.name === "bridge_consult"));

    // 注册后的会话上下文应保留 DeepSeek 身份，供桥接层路由。
    const session = await mcp.tool("bridge_open_session", {
      title: "deepseek task",
    });
    const context = await mcp.tool("bridge_context", {
      sessionId: session.id,
    });
    assert.equal(context.caller.tool, "deepseek");
  } finally {
    await mcp?.close();
    await control.close();
    await rm(dir, { recursive: true, force: true });
  }
});
