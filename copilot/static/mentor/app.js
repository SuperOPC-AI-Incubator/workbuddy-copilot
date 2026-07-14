// 导师观察台前端逻辑
// 三栏：学员列表 / 对话列表 / 时间线（徽章+卡片四类型区分）
//
// 架构：内存 state 单一数据源
//   - 所有 render 只读 state；事件只改 state 再 render（不从 DOM 反读）
//   - 学员可控文本一律 textContent / createElement，禁止 innerHTML 拼接（防 XSS）
//
// 数据来源：
//   GET  /api/mentor/students                       学员列表
//   GET  /api/mentor/students/{id}/sessions         某学员的对话列表
//   GET  /api/mentor/sessions/{id}/timeline         某对话的时间线
//   POST /api/mentor/message {student_id,text}      导师定向发消息
//   WS   /ws/mentor                                 实时事件推送

'use strict';

// ─────────────────────────────────────────────────────────────
// 单一数据源
// ─────────────────────────────────────────────────────────────
const state = {
  students: [],          // [{student_id, display_name, last_severity, session_count, analysis_count, alert_count, ...}]
  sessions: [],          // [{session_id, session_title, last_severity, analysis_count, alert_count, ...}]
  timeline: [],          // 归一化条目（见 normalize* 函数）
  currentStudentId: null,
  currentSessionId: null,
  lastSeenMessageId: null,
  // 对话列表分组折叠态（空间/任务），跨重渲染保留（事件只改此处再 render）
  groupCollapsed: { space: false, task: false },
  // 会话级完整对话原文（懒加载，一处入口共享；切会话即重置）
  transcript: newTranscriptState(),
  // 导师触发上传的唯一状态源；REST/WS 都先归一化到这里再渲染。
  uploadRequest: newUploadRequestState(),
  // AI 回复摘要卡「显示详情」热加载缓存，按 reply_ref 存：
  //   { open, loading, content:null|string, failed } —— 展开态与已加载内容都在此，
  //   不从 DOM 反读、跨重渲染保留；加载过一次即缓存，隐藏后再展开不重新请求。
  replies: {},
};

// 取（惰性创建）某 reply_ref 的回复展开态
function replyState(replyRef) {
  const key = String(replyRef);
  if (!state.replies[key]) {
    state.replies[key] = { open: false, loading: false, content: null, failed: false };
  }
  return state.replies[key];
}

// 换会话/换学员 → 清空上一会话的 AI 回复展开缓存
function resetReplies() {
  state.replies = {};
}

// transcript 状态机：content 命中即成功；missing=404；failed=其他错误；loading=请求中
function newTranscriptState() {
  return { open: false, loading: false, content: null, missing: false, failed: false };
}

function resetTranscript() {
  state.transcript = newTranscriptState();
}

function newUploadRequestState() {
  return {
    requestId: null,
    studentId: null,
    transferStatus: null,
    analysisStatus: null,
    transferError: '',
    analysisError: '',
    result: null,
    studentOnline: null,
    updatedAt: 0,
  };
}

const studentListEl = document.getElementById('student-list');
const sessionListEl = document.getElementById('session-list');
const timelineEl = document.getElementById('timeline');
const wsStatusEl = document.getElementById('ws-status');
const composeForm = document.getElementById('compose');
const composeInput = document.getElementById('compose-input');
const composeSend = document.getElementById('compose-send');
const transcriptEntryEl = document.getElementById('transcript-entry');
const transcriptBodyEl = document.getElementById('transcript-body');
const syncBtn = document.getElementById('sync-student');
const syncFeedbackEl = document.getElementById('sync-feedback');
const retryAnalysisBtn = document.getElementById('retry-analysis');

let outboundSeq = 0; // 出站消息本地唯一 id 生成器
let uploadPollController = null;
let uploadPollTimer = null;
let uploadTrackingGeneration = 0;
let uploadAttemptGeneration = 0;
const MENTOR_TOKEN_STORAGE_KEY = 'workbuddy_copilot_mentor_token';

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────
function severityClass(severity) {
  if (severity === 'error') return 'status-red';
  if (severity === 'warn') return 'status-yellow';
  return 'status-green';
}

function formatTime(ts) {
  if (!ts) return '';
  // 后端时间戳为秒；容错：若像毫秒则按毫秒处理
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function currentStudentName() {
  const s = state.students.find((x) => x.student_id === state.currentStudentId);
  return (s && (s.display_name || s.student_id)) || state.currentStudentId || '学员';
}

function storedMentorToken() {
  return sessionStorage.getItem(MENTOR_TOKEN_STORAGE_KEY) || '';
}

function askMentorToken() {
  let token = window.prompt('请输入导师访问 token') || '';
  if (!token) {
    return '';
  }
  token = token.trim();
  if (token) sessionStorage.setItem(MENTOR_TOKEN_STORAGE_KEY, token);
  return token;
}

function clearMentorToken() {
  sessionStorage.removeItem(MENTOR_TOKEN_STORAGE_KEY);
}

async function authFetch(url, options) {
  const opts = Object.assign({}, options || {});
  const headers = new Headers(opts.headers || {});
  const token = storedMentorToken();
  if (token) {
    headers.set('Authorization', 'Bearer ' + token);
    headers.set('X-Copilot-Token', token);
  }
  opts.headers = headers;
  const resp = await fetch(url, opts);
  if (resp.status === 401) {
    clearMentorToken();
    wsStatusEl.textContent = '认证失败';
    const retryToken = askMentorToken();
    if (retryToken) {
      const retryOpts = Object.assign({}, options || {});
      const retryHeaders = new Headers(retryOpts.headers || {});
      retryHeaders.set('Authorization', 'Bearer ' + retryToken);
      retryHeaders.set('X-Copilot-Token', retryToken);
      retryOpts.headers = retryHeaders;
      return fetch(url, retryOpts);
    }
  }
  return resp;
}

function mentorWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(proto + '//' + location.host + '/ws/mentor');
  const token = storedMentorToken();
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

// 创建带 class 的元素并（可选）安全地设置文本
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // textContent → XSS 安全
  return node;
}

