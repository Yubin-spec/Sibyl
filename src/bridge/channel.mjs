/**
 * 自主频道运行时。
 *
 * 频道模式允许两个 Agent 在人类给定目标和预算内自行决定是否继续对话。
 * 所有停止条件（轮次、消息数、重复回复、空闲、人工停止、异常）都在这里收敛，
 * 避免某个 Agent 失控后无限循环。
 */
import {
  newChannelState,
  checkBudget,
  accept,
  shouldStop,
  parseReply,
  composePrompt,
} from "./channel-policy.mjs";

/**
 * 返回对话另一侧。
 *
 * local 对 remote，remote 对 local；用于把消息发给对方而不是自己。
 */
const other = (side) => (side === "local" ? "remote" : "local");

/**
 * 运行自主频道。
 *
 * 人类给出目标和预算后，两侧 Agent 根据未读消息自行决定是否继续回复。
 * 本函数负责调度两侧、维护游标、处理侧线收件，并在任何停止条件出现时收敛。
 * 所有模型调用都通过注入的 runner/remote，便于测试和跨电脑复用。
 */
export async function runChannel({
  id,
  task,
  store,
  runner,
  message,
  output = () => {},
  remote,
  credential,
  agents = {},
  signal,
  op,
  register = () => {},
}) {
  const c = store.getConversation(id);
  const project = store.getProject(c.projectId);
  const session = store.getSession(c.localSessionId);
  const remoteProject =
    c.connectionId === "local" && c.remoteProjectId
      ? store.getProject(c.remoteProjectId)
      : project;
  if (!Object.hasOwn(agents, session.tool))
    throw Error("Local tool unavailable");
  if (c.connectionId === "local" && !Object.hasOwn(agents, c.remoteAgent))
    throw Error("Remote tool unavailable");

  const abort = new AbortController();

  // 所有预算/重复/完成状态都放在纯策略层，运行器只负责调度。
  const state = newChannelState(c.limits);
  const rt = {
    state,
    busy: { local: false, remote: false },
    inbox: { local: false, remote: false },
    dirty: { local: false, remote: false },
    digests: { local: [], remote: [] },
    stopped: false,
  };

  // 把 local/remote 内部方向映射成用户可读的工具名。
  const name = (side) => (side === "local" ? session.tool : c.remoteAgent);
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });

  /**
   * 把频道用量写回会话记录。
   *
   * 消息数、双方轮次和开始时间用于 UI 展示和重启恢复。
   */
  const persist = () =>
    store.updateConversation(id, {
      usage: {
        messages: state.messages,
        turns: { ...state.turns },
        startedAt: state.startedAt,
      },
    });

  /**
   * 停止频道并统一清理计时器。
   *
   * reason 会写入 stopReason，abort 会中断正在运行的 runner；
   * 重复调用是幂等的，避免多个停止条件同时触发时重复收尾。
   */
  function stopWith(reason) {
    if (rt.stopped) return;
    rt.stopped = true;
    state.stopReason = reason;
    try {
      store.updateConversation(id, {
        stopReason: reason,
        usage: {
          messages: state.messages,
          turns: { ...state.turns },
          startedAt: state.startedAt,
        },
      });
    } catch {}
    abort.abort();
    clearTimeout(durationTimer);
    clearTimeout(idleTimer);
    output(op, `频道停止：${reason}`);
    finish(reason);
  }

  /**
   * 确保侧线/远端会话已经登记。
   *
   * 存在就直接复用；不存在则创建一个 managed 会话，保证多轮对话能延续上下文。
   */
  function ensure(sessionId, tool, projectId, suffix) {
    try {
      return store.getSession(sessionId);
    } catch {
      return store.registerSession({
        id: sessionId,
        projectId,
        tool,
        title: `${c.title || "频道"} · ${suffix}`,
        mode: "managed",
        shared: false,
      });
    }
  }

  /**
   * 读取某一侧尚未处理的消息。
   *
   * 游标之前的消息已经处理过；这里只返回新消息和系统消息。
   * readTo 是处理完这批消息后应该推进到的位置。
   */
  function read(side) {
    const current = store.getConversation(id);
    const from = current.cursors?.[side] ?? 0;
    const list = store.messages(id, { after: from, limit: 200 }).messages;
    return {
      toAnswer: list.filter((m) => m.side !== side && m.side !== "system"),
      context: list.filter((m) => m.side === "system"),
      from,
      readTo: list.length ? list.at(-1).offset + 1 : from,
    };
  }

  /**
   * 设置某一侧的读取游标。
   *
   * 游标写回会话记录，进程重启后不会重复处理同一条消息。
   */
  function setCursor(side, to) {
    const current = store.getConversation(id);
    store.updateConversation(id, {
      cursors: { ...current.cursors, [side]: to },
    });
  }

  /**
   * 只向前推进游标。
   *
   * 取当前值和目标值的较大者，防止并发回调把游标倒退。
   */
  function advance(side, to) {
    const current = store.getConversation(id);
    setCursor(side, Math.max(current.cursors?.[side] ?? 0, to));
  }

  /**
   * 执行某一侧的一次模型调用。
   *
   * - local：调用本机 runner；
   * - remote + 同项目：调用本机另一个工具；
   * - remote + 跨电脑：走 remote job。
   * sidecar=true 时使用独立侧线会话，避免主线上下文被收件回复污染。
   */
  async function runTurn(side, prompt, sidecar) {
    if (side === "local") {
      const s = sidecar
        ? ensure("inbox-" + id, session.tool, project.id, "收件侧线")
        : session;
      const r = await runner(
        prompt,
        s.nativeSessionId,
        abort.signal,
        project.path,
        session.tool,
        { fast: true },
      );
      if (r.session_id) {
        s.nativeSessionId = r.session_id;
        store.updateSession(s.id, { nativeSessionId: r.session_id });
      }
      return r.result;
    }
    if (c.connectionId === "local") {
      const s = sidecar
        ? ensure(
            "inbox-remote-" + id,
            c.remoteAgent,
            remoteProject.id,
            "收件侧线",
          )
        : ensure("remote-" + id, c.remoteAgent, remoteProject.id, "remote");
      const r = await runner(
        prompt,
        s.nativeSessionId,
        abort.signal,
        remoteProject.path,
        c.remoteAgent,
        { fast: true },
      );
      if (r.session_id) {
        s.nativeSessionId = r.session_id;
        store.updateSession(s.id, { nativeSessionId: r.session_id });
      }
      return r.result;
    }
    const job = await remote(
      await credential(c.connectionId),
      prompt,
      sidecar ? { ...c, id: id + "-inbox" } : c,
      op,
    );
    return job.result;
  }

  /**
   * 处理一批消息并产生回复。
   *
   * 步骤：预算检查 -> 拼 prompt -> 调模型 -> 解析 [[END]] -> 重复检测 -> 写消息 -> 更新状态。
   * 侧线回复会写入 digests，供主线在下一轮参考。
   */
  async function perform(side, batch, sidecar) {
    const budget = checkBudget(state, { agent: side, now: Date.now() });
    if (!budget.allow) return stopWith(budget.reason);
    const digests = sidecar ? [] : rt.digests[side].splice(0);
    const prompt = composePrompt({
      task,
      self: name(side),
      peer: name(other(side)),
      messages: batch.toAnswer,
      digests,
      sidecar,
    });

    // 模型输出可能带 [[END]]，由 parseReply 统一剥离并判断是否完成。
    const raw = await runTurn(side, prompt, sidecar);
    const { body, done } = parseReply(raw);
    const verdict = accept(state, { agent: side, text: body, now: Date.now() });
    if (!verdict.allow) return stopWith(verdict.reason);
    if (body) {
      message(id, {
        side,
        agent: name(side),
        text: body,
        deliveryStatus: "completed",
      });
      output(op, `[${name(side)}${sidecar ? " · 侧线" : ""}] ${body}`);
    }
    if (sidecar)
      rt.digests[side].push(
        `对方：${batch.toAnswer.map((m) => m.text).join(" / ")}\n我：${body || "(空)"}`,
      );
    else if (done) state.done[side] = true;
    persist();
    return body;
  }

  /**
   * 运行某一侧的主线回合。
   *
   * 先取未读消息并推进游标，再调用 perform；
   * 成功后立即尝试唤醒对方，让对话继续推进。
   */
  async function runMain(side) {
    // 同一侧同一时间只跑一个主线回合；忙时交给 kick 决定是否跑侧线。
    if (rt.busy[side] || rt.stopped) return;
    const batch = read(side);
    if (!batch.toAnswer.length) return check();
    rt.busy[side] = true;
    advance(side, batch.readTo);
    let body = null;
    try {
      body = await perform(side, batch, false);
    } catch (e) {
      if (!rt.stopped) {
        output(op, `[${name(side)}] 失败：${e.message}`);
        stopWith("error");
      }
    }
    rt.busy[side] = false;
    if (body && !rt.stopped) kick(other(side));
    check();
  }

  /**
   * 运行某一侧的收件侧线。
   *
   * 侧线只回答待处理消息，不扩展主线任务；
   * 失败时回滚游标，避免消息被吞掉。
   */
  async function runInbox(side) {
    // 侧线同样单飞，避免同一会话并发写消息。
    if (rt.inbox[side] || rt.stopped) return;
    const batch = read(side);
    if (!batch.toAnswer.length) return check(other(side));
    rt.inbox[side] = true;
    advance(side, batch.readTo);
    try {
      await perform(side, batch, true);
    } catch (e) {
      if (!rt.stopped) {
        output(op, `[${name(side)} · 侧线] 失败：${e.message}`);
        setCursor(side, batch.from);
      }
    }
    rt.inbox[side] = false;
    if (rt.dirty[side]) {
      rt.dirty[side] = false;
      kick(side);
    }
    check(other(side));
  }

  /**
   * 尝试唤醒某一侧。
   *
   * 如果该侧正在忙，就先跑侧线并标记 dirty；
   * 如果已经完成，只有出现新的人工消息才重新激活。
   */
  function kick(side) {
    if (rt.stopped || abort.signal.aborted) return;
    if (state.done[side]) {
      if (!read(side).toAnswer.some((m) => m.side === "human")) return;
      state.done[side] = false;
    }
    if (rt.inbox[side]) {
      rt.dirty[side] = true;
      return;
    }
    if (rt.busy[side]) {
      void runInbox(side);
      return;
    }
    void runMain(side);
  }

  /**
   * 检查是否还有工作或应该停止。
   *
   * 没有任何未读消息时按策略停止；
   * 仍有时只唤醒需要的侧，避免双方空转。
   */
  function check(skip) {
    if (rt.stopped) return;
    if (rt.busy.local || rt.busy.remote || rt.inbox.local || rt.inbox.remote)
      return;
    const unread = {
      local: read("local").toAnswer,
      remote: read("remote").toAnswer,
    };
    /**
     * 判断某一侧是否还需要继续处理。
     *
     * 有未读消息时通常需要继续；但如果该侧已经标记完成，
     * 只有出现新的人工消息才重新唤醒，避免 Agent 之间无意义地互相回复。
     */
    const wanted = (side) =>
      unread[side].length > 0 &&
      (!state.done[side] || unread[side].some((m) => m.side === "human"));

    const pending = { local: wanted("local"), remote: wanted("remote") };
    const reason = shouldStop(state, { now: Date.now(), busy: false });
    if (!pending.local && !pending.remote) return stopWith(reason || "done");
    if (reason === "timeout" || reason === "budget") return stopWith(reason);
    if (pending.local && skip !== "local") kick("local");
    if (pending.remote && skip !== "remote") kick("remote");
  }

  let idleTimer;

  /**
   * 重置空闲计时器。
   *
   * 每次收到人工消息或完成任务后重新计时；
   * 真正空闲超时才停止频道。
   */
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (rt.stopped) return;
      if (rt.busy.local || rt.busy.remote || rt.inbox.local || rt.inbox.remote)
        return resetIdle();
      stopWith("idle");
    }, state.limits.idleTimeoutMs);
  }

  // 总时长硬上限：即使双方一直有输出，也不能无限运行。
  const durationTimer = setTimeout(
    () => stopWith("timeout"),
    state.limits.maxDurationMs,
  );

  // 上层取消（用户停止或控制面关闭）统一记为 human_stop，并清理计时器。
  const onAbort = () => stopWith("human_stop");
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  register({
    send(text) {
      if (rt.stopped) throw Error("频道已停止");
      if (typeof text !== "string" || !text.trim() || text.length > 10000)
        throw Error("Invalid message");
      message(id, { side: "human", text, deliveryStatus: "delivered" });
      resetIdle();
      kick("local");
    },
    stop: (reason) => stopWith(reason || "human_stop"),
  });

  resetIdle();
  kick("local");
  return finished;
}
