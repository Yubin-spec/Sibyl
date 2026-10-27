// Only allowlisted error classifications leave the host. Never return raw debug lines.
export function summarizeClaudeDebug(text) {
  const statuses=new Set(),codes=new Set();let connectionErrors=0,apiAttempts=0,apiRequests=0;
  for(const line of text.split('\n')) {
    if(line.includes('[API REQUEST]'))apiRequests++;
    const api=line.match(/API error \(attempt (\d+)\/\d+\):\s*(\d{3}|undefined)/);
    if(api){apiAttempts=Math.max(apiAttempts,Number(api[1]));if(api[2]!=='undefined')statuses.add(Number(api[2]));if(/Connection error/i.test(line))connectionErrors++;}
    for(const match of line.matchAll(/\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPERM|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)\b/g))codes.add(match[1]);
  }
  return {httpStatuses:[...statuses].sort((a,b)=>a-b),connectionErrors,networkCodes:[...codes].sort(),apiAttempts,apiRequests};
}