// ─────────────────────────────────────────────────────────────
// 学员列表
// ─────────────────────────────────────────────────────────────
async function loadStudents() {
  try {
    const resp = await authFetch('/api/mentor/students');
    const data = await resp.json();
    state.students = data.items || [];
    renderStudents();
  } catch (err) {
    console.error('加载学员列表失败', err);
  }
}

function renderStudents() {
  studentListEl.innerHTML = ''; // 清空骨架（非用户值），安全
  state.students.forEach((s) => {
    const li = el('li', 'student-item');
    li.dataset.studentId = s.student_id;
    if (s.student_id === state.currentStudentId) li.classList.add('selected');

    li.appendChild(el('span', 'status-dot ' + severityClass(s.last_severity)));

    const info = el('div', 'student-info');
    info.appendChild(el('div', 'name', s.display_name || s.student_id || '(未命名学员)'));
    const sessionCount = s.session_count || 0;
    const analysisCount = s.analysis_count || 0;
    info.appendChild(el('div', 'meta', sessionCount + ' 对话 · ' + analysisCount + ' 分析'));
    li.appendChild(info);

    li.addEventListener('click', () => selectStudent(s.student_id));
    studentListEl.appendChild(li);
  });
}

// ─────────────────────────────────────────────────────────────
// 选中学员 → 加载对话列表
// ─────────────────────────────────────────────────────────────
async function selectStudent(studentId) {
  uploadAttemptGeneration += 1;
  cancelUploadTracking();
  state.currentStudentId = studentId;
  state.currentSessionId = null;
  state.sessions = [];
  state.timeline = [];
  resetTranscript();  // 换学员 → 清空上一会话的原文缓存/展开态
  resetReplies();     // 换学员 → 清空 AI 回复展开缓存
  state.uploadRequest = newUploadRequestState();
  clearSyncFeedback(); // 换学员 → 清掉上一个学员的同步反馈
  renderStudents();   // 刷新选中态（读 state）
  renderSessions();
  renderTimeline();
  updateComposeEnabled();
  updateSyncEnabled(); // 选中学员后同步按钮可用
  try {
    const resp = await authFetch('/api/mentor/students/' + encodeURIComponent(studentId) + '/sessions');
    const data = await resp.json();
    state.sessions = data.items || [];
    renderSessions();
  } catch (err) {
    console.error('加载对话列表失败', err);
  }
}

function sessionTitleOf(s) {
  // 后端当前返回 title；契约字段名 session_title —— 两者都兼容
  // 标题为空（含纯空白）时显示"未命名对话"，绝不回退到原始 session_id
  // （原始 id 如 "44cc4b2e-1d3e…" / "hook-test-3" 对导师无意义、观感差）
  const raw = (s.session_title || s.title || '').trim();
  return raw || '未命名对话';
}

// 会话最后活动时间（倒序排列用）；主字段 last_activity_at，容错回退到其它时间字段
function sessionActivityTs(s) {
  const v = s.last_activity_at != null ? s.last_activity_at
    : s.last_activity != null ? s.last_activity
    : s.updated_at != null ? s.updated_at
    : s.created_at != null ? s.created_at
    : 0;
  return Number(v) || 0;
}

// ── 会话分组：空间（按 space_name 二级分组） / 任务（含 group_type="" 的其它会话） ──
//   参照 WorkBuddy 侧边栏：空间区在上、任务区在下（大组顺序固定，在 renderSessions 保证）。
//   group_type="space" → 归空间，再按 space_name 聚合；其余（"task" / "" / 缺失）→ 归任务。
//   排序（纯前端，不依赖后端顺序，和 WorkBuddy 一致：最新在上）：
//     - 任务组内：按 last_activity_at 倒序
//     - 空间子组内：按 last_activity_at 倒序
//     - 空间各子组之间：按"各子组最新会话时间"倒序
function groupSessions(sessions) {
  const spaceMap = new Map(); // space_name -> [session]（先聚合，后排序）
  const tasks = [];
  let spaceCount = 0;
  sessions.forEach((s) => {
    if ((s.group_type || '') === 'space') {
      const name = (s.space_name || '').trim() || '未命名空间';
      if (!spaceMap.has(name)) spaceMap.set(name, []);
      spaceMap.get(name).push(s);
      spaceCount += 1;
    } else {
      tasks.push(s); // "task" 或 group_type="" 一律归任务
    }
  });

  const byActivityDesc = (a, b) => sessionActivityTs(b) - sessionActivityTs(a);

  // 子组内排序 + 子组间按各自最新会话时间倒序
  const spaceSubgroups = Array.from(spaceMap.entries()).map(([name, items]) => {
    const sorted = items.slice().sort(byActivityDesc);
    const latest = sorted.length ? sessionActivityTs(sorted[0]) : 0;
    return { name, items: sorted, latest };
  });
  spaceSubgroups.sort((a, b) => b.latest - a.latest);

  const sortedTasks = tasks.slice().sort(byActivityDesc);

  return { spaceSubgroups, spaceCount, tasks: sortedTasks };
}

