/**
 * 待处理事项聚合器。
 *
 * 把配对请求、失败任务、中断的核对等记录归一成 UI 可排序的 attention 项。
 * 隐藏/忽略只影响提醒，不改变原始任务状态。
 */
const reviewStatuses = new Set(["failed", "stalled", "timeout", "interrupted"]);

/**
 * 压缩展示文本。
 *
 * 去空白并截断到 max 字符，避免长错误信息把提醒卡撑爆。
 */
const clip = (value, max = 180) => {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};

/**
 * 按项目 id 查名称。
 *
 * 找不到时返回空串，由调用方决定是否省略这一段。
 */
const projectName = (projects, id) =>
  projects.find((project) => project.id === id)?.name || "";

/**
 * 生成核对停止原因的展示文本。
 *
 * 优先显示错误/停止原因，再拼上来源项目和目标项目路径。
 */
const detailForConsult = (record, projects) => {
  const route = record.route || {};
  const source =
    route.sourceProjectName || projectName(projects, record.sourceProjectId);
  const target =
    route.targetProjectName || projectName(projects, record.targetProjectId);
  const path = [source, target].filter(Boolean).join(" → ");
  const reason = clip(
    record.error ||
      record.stopReason ||
      "本次只读核对已停止，来源任务未受影响。",
  );
  return [path, reason].filter(Boolean).join(" · ");
};

/**
 * 把各种异常记录聚合成待处理事项。
 *
 * 输入配对请求、停止的核对、失败会话和已忽略 key；
 * 输出按“配对 > 核对 > 会话”排序的提醒列表。
 * 已忽略的可忽略项不会再次出现，但原始任务状态不变。
 */
export function attentionItems({
  requests = [],
  consultations = [],
  conversations = [],
  projects = [],
  dismissed = [],
} = {}) {
  // dismissed 只影响提醒，不修改原始记录。
  const ignored = new Set(Array.isArray(dismissed) ? dismissed : []);
  const items = [];

  for (const request of Array.isArray(requests) ? requests : []) {
    if (!request?.id) continue;
    items.push({
      key: `pair:${request.id}`,
      kind: "pair",
      title: `${clip(request.name, 80) || "未知电脑"} 请求配对`,
      detail: `${clip(request.ip, 80) || "未知地址"} · 同意后对方将获得独立连接权限`,
      pairId: request.id,
      dismissible: false,
    });
  }

  for (const record of Array.isArray(consultations) ? consultations : []) {
    if (!record?.id || !reviewStatuses.has(record.status)) continue;
    items.push({
      key: `consult:${record.id}:${record.updatedAt || record.startedAt || ""}`,
      kind: "consult",
      title: "只读核对已停止",
      detail: detailForConsult(record, projects),
      consultId: record.id,
      dismissible: true,
    });
  }

  for (const conversation of Array.isArray(conversations)
    ? conversations
    : []) {
    if (
      !conversation?.id ||
      conversation.status !== "failed" ||
      conversation.archived
    )
      continue;
    const project = projectName(projects, conversation.projectId);
    const reason = clip(
      conversation.stopReason || "运行失败，详情见会话运行记录。",
    );
    items.push({
      key: `conversation:${conversation.id}:${conversation.updatedAt || ""}`,
      kind: "conversation",
      title: `会话执行失败 · ${clip(conversation.title, 80) || "未命名会话"}`,
      detail: [project, reason].filter(Boolean).join(" · "),
      conversationId: conversation.id,
      dismissible: true,
    });
  }

  // 配对请求最紧急，其次是停止的核对，最后是失败会话。
  const order = { pair: 0, consult: 1, conversation: 2 };
  return items
    .filter((item) => !item.dismissible || !ignored.has(item.key))
    .sort((a, b) => order[a.kind] - order[b.kind]);
}
