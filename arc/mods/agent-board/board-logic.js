// Board state and transitions. No Herdr imports: node --test covers every send and move.

export const STATES = ["todo", "doing", "review", "done"];
export const NEXT_STATE = { todo: "doing", doing: "review", review: "done", done: "todo" };
const TASK_STATE = { pending: "todo", in_progress: "doing", completed: "review" };
const resting = (status) => status === "done" || status === "idle";
const turnOf = (agent) => Number.isFinite(agent?.turn) ? agent.turn : 0;

export const agentKey = (address, taskId) => `${address}#${taskId}`;
export const rejectionText = (reason) => `验收没通过：${reason}`;

export function sendArgs(address, text) {
  return ["send", address, ...(text.startsWith("-") ? ["--"] : []), text];
}

export function newUserCard({ id, text, space, now, images = [] }) {
  return {
    id, text: String(text).trim(), images, space, terminal: null, state: "todo",
    queued: false, sentTurn: null, back: null, created_ms: now, moved_ms: now,
  };
}

// Agent tasks are views over agent.now, never copied into board.cards. A rejection is
// only a local overlay until that task changes or its following turn finishes.
export function deriveCards({ cards = [], agents = {}, accepted = [], rejected = {} } = {}) {
  const acceptedSet = new Set(accepted);
  const users = cards.filter((card) => STATES.includes(card.state)).map((card) => ({
    ...card, key: `user:${card.id}`, source: "user", agent: agents[card.terminal] ?? null,
  }));
  const tasks = [];
  for (const [address, agent] of Object.entries(agents)) {
    for (const task of Array.isArray(agent?.tasks) ? agent.tasks : []) {
      const state = TASK_STATE[task?.status];
      if (!state || task.id == null) continue;
      const key = agentKey(address, task.id);
      const rejection = rejected[key];
      tasks.push({
        id: key, key, source: "agent", taskId: task.id, text: task.subject ?? "",
        space: agent.space, terminal: address,
        state: acceptedSet.has(key) ? "done" : rejection && task.status === "completed" ? "doing" : state,
        queued: false, sentTurn: rejection?.sentTurn ?? null, back: rejection?.reason ?? null,
        created_ms: agent.now_ms ?? null, moved_ms: agent.now_ms ?? null,
        agent,
      });
    }
  }
  return [...users, ...tasks];
}

export function visibleCards(cards, { all = false, activeSpace = null, filter = null } = {}) {
  return cards.filter((card) => (all || card.space === activeSpace) && (!filter || card.space === filter));
}

export function taskProgress(agent, accepted = []) {
  const tasks = Array.isArray(agent?.tasks) ? agent.tasks.filter((task) => TASK_STATE[task?.status]) : [];
  if (!tasks.length) return null;
  const done = new Set(accepted);
  return {
    done: tasks.filter((task) => task.status === "completed" || done.has(agentKey(agent.address, task.id))).length,
    total: tasks.length,
  };
}

const unchanged = (cards) => ({ cards, send: null, needsAssignment: false, changed: false });
const withCard = (cards, id, next) => cards.map((card) => card.id === id ? next : card);

function startDoing(card, agents, now) {
  const agent = agents[card.terminal];
  const ready = agent && (resting(agent.status) || agent.status === null);
  const next = {
    ...card, state: "doing", moved_ms: now, back: null,
    queued: Boolean(card.terminal && !ready), sentTurn: card.terminal && ready ? turnOf(agent) : null,
  };
  return {
    next,
    send: ready ? { cardId: card.id, address: card.terminal, text: card.text, images: card.images ?? [] } : null,
  };
}

export function moveUserCard(cards, id, to, { agents = {}, now = Date.now() } = {}) {
  const card = cards.find((item) => item.id === id);
  if (!card || !STATES.includes(to) || card.state === to) return unchanged(cards);
  if (to === "doing") {
    const { next, send } = startDoing(card, agents, now);
    return { cards: withCard(cards, id, next), send, needsAssignment: !card.terminal, changed: true };
  }
  const next = {
    ...card, state: to, moved_ms: now, queued: false,
    sentTurn: to === "todo" ? null : card.sentTurn,
    back: to === "todo" ? null : card.back,
  };
  return { cards: withCard(cards, id, next), send: null, needsAssignment: false, changed: true };
}

export function assignUserCard(cards, id, address, { agents = {}, now = Date.now() } = {}) {
  const card = cards.find((item) => item.id === id);
  if (!card || card.state !== "doing" || card.terminal || !address) return unchanged(cards);
  const assigned = { ...card, terminal: address };
  const { next, send } = startDoing(assigned, agents, now);
  return { cards: withCard(cards, id, next), send, needsAssignment: false, changed: true };
}

// Clears queued before returning a send. Callers must persist `cards` before hc(),
// so rendering or polling the same idle agent again cannot send the text twice.
export function planUserTransitions(cards, agents = {}, now = Date.now()) {
  let changed = false;
  const sends = [];
  const next = cards.map((card) => {
    if (card.state !== "doing" || !card.terminal) return card;
    const agent = agents[card.terminal];
    if (card.queued) {
      if (!agent || !resting(agent.status)) return card;
      changed = true;
      const sentTurn = turnOf(agent);
      sends.push({ cardId: card.id, address: card.terminal, text: card.text, images: card.images ?? [] });
      return { ...card, queued: false, sentTurn };
    }
    if (card.sentTurn == null || !agent || !resting(agent.status) || !Number.isFinite(agent.turn) || agent.turn <= card.sentTurn) return card;
    changed = true;
    return { ...card, state: "review", queued: false, moved_ms: now };
  });
  return { cards: changed ? next : cards, sends, changed };
}

export function acceptAgentTask(accepted, key) {
  return accepted.includes(key) ? accepted : [...accepted, key];
}

export function rejectUserCard(cards, id, reason, { agents = {}, now = Date.now() } = {}) {
  const card = cards.find((item) => item.id === id);
  const clean = String(reason ?? "").trim();
  if (!card || card.state !== "review" || !clean) return unchanged(cards);
  const sentTurn = card.terminal ? turnOf(agents[card.terminal]) : null;
  const next = { ...card, state: "doing", queued: false, sentTurn, back: clean, moved_ms: now };
  return {
    cards: withCard(cards, id, next),
    send: card.terminal ? { cardId: id, address: card.terminal, text: rejectionText(clean) } : null,
    needsAssignment: !card.terminal, changed: true,
  };
}

export function rejectAgentTask(rejected, key, address, reason, turn) {
  const clean = String(reason ?? "").trim();
  if (!clean || !address) return { rejected, send: null, changed: false };
  return {
    rejected: { ...rejected, [key]: { reason: clean, sentTurn: Number.isFinite(turn) ? turn : 0 } },
    send: { cardId: key, address, text: rejectionText(clean) }, changed: true,
  };
}

export function pruneRejected(rejected, agents = {}) {
  let changed = false;
  const next = {};
  for (const [key, rejection] of Object.entries(rejected)) {
    const at = key.indexOf("#");
    const agent = agents[key.slice(0, at)];
    const taskId = key.slice(at + 1);
    const task = agent?.tasks?.find((item) => String(item.id) === taskId);
    const finishedNextTurn = resting(agent?.status) && Number.isFinite(agent?.turn) && agent.turn > rejection.sentTurn;
    if (task?.status === "completed" && !finishedNextTurn) next[key] = rejection;
    else changed = true;
  }
  return { rejected: changed ? next : rejected, changed };
}