// 单个会话项：状态点 + 标题 + meta。
//   灰显判据："既无内容也无分析"才加 .unanalyzed 灰显（有内容就立刻点亮，不等 LLM 诊断）：
//   - 有分析(analysis_count>0)：三色 last_severity 点 + meta "X 分析 · Y 告警"。
//   - 有内容无分析(message_count>0, analysis_count=0)：不灰显 + 中性灰点 + meta "N 条对话 · 待诊断"。
//     （内容已落库、LLM 诊断后台异步补，故正常显示而非灰显。）
//   - 全空(analysis_count=0 且 message_count=0)：灰显 + 中性灰点 + meta "未分析"。
//   三种形态均可点击。
function buildSessionItem(s) {
  const item = el('div', 'session-item');
  item.dataset.sessionId = s.session_id;
  const analysisCount = s.analysis_count || 0;
  const messageCount = s.message_count || 0;
  const analyzed = analysisCount > 0;
  const hasContent = messageCount > 0;
  // 既无内容也无分析才灰显（判据从"analysis_count==0"升级为"内容与分析皆无"）
  if (!analyzed && !hasContent) item.classList.add('unanalyzed');
  if (s.session_id === state.currentSessionId) item.classList.add('selected');

  // 状态点：有分析用 last_severity 三色；否则（有内容待诊断 / 全空）用中性灰点
  const dotCls = analyzed ? severityClass(s.last_severity) : 'status-none';
  item.appendChild(el('span', 'status-dot ' + dotCls));

  const info = el('div', 'session-info');
  info.appendChild(el('div', 'name', sessionTitleOf(s)));
  const alertCount = s.alert_count || 0;
  let meta;
  if (analyzed) {
    meta = analysisCount + ' 分析' + (alertCount ? ' · ' + alertCount + ' 告警' : '');
  } else if (hasContent) {
    meta = messageCount + ' 条对话 · 待诊断';
  } else {
    meta = '未分析';
  }
  info.appendChild(el('div', 'meta', meta));
  item.appendChild(info);

  item.addEventListener('click', () => selectSession(s.session_id));
  return item;
}

// 可折叠分组标题：点标题只改 state.groupCollapsed 再整体重渲染（不从 DOM 反读）
function buildGroupHeader(groupKey, title, count) {
  const collapsed = !!state.groupCollapsed[groupKey];
  const header = el('div', 'group-header');
  header.dataset.group = groupKey;
  header.appendChild(el('span', 'group-caret', collapsed ? '▸' : '▾'));
  header.appendChild(el('span', 'group-title', title));
  header.appendChild(el('span', 'group-count', String(count)));
  header.addEventListener('click', () => {
    state.groupCollapsed[groupKey] = !state.groupCollapsed[groupKey];
    renderSessions();
  });
  return header;
}

function renderSessions() {
  sessionListEl.innerHTML = '';
  const { spaceSubgroups, spaceCount, tasks } = groupSessions(state.sessions);

  // 空间分组（有空间会话才渲染），内部再按 space_name 二级分组（子组已按最新时间倒序）
  if (spaceCount > 0) {
    const group = el('li', 'session-group');
    group.dataset.group = 'space';
    if (state.groupCollapsed.space) group.classList.add('collapsed');
    group.appendChild(buildGroupHeader('space', '空间', spaceCount));
    const body = el('div', 'group-body');
    spaceSubgroups.forEach(({ name, items }) => {
      const sub = el('div', 'space-subgroup');
      sub.appendChild(el('div', 'subgroup-title', name));
      items.forEach((s) => sub.appendChild(buildSessionItem(s)));
      body.appendChild(sub);
    });
    group.appendChild(body);
    sessionListEl.appendChild(group);
  }

  // 任务分组
  if (tasks.length > 0) {
    const group = el('li', 'session-group');
    group.dataset.group = 'task';
    if (state.groupCollapsed.task) group.classList.add('collapsed');
    group.appendChild(buildGroupHeader('task', '任务', tasks.length));
    const body = el('div', 'group-body');
    tasks.forEach((s) => body.appendChild(buildSessionItem(s)));
    group.appendChild(body);
    sessionListEl.appendChild(group);
  }
}

// ─────────────────────────────────────────────────────────────
// 选中对话 → 加载时间线（从 state.sessions 取，不从 DOM 反读）
// ─────────────────────────────────────────────────────────────
async function selectSession(sessionId) {
  state.currentSessionId = sessionId;
  resetTranscript(); // 换会话 → 原文入口回到未加载/收起态（原文是会话级）
  resetReplies();    // 换会话 → AI 回复展开缓存回到未加载/收起态
  renderSessions(); // 只更新选中态，state.sessions 不变（修 B3 伪状态 bug）
  await fetchTimeline(sessionId, { replace: true });
}

async function fetchTimeline(sessionId, { replace } = {}) {
  try {
    const resp = await authFetch('/api/mentor/sessions/' + encodeURIComponent(sessionId) + '/timeline');
    const data = await resp.json();
    const items = (data.items || []).map(normalizeRestEntry);
    if (state.currentSessionId !== sessionId) return; // 期间已切走
    if (replace) {
      // 保留尚未持久化到接口的出站消息（乐观插入的导师提示）
      const pendingOutbound = state.timeline.filter(
        (e) => e.type === 'mentor_message' && e._optimistic
      );
      state.timeline = items.concat(pendingOutbound);
    } else {
      state.timeline = items;
    }
    renderTimeline();
  } catch (err) {
    console.error('加载时间线失败', err);
  }
}

