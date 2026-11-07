/**
 * Claude 调试日志脱敏器。
 *
 * 只提取 HTTP 状态、错误码和 API 尝试次数，绝不把原始日志、提示词或凭证带出主机。
 */
// Only allowlisted error classifications leave the host. Never return raw debug lines.

/**
 * 从 Claude debug 日志提取脱敏诊断。
 *
 * 只统计 HTTP 状态、连接错误、网络错误码和 API 尝试次数；
 * 原始日志、提示词和凭证永远不会返回。
 */
export function summarizeClaudeDebug(text) {
  const statuses = new Set(),
    codes = new Set();
  let connectionErrors = 0,
    apiAttempts = 0,
    apiRequests = 0;
  for (const line of text.split("\n")) {
    // 只统计请求次数，不保留请求内容。
    if (line.includes("[API REQUEST]")) apiRequests++;
    const api = line.match(
      /API error \(attempt (\d+)\/\d+\):\s*(\d{3}|undefined)/,
    );
    if (api) {
      apiAttempts = Math.max(apiAttempts, Number(api[1]));
      if (api[2] !== "undefined") statuses.add(Number(api[2]));
      if (/Connection error/i.test(line)) connectionErrors++;
    }

    // 网络错误码白名单，避免把任意日志片段带出主机。
    for (const match of line.matchAll(
      /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPERM|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)\b/g,
    ))
      codes.add(match[1]);
  }
  return {
    httpStatuses: [...statuses].sort((a, b) => a - b),
    connectionErrors,
    networkCodes: [...codes].sort(),
    apiAttempts,
    apiRequests,
  };
}
