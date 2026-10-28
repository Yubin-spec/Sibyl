import {newChannelState, checkBudget, accept, shouldStop, parseReply, composePrompt} from './channel-policy.mjs';

const other = side => side === 'local' ? 'remote' : 'local';

export async function runChannel({id, task, store, runner, message, output = () => {}, remote, credential, agents = {}, signal, op, register = () => {}}) {
  const c = store.getConversation(id);
  const project = store.getProject(c.projectId);
  const session = store.getSession(c.localSessionId);
  const remoteProject = c.connectionId === 'local' && c.remoteProjectId ? store.getProject(c.remoteProjectId) : project;
  if (!Object.hasOwn(agents, session.tool)) throw Error('Local tool unavailable');
  if (c.connectionId === 'local' && !Object.hasOwn(agents, c.remoteAgent)) throw Error('Remote tool unavailable');

  const abort = new AbortController();
  const state = newChannelState(c.limits);
  const rt = {state, busy:{local:false, remote:false}, inbox:{local:false, remote:false}, dirty:{local:false, remote:false}, digests:{local:[], remote:[]}, stopped:false};
  const name = side => side === 'local' ? session.tool : c.remoteAgent;
  let finish;
  const finished = new Promise(resolve => {finish = resolve;});

  const persist = () => store.updateConversation(id, {usage:{messages:state.messages, turns:{...state.turns}, startedAt:state.startedAt}});

  function stopWith(reason) {
    if (rt.stopped) return;
    rt.stopped = true;
    state.stopReason = reason;
    try { store.updateConversation(id, {stopReason:reason, usage:{messages:state.messages, turns:{...state.turns}, startedAt:state.startedAt}}); } catch {}
    abort.abort();
    clearTimeout(durationTimer);
    clearTimeout(idleTimer);
    output(op, `频道停止：${reason}`);
    finish(reason);
  }

  function ensure(sessionId, tool, projectId, suffix) {
    try { return store.getSession(sessionId); }
    catch { return store.registerSession({id:sessionId, projectId, tool, title:`${c.title || '频道'} · ${suffix}`, mode:'managed', shared:false}); }
  }

  function read(side) {
    const current = store.getConversation(id);
    const from = current.cursors?.[side] ?? 0;
    const list = store.messages(id, {after:from, limit:200}).messages;
    return {
      toAnswer: list.filter(m => m.side !== side && m.side !== 'system'),
      context: list.filter(m => m.side === 'system'),
      from,
      readTo: list.length ? list.at(-1).offset + 1 : from
    };
  }

  function setCursor(side, to) {
    const current = store.getConversation(id);
    store.updateConversation(id, {cursors:{...current.cursors, [side]:to}});
  }

  function advance(side, to) {
    const current = store.getConversation(id);
    setCursor(side, Math.max(current.cursors?.[side] ?? 0, to));
  }

  async function runTurn(side, prompt, sidecar) {
    if (side === 'local') {
      const s = sidecar ? ensure('inbox-'+id, session.tool, project.id, '收件侧线') : session;
      const r = await runner(prompt, s.nativeSessionId, abort.signal, project.path, session.tool, {});
      if (r.session_id) { s.nativeSessionId = r.session_id; store.updateSession(s.id, {nativeSessionId:r.session_id}); }
      return r.result;
    }
    if (c.connectionId === 'local') {
      const s = sidecar
        ? ensure('inbox-remote-'+id, c.remoteAgent, remoteProject.id, '收件侧线')
        : ensure('remote-'+id, c.remoteAgent, remoteProject.id, 'remote');
      const r = await runner(prompt, s.nativeSessionId, abort.signal, remoteProject.path, c.remoteAgent, {});
      if (r.session_id) { s.nativeSessionId = r.session_id; store.updateSession(s.id, {nativeSessionId:r.session_id}); }
      return r.result;
    }
    const job = await remote(await credential(c.connectionId), prompt, sidecar ? {...c, id:id+'-inbox'} : c, op);
    return job.result;
  }

  async function perform(side, batch, sidecar) {
    const budget = checkBudget(state, {agent:side, now:Date.now()});
    if (!budget.allow) return stopWith(budget.reason);
    const digests = sidecar ? [] : rt.digests[side].splice(0);
    const prompt = composePrompt({task, self:name(side), peer:name(other(side)), messages:batch.toAnswer, digests, sidecar});
    const raw = await runTurn(side, prompt, sidecar);
    const {body, done} = parseReply(raw);
    const verdict = accept(state, {agent:side, text:body, now:Date.now()});
    if (!verdict.allow) return stopWith(verdict.reason);
    if (body) {
      message(id, {side, agent:name(side), text:body, deliveryStatus:'completed'});
      output(op, `[${name(side)}${sidecar ? ' · 侧线' : ''}] ${body}`);
    }
    if (sidecar) rt.digests[side].push(`对方：${batch.toAnswer.map(m => m.text).join(' / ')}\n我：${body || '(空)'}`);
    else if (done) state.done[side] = true;
    persist();
    return body;
  }

  async function runMain(side) {
    if (rt.busy[side] || rt.stopped) return;
    const batch = read(side);
    if (!batch.toAnswer.length) return check();
    rt.busy[side] = true;
    advance(side, batch.readTo);
    let body = null;
    try { body = await perform(side, batch, false); }
    catch (e) { if (!rt.stopped) { output(op, `[${name(side)}] 失败：${e.message}`); stopWith('error'); } }
    rt.busy[side] = false;
    if (body && !rt.stopped) kick(other(side));
    check();
  }

  async function runInbox(side) {
    if (rt.inbox[side] || rt.stopped) return;
    const batch = read(side);
    if (!batch.toAnswer.length) return check();
    rt.inbox[side] = true;
    advance(side, batch.readTo);
    let body = null;
    try { body = await perform(side, batch, true); }
    catch (e) { if (!rt.stopped) { output(op, `[${name(side)} · 侧线] 失败：${e.message}`); setCursor(side, batch.from); } }
    rt.inbox[side] = false;
    if (body && !rt.stopped) kick(other(side));
    if (rt.dirty[side]) { rt.dirty[side] = false; kick(side); }
    check();
  }

  function kick(side) {
    if (rt.stopped || abort.signal.aborted) return;
    if (state.done[side]) {
      if (!read(side).toAnswer.some(m => m.side === 'human')) return;
      state.done[side] = false;
    }
    if (rt.busy[side]) {
      if (rt.inbox[side]) rt.dirty[side] = true;
      else void runInbox(side);
      return;
    }
    void runMain(side);
  }

  function check() {
    if (rt.stopped) return;
    if (rt.busy.local || rt.busy.remote || rt.inbox.local || rt.inbox.remote) return;
    const unread = {local:read('local').toAnswer, remote:read('remote').toAnswer};
    const wanted = side => unread[side].length > 0 && (!state.done[side] || unread[side].some(m => m.side === 'human'));
    const pending = {local:wanted('local'), remote:wanted('remote')};
    const reason = shouldStop(state, {now:Date.now(), busy:false});
    if (!pending.local && !pending.remote) return stopWith(reason || 'done');
    if (reason === 'timeout' || reason === 'budget') return stopWith(reason);
    if (pending.local) kick('local');
    if (pending.remote) kick('remote');
  }

  let idleTimer;
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (rt.stopped) return;
      if (rt.busy.local || rt.busy.remote || rt.inbox.local || rt.inbox.remote) return resetIdle();
      stopWith('idle');
    }, state.limits.idleTimeoutMs);
  }

  const durationTimer = setTimeout(() => stopWith('timeout'), state.limits.maxDurationMs);
  const onAbort = () => stopWith('human_stop');
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, {once:true});

  register({
    send(text) {
      if (rt.stopped) throw Error('频道已停止');
      if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw Error('Invalid message');
      message(id, {side:'human', text, deliveryStatus:'delivered'});
      resetIdle();
      kick('local');
      kick('remote');
    },
    stop: reason => stopWith(reason || 'human_stop')
  });

  resetIdle();
  kick('local');
  return finished;
}