// ─────────────────────────────────────────────────────────────
// 时间线归一化：REST / WS → 统一内部结构
//   { key, type, content, created_at, severity, understanding,
//     is_technical, topic, suggestion, full_reply, prompt_id, reply_ref, has_full_reply,
//     mentor_name, message_id, server_id, delivered, _optimistic }
// ─────────────────────────────────────────────────────────────
function normalizeRestEntry(r) {
  return {
    key: 'rest-' + (r.type || '') + '-' + (r.created_at || 0) + '-' + Math.random().toString(36).slice(2, 7),
    type: r.type || 'unknown',
    content: r.content || '',
    created_at: r.created_at || 0,
    severity: r.severity || '',
    understanding: r.understanding || '',   // 后端 timeline 暂未透出，兼容将来字段
    is_technical: !!r.is_technical,
    topic: r.topic || '',
    suggestion: r.suggestion || '',
    full_reply: r.full_reply || r.full || '', // 优先完整回复字段
    // ai_summary 每条对应一次学员提问：reply_ref 用于热加载完整回复，has_full_reply 标识是否有原文
    prompt_id: r.prompt_id != null ? r.prompt_id : null,
    reply_ref: r.reply_ref || (r.prompt_id != null ? ('prompt:' + r.prompt_id) : null),
    has_full_reply: !!r.has_full_reply,
    delivered: true,
  };
}

function wsPayloadToTimeline(payload) {
  const ts = payload.timestamp || Date.now() / 1000;
  if (payload.type === 'prompt') {
    return {
      key: 'ws-prompt-' + (payload.prompt_id || ts),
      type: 'prompt',
      content: payload.prompt || '',
      created_at: ts,
    };
  }
  if (payload.type === 'ai_summary') {
    return {
      key: 'ws-ai-' + (payload.prompt_id || ts),
      type: 'ai_summary',
      content: payload.summary || payload.content || '',
      full_reply: payload.full_reply || payload.full || '',
      prompt_id: payload.prompt_id != null ? payload.prompt_id : null,
      reply_ref: payload.reply_ref || (payload.prompt_id != null ? ('prompt:' + payload.prompt_id) : null),
      has_full_reply: !!payload.has_full_reply,
      created_at: ts,
    };
  }
  if (payload.type === 'analysis') {
    const r = payload.result || {};
    return {
      key: 'ws-an-' + (payload.report_id || ts),
      type: 'analysis',
      content: r.diagnosis || '',
      suggestion: r.suggestion || '',
      severity: r.severity || '',
      understanding: r.understanding || '', // WS 分析结果带 understanding
      is_technical: !!r.is_technical,
      topic: r.topic || '',
      created_at: ts,
    };
  }
  if (payload.type === 'mentor_message') {
    // 导师台一般不收此事件（出站是自己发的），兼容处理
    return {
      key: 'ws-me-' + (payload.message_id || payload.id || ts),
      type: 'mentor_message',
      content: payload.text || '',
      mentor_name: payload.mentor_name || '导师',
      message_id: payload.message_id || null,
      server_id: payload.id != null ? payload.id : null,
      created_at: ts,
      delivered: !!payload.delivered,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 理解程度徽章：优先 understanding，缺失时从 severity 兜底
//   understanding: high|medium|low|stuck（后端 llm 值域）
//   severity: error|warn|info
// ─────────────────────────────────────────────────────────────
function understandingBadge(entry) {
  let u = (entry.understanding || '').toLowerCase();
  if (!u || u === 'unknown') {
    if (entry.severity === 'error') u = 'stuck';
    else if (entry.severity === 'warn') u = 'low';
    else u = 'mid';
  }
  if (u === 'medium') u = 'mid';
  const map = {
    stuck: { text: '卡点', cls: 'und-stuck' },
    low: { text: '薄弱', cls: 'und-low' },
    mid: { text: '一般', cls: 'und-mid' },
    high: { text: '良好', cls: 'und-high' },
  };
  return map[u] || map.mid;
}

// ─────────────────────────────────────────────────────────────
// 渲染时间线（全量重建，只读 state）
// ─────────────────────────────────────────────────────────────
function renderTimeline() {
  timelineEl.innerHTML = '';
  if (!state.timeline.length) {
    const hint = state.currentSessionId ? '此对话暂无分析记录' : '请选择一个对话';
    timelineEl.appendChild(el('div', 'timeline-empty', hint));
    renderTranscriptEntry(); // 空时间线 → 隐藏原文入口
    return;
  }
  state.timeline.forEach((entry) => timelineEl.appendChild(buildTimelineRow(entry)));
  timelineEl.scrollTop = timelineEl.scrollHeight;
  renderTranscriptEntry(); // 非空 → 显示单一原文入口
}

// 按 reply_ref 热加载该次提问的完整 AI 回复原文；结果缓存到 state.replies[replyRef]。
//   已加载(content!=null)或加载中直接返回，不重复请求 —— 隐藏后再展开即命中缓存。
//   加载中/失败态由 renderTimeline 依 state 回显（"加载中…"/"加载失败"）。
async function loadReply(replyRef) {
  const rs = replyState(replyRef);
  if (rs.content != null || rs.loading) return; // 命中缓存 / 正在请求 → 不再发请求
  rs.failed = false;
  rs.loading = true;
  renderTimeline(); // 回显"加载中…"
  try {
    const resp = await authFetch('/api/mentor/replies/' + encodeURIComponent(replyRef) + '/text');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    rs.content = data.reply || data.text || '';
  } catch (err) {
    console.error('加载 AI 完整回复失败', err);
    rs.failed = true;
  } finally {
    rs.loading = false;
  }
  renderTimeline();
}

function buildTimelineRow(entry) {
  const row = el('div', 'tl-row');
  const card = el('div', 'tl-card');
  const top = el('div', 'tl-top');

  if (entry.type === 'prompt') {
    row.appendChild(badge('badge-q', '问'));
    card.classList.add('card-q');
    top.appendChild(el('span', null, '学员提问 · ' + formatTime(entry.created_at)));
    card.appendChild(top);
    card.appendChild(el('div', 'tl-txt', entry.content));

  } else if (entry.type === 'ai_summary') {
    row.appendChild(badge('badge-ai', 'AI'));
    card.classList.add('card-ai');
    top.appendChild(el('span', null, 'AI 回复摘要 · ' + formatTime(entry.created_at)));
    card.appendChild(top);
    // 每条 ai_summary = 该次学员提问的 AI 回复摘要（50-300 字，平均约 100 字）——本就是摘要，正常显示不截断。
    // content 为空 → 显示"（未生成摘要）"占位。
    const summary = (entry.content || '').trim();
    card.appendChild(el('div', 'tl-txt ai-summary', summary || '（未生成摘要）'));

    // "显示详情"热加载：仅当有 reply_ref 且后端标识有原文时提供。
    const replyRef = entry.reply_ref || (entry.prompt_id != null ? ('prompt:' + entry.prompt_id) : null);
    if (replyRef != null && entry.has_full_reply) {
      const rs = replyState(replyRef);
      // "显示详情/隐藏" 按钮放在摘要正文下方
      const toggle = el('button', 'ai-detail-toggle', rs.open ? '隐藏 ▴' : '显示详情 ▾');
      toggle.type = 'button';
      toggle.dataset.replyRef = String(replyRef);
      toggle.addEventListener('click', () => {
        const s = replyState(replyRef);
        s.open = !s.open;
        if (s.open) loadReply(replyRef); // 首次展开热加载；已缓存则 loadReply 内部直接返回不再请求
        renderTimeline();
      });
      card.appendChild(toggle);

      // 展开态：在摘要卡下方动态渲染同款面板显示完整回复原文（textContent 防 XSS）
      if (rs.open) {
        const panel = el('div', 'ai-detail');
        if (rs.content != null) {
          panel.textContent = rs.content || '（无完整回复）';
        } else if (rs.failed) {
          panel.classList.add('pending');
          panel.textContent = '加载失败';
        } else {
          panel.classList.add('pending');
          panel.textContent = '加载中…';
        }
        card.appendChild(panel);
      }
    }

  } else if (entry.type === 'analysis') {
    row.classList.add('row-an'); // 诊断整体右缩进，视觉上区别于问/AI
    row.appendChild(badge('badge-an', '诊'));
    card.classList.add('card-an');
    top.appendChild(el('span', null, '学习诊断 · ' + formatTime(entry.created_at)));
    const ub = understandingBadge(entry);
    top.appendChild(el('span', 'und ' + ub.cls, ub.text));
    if (entry.is_technical) top.appendChild(el('span', 'techtag', '技术'));
    card.appendChild(top);
    card.appendChild(el('div', 'tl-txt', entry.content || '(无诊断)'));
    if (entry.suggestion) {
      card.appendChild(el('div', 'tl-sug', '💡 建议：' + entry.suggestion));
    }

  } else if (entry.type === 'mentor_message') {
    row.classList.add('out');
    row.appendChild(badge('badge-me', '师'));
    card.classList.add('card-me');
    const who = '导师提示 → ' + currentStudentName()
      + ' · ' + (entry.mentor_name || '导师') + ' ' + formatTime(entry.created_at);
    top.appendChild(el('span', null, who));
    top.appendChild(deliveredPill(entry));
    card.appendChild(top);
    card.appendChild(el('div', 'tl-txt', entry.content));

  } else {
    card.appendChild(top);
    card.appendChild(el('div', 'tl-txt', entry.content || ''));
  }

  row.appendChild(card);
  return row;
}

function badge(cls, text) {
  return el('div', 'tl-badge ' + cls, text);
}

function deliveredPill(entry) {
  if (entry.delivered) return el('span', 'pill', '✓ 已送达');
  if (entry._failed) return el('span', 'pill failed', '发送失败');
  return el('span', 'pill sending', '发送中…');
}

// ─────────────────────────────────────────────────────────────
// 会话级「查看完整对话原文」单一入口（时间线顶部）
//   - 时间线非空才显示；空则隐藏
//   - 首次展开时按需 lazy fetch GET /api/mentor/sessions/{id}/transcript
//   - 原文经 textContent 渲染（学员可控文本 → 防 XSS，绝不 innerHTML）
//   - 404 → 友好提示（历史会话无原文）；其他错误 → 加载失败
// ─────────────────────────────────────────────────────────────
function renderTranscriptEntry() {
  if (!transcriptEntryEl) return;
  const hasTimeline = state.timeline.length > 0;
  if (!hasTimeline) {
    transcriptEntryEl.hidden = true;
    if (transcriptEntryEl.open) transcriptEntryEl.open = false; // 收起，避免残留展开
    return;
  }
  transcriptEntryEl.hidden = false;
  // 同步 details 展开态到 state（会话切换后 state.open=false → DOM 应收起）
  if (transcriptEntryEl.open !== state.transcript.open) {
    transcriptEntryEl.open = state.transcript.open;
  }
  renderTranscriptBody();
}

// 依据 state.transcript 把当前状态回显进展开区（纯 textContent）
function renderTranscriptBody() {
  const t = state.transcript;
  const body = transcriptBodyEl;
  if (!body) return;
  if (t.content != null) {
    body.classList.remove('pending');
    body.textContent = t.content || '(此会话暂无对话原文)';
  } else if (t.missing) {
    // HTTP 404：历史会话本就没有完整原文，友好提示而非"加载失败"
    body.classList.add('pending');
    body.textContent = '（此会话暂无完整原文，可能是历史会话）';
  } else if (t.failed) {
    // 网络异常 / 其他非 2xx：真正的加载失败
    body.classList.add('pending');
    body.textContent = '加载失败';
  } else if (t.loading) {
    body.classList.add('pending');
    body.textContent = '加载中…';
  } else {
    body.classList.add('pending');
    body.textContent = '';
  }
}

// 首次展开时按需拉取当前会话完整 transcript；结果缓存到 state.transcript
async function loadTranscript() {
  const t = state.transcript;
  // 已加载 / 无原文(404) / 已失败 / 加载中：直接回显，不重复请求
  if (t.content != null || t.missing || t.failed || t.loading) {
    renderTranscriptBody();
    return;
  }
  const sessionId = state.currentSessionId;
  if (!sessionId) {
    t.failed = true;
    renderTranscriptBody();
    return;
  }
  t.loading = true;
  renderTranscriptBody(); // 显示「加载中…」
  try {
    const resp = await authFetch('/api/mentor/sessions/' + encodeURIComponent(sessionId) + '/transcript');
    if (state.transcript !== t) return; // 期间已切会话，丢弃本次结果
    if (resp.status === 404) {
      // 历史会话无 raw_transcripts：后端返回 404，是"没有"而非"出错"
      t.missing = true;
    } else if (!resp.ok) {
      throw new Error('HTTP ' + resp.status);
    } else {
      const data = await resp.json();
      if (state.transcript !== t) return;
      t.content = data.content || '';
    }
  } catch (err) {
    console.error('加载完整对话原文失败', err);
    t.failed = true;
  } finally {
    t.loading = false;
  }
  if (state.transcript === t) renderTranscriptBody();
}

// details 展开/收起：展开时懒加载（闭包引用静态 DOM，只绑定一次）
if (transcriptEntryEl) {
  transcriptEntryEl.addEventListener('toggle', () => {
    state.transcript.open = transcriptEntryEl.open;
    if (transcriptEntryEl.open) loadTranscript();
  });
}

// ─────────────────────────────────────────────────────────────
// 同步状态：POST 返回真实 request_id；WS 加速更新，REST 轮询补漏。
// 所有响应都经过 request_id + generation 校验，旧学员的慢响应不会覆盖新状态。
// ─────────────────────────────────────────────────────────────
function normalizeUploadRequest(snapshot, previous) {
  const prior = previous || newUploadRequestState();
  const legacy = snapshot.status || '';
  const transfer = snapshot.transfer_status || (
    legacy === 'done' ? 'stored' : (legacy || prior.transferStatus)
  );
  return {
    requestId: snapshot.request_id != null ? String(snapshot.request_id) : prior.requestId,
    studentId: snapshot.student_id != null ? String(snapshot.student_id) : prior.studentId,
    transferStatus: transfer || null,
    analysisStatus: snapshot.analysis_status || prior.analysisStatus || 'not_requested',
    transferError: snapshot.transfer_error || '',
    analysisError: snapshot.analysis_error || '',
    result: snapshot.result !== undefined ? snapshot.result : prior.result,
    studentOnline: snapshot.student_online !== undefined
      ? snapshot.student_online === true
      : prior.studentOnline,
    updatedAt: snapshot.updated_at != null ? Number(snapshot.updated_at) || 0 : prior.updatedAt,
  };
}

function reduceUploadRequest(snapshot) {
  if (!snapshot || snapshot.request_id == null) return false;
  const requestId = String(snapshot.request_id);
  if (state.uploadRequest.requestId && requestId !== state.uploadRequest.requestId) return false;
  const incomingUpdatedAt = snapshot.updated_at != null ? Number(snapshot.updated_at) || 0 : 0;
  if (state.uploadRequest.requestId === requestId &&
      incomingUpdatedAt < state.uploadRequest.updatedAt) return false;
  const studentId = snapshot.student_id != null ? String(snapshot.student_id) : state.uploadRequest.studentId;
  if (studentId && studentId !== state.currentStudentId) return false;
  state.uploadRequest = normalizeUploadRequest(snapshot, state.uploadRequest);
  renderUploadRequest();
  return true;
}

function uploadRequestIsTerminal(request) {
  if (!request.requestId) return true;
  if (request.transferStatus === 'failed') return true;
  if (request.transferStatus !== 'stored') return false;
  return ['not_requested', 'done', 'failed'].includes(request.analysisStatus);
}

function renderUploadRequest() {
  const request = state.uploadRequest;
  if (!request.requestId) {
    clearSyncFeedback();
    updateSyncEnabled();
    return;
  }

  let text = '';
  let isError = false;
  let canRetryAnalysis = false;
  if (request.transferStatus === 'pending') {
    text = request.studentOnline === false
      ? '学员端未启动；同步请求已保存，客户端启动后将自动接收。'
      : '已请求同步，等待学员端接收…';
  } else if (request.transferStatus === 'running') {
    text = '正在上传对话…';
  } else if (request.transferStatus === 'failed') {
    text = '同步失败' + (request.transferError ? '：' + request.transferError : '，请重试。');
    isError = true;
  } else if (request.transferStatus === 'stored') {
    if (request.analysisStatus === 'pending') {
      text = '内容已保存，诊断等待中…';
    } else if (request.analysisStatus === 'running') {
      text = '内容已保存，正在诊断…';
    } else if (request.analysisStatus === 'done') {
      text = '内容已保存，诊断完成。';
    } else if (request.analysisStatus === 'failed') {
      text = '内容已保存，诊断失败' + (request.analysisError ? '：' + request.analysisError : '。');
      isError = true;
      canRetryAnalysis = true;
    } else {
      text = '内容已保存，诊断未请求。';
    }
  } else {
    text = '同步状态未知，请重试。';
    isError = true;
  }
  showSyncFeedback(text, isError);
  if (retryAnalysisBtn) {
    retryAnalysisBtn.hidden = !canRetryAnalysis;
    retryAnalysisBtn.disabled = false;
  }
  updateSyncEnabled();
}

function updateSyncEnabled() {
  if (!syncBtn) return;
  const request = state.uploadRequest;
  const transferActive = request.studentId === state.currentStudentId &&
    ['pending', 'running'].includes(request.transferStatus);
  syncBtn.disabled = !state.currentStudentId || transferActive;
}

function showSyncFeedback(text, isError) {
  if (!syncFeedbackEl) return;
  syncFeedbackEl.hidden = false;
  syncFeedbackEl.textContent = text;
  syncFeedbackEl.classList.toggle('error', !!isError);
}

function clearSyncFeedback() {
  if (!syncFeedbackEl) return;
  syncFeedbackEl.hidden = true;
  syncFeedbackEl.textContent = '';
  syncFeedbackEl.classList.remove('error');
  if (retryAnalysisBtn) retryAnalysisBtn.hidden = true;
}

function cancelUploadTracking() {
  uploadTrackingGeneration += 1;
  if (uploadPollTimer) {
    clearTimeout(uploadPollTimer);
    uploadPollTimer = null;
  }
  if (uploadPollController) {
    uploadPollController.abort();
    uploadPollController = null;
  }
}

function scheduleUploadPoll(generation, delay) {
  if (generation !== uploadTrackingGeneration || uploadRequestIsTerminal(state.uploadRequest)) return;
  uploadPollTimer = setTimeout(() => pollUploadRequest(generation), delay);
}

async function pollUploadRequest(generation) {
  const requestId = state.uploadRequest.requestId;
  const controller = uploadPollController;
  if (!requestId || !controller || generation !== uploadTrackingGeneration) return;
  try {
    const resp = await authFetch(
      '/api/mentor/upload-requests/' + encodeURIComponent(requestId),
      { signal: controller.signal }
    );
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const snapshot = await resp.json();
    if (controller.signal.aborted || generation !== uploadTrackingGeneration ||
        state.uploadRequest.requestId !== requestId) return;
    reduceUploadRequest(snapshot);
  } catch (err) {
    if (controller.signal.aborted || err.name === 'AbortError') return;
    console.error('读取同步状态失败', err);
  }
  scheduleUploadPoll(generation, 750);
}

function beginUploadTracking(snapshot) {
  cancelUploadTracking();
  state.uploadRequest = normalizeUploadRequest(snapshot, newUploadRequestState());
  renderUploadRequest();
  if (uploadRequestIsTerminal(state.uploadRequest)) return;
  uploadPollController = new AbortController();
  const generation = uploadTrackingGeneration;
  scheduleUploadPoll(generation, 500);
}

function acceptUploadStatusEvent(snapshot) {
  if (!snapshot || snapshot.type !== 'upload_request_status') return false;
  if (!state.uploadRequest.requestId || String(snapshot.request_id) !== state.uploadRequest.requestId) return false;
  if (snapshot.student_id != null && String(snapshot.student_id) !== state.currentStudentId) return false;
  if (!reduceUploadRequest(snapshot)) return false;
  // 取消可能携带更旧数据库快照的在途轮询，再以 WS 快照为起点补拉。
  cancelUploadTracking();
  if (!uploadRequestIsTerminal(state.uploadRequest)) {
    uploadPollController = new AbortController();
    const generation = uploadTrackingGeneration;
    scheduleUploadPoll(generation, 500);
  }
  return true;
}

async function requestStudentUpload() {
  const studentId = state.currentStudentId;
  if (!studentId) return;
  const attemptGeneration = ++uploadAttemptGeneration;
  cancelUploadTracking();
  state.uploadRequest = newUploadRequestState();
  syncBtn.disabled = true;
  showSyncFeedback('正在创建同步请求…', false);
  try {
    const resp = await authFetch(
      '/api/mentor/students/' + encodeURIComponent(studentId) + '/request-upload',
      { method: 'POST' }
    );
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const snapshot = await resp.json();
    if (state.currentStudentId !== studentId ||
        attemptGeneration !== uploadAttemptGeneration) return;
    beginUploadTracking(snapshot);
  } catch (err) {
    if (state.currentStudentId !== studentId ||
        attemptGeneration !== uploadAttemptGeneration) return;
    console.error('请求同步全部对话失败', err);
    showSyncFeedback('同步请求失败，请重试。', true);
  } finally {
    updateSyncEnabled();
  }
}

async function retryUploadAnalysis() {
  const requestId = state.uploadRequest.requestId;
  const studentId = state.currentStudentId;
  if (!requestId || state.uploadRequest.analysisStatus !== 'failed') return;
  retryAnalysisBtn.disabled = true;
  try {
    const resp = await authFetch(
      '/api/mentor/upload-requests/' + encodeURIComponent(requestId) + '/retry-analysis',
      { method: 'POST' }
    );
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const snapshot = await resp.json();
    if (state.currentStudentId !== studentId || state.uploadRequest.requestId !== requestId) return;
    beginUploadTracking(snapshot);
  } catch (err) {
    if (state.currentStudentId !== studentId || state.uploadRequest.requestId !== requestId) return;
    console.error('仅重试诊断失败', err);
    showSyncFeedback('诊断重试请求失败，请稍后再试。', true);
    retryAnalysisBtn.disabled = false;
  }
}

if (syncBtn) syncBtn.addEventListener('click', requestStudentUpload);
if (retryAnalysisBtn) retryAnalysisBtn.addEventListener('click', retryUploadAnalysis);

// ─────────────────────────────────────────────────────────────
// 导师发消息 + 已送达
// ─────────────────────────────────────────────────────────────
function updateComposeEnabled() {
  const enabled = !!state.currentStudentId;
  composeInput.disabled = !enabled;
  composeSend.disabled = !enabled;
  composeInput.placeholder = enabled
    ? ('给 ' + currentStudentName() + ' 发一条提示…（不改 AI，仅提示学员）')
    : '选中学员后可发送提示…（不改 AI，仅提示学员）';
}

async function sendMentorMessage(text) {
  const studentId = state.currentStudentId;
  if (!studentId || !text.trim()) return;
  const localId = 'out-' + (++outboundSeq);

  // 乐观插入出站条（state 驱动），初始「发送中」
  const entry = {
    key: localId,
    localId: localId,
    type: 'mentor_message',
    content: text.trim(),
    created_at: Date.now() / 1000,
    mentor_name: '我',
    message_id: null,
    server_id: null,
    delivered: false,
    _optimistic: true,
  };
  state.timeline.push(entry);
  renderTimeline();

  try {
    const resp = await authFetch('/api/mentor/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: studentId, text: entry.content }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    entry.message_id = data.message_id || null;
    entry.server_id = data.id != null ? data.id : null;
    // 服务端只会在 StudentAgent 的 REST receipt 已持久化后返回 true；
    // 普通 WebSocket 写入成功仍保持“发送中”，等待 message_delivered 事件。
    if (data.delivered) entry.delivered = true;
    state.lastSeenMessageId = entry.message_id || state.lastSeenMessageId;
  } catch (err) {
    console.error('发送提示失败', err);
    entry._failed = true;
  }
  renderTimeline();
}

// WS message_delivered → 把对应出站条标记已送达（按 message_id / server_id 匹配）
function markDelivered(payload) {
  let changed = false;
  state.timeline.forEach((e) => {
    if (e.type !== 'mentor_message' || e.delivered) return;
    const byMsgId = payload.message_id && e.message_id === payload.message_id;
    const byServerId = payload.id != null && e.server_id === payload.id;
    if (byMsgId || byServerId) {
      e.delivered = true;
      e._failed = false;
      changed = true;
    }
  });
  if (changed) renderTimeline();
}

composeForm.addEventListener('submit', (evt) => {
  evt.preventDefault();
  const text = composeInput.value;
  if (!text.trim() || !state.currentStudentId) return;
  composeInput.value = '';
  sendMentorMessage(text);
});

// ─────────────────────────────────────────────────────────────
// WebSocket
// ─────────────────────────────────────────────────────────────
function connectMentorWS() {
  const url = mentorWsUrl();
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('WebSocket 创建失败', err);
    wsStatusEl.textContent = '连接失败';
    return;
  }

  ws.onopen = () => {
    wsStatusEl.textContent = '已连接';
    wsStatusEl.classList.add('connected');
    // 断线重连后重新拉取当前会话时间线，补齐断连期间缺口
    if (state.currentSessionId) {
      fetchTimeline(state.currentSessionId, { replace: true });
    }
  };

  ws.onmessage = (evt) => {
    let payload;
    try {
      payload = JSON.parse(evt.data);
    } catch (e) {
      return;
    }

    // 已送达回执：不限会话，按 id 匹配出站条
    if (payload.type === 'message_delivered') {
      markDelivered(payload);
      return;
    }

    if (payload.type === 'upload_request_status') {
      acceptUploadStatusEvent(payload);
      return;
    }

    // 正向事件：仅当前会话才插入
    if (state.currentSessionId && payload.session_id === state.currentSessionId) {
      const entry = wsPayloadToTimeline(payload);
      if (entry) {
        state.timeline.push(entry);
        renderTimeline();
      }
    }
  };

  ws.onclose = () => {
    wsStatusEl.textContent = '已断开';
    wsStatusEl.classList.remove('connected');
    setTimeout(connectMentorWS, 3000);
  };

  ws.onerror = () => {
    wsStatusEl.textContent = '连接错误';
  };
}

// ─────────────────────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  renderTimeline();      // 初始空态提示
  updateComposeEnabled();
  updateSyncEnabled();   // 初始未选中学员 → 同步按钮禁用
  loadStudents();
  connectMentorWS();
});
