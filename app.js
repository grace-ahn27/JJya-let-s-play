const $app = document.getElementById('app');
const $user = document.getElementById('user');
let me = null;
let mode = 'login';
let tab = 'schedule';
const API_URL = window.API_URL || '';
const router = { get: () => location.hash.slice(1) || '/', set: p => { location.hash = p; } };
const nav = p => { router.set(p); route(); };

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => new Date(s).toLocaleString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = s => { const [y, m, d] = s.split('-').map(Number); return `${m}월 ${d}일 (${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`; };
const $ = id => document.getElementById(id);
let pollTimer = null;

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

// ---- 푸시 알림 ----
const pushOK = 'serviceWorker' in navigator && 'PushManager' in window;
let pushOn = false;
const b64 = k => Uint8Array.from(atob((k + '='.repeat((4 - k.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function pushStatus() {
  if (!pushOK) return pushOn;
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  return !!(reg && await reg.pushManager.getSubscription());
}

async function togglePush() {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('/push/unsubscribe', 'POST', { endpoint: sub.endpoint }); await sub.unsubscribe(); pushOn = false; toast('알림을 껐어요'); return; }
  if (await Notification.requestPermission() !== 'granted') throw new Error('브라우저 설정에서 알림을 허용해 주세요');
  const { key } = await api('/push/key');
  const made = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
  await api('/push/subscribe', 'POST', made.toJSON());
  pushOn = true; toast('알림을 켰어요');
}

async function api(path, method = 'GET', body) {
  // 백엔드가 다른 주소에 있으므로 로그인 쿠키를 함께 보냄
  const r = await fetch(API_URL + '/api' + path, {
    method, credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error('서버에 연결할 수 없어요'); });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || '오류가 발생했습니다'), { data, status: r.status });
  return data;
}

async function renderUser() {
  const draw = () => {
    $user.innerHTML = me
      ? `<span class="muted">${esc(me.username)}</span>
         ${pushOK ? `<button class="ghost sm" id="bell">${pushOn ? '알림 끄기' : '알림 켜기'}</button>` : ''}
         <button class="ghost sm" id="logout">로그아웃</button>`
      : '';
    if (!me) return;
    $('logout').onclick = async () => { await api('/logout', 'POST'); me = null; route(); };
    if ($('bell')) $('bell').onclick = async () => { try { await togglePush(); } catch (e) { toast(e.message); } draw(); };
  };
  draw();
  if (me && pushOK) { const on = await pushStatus(); if (on !== pushOn) { pushOn = on; draw(); } }
}

// ---- 로그인/가입 ----
function viewAuth() {
  const login = mode === 'login';
  $app.innerHTML = `
    <div class="card">
      <h2>${login ? '로그인' : '회원가입'}</h2>
      <input id="u" placeholder="아이디" autocomplete="username">
      <input id="p" type="password" placeholder="비밀번호" autocomplete="${login ? 'current-password' : 'new-password'}">
      <div class="err" id="err"></div>
      <button class="full" id="go">${login ? '로그인' : '가입하기'}</button>
      <p class="muted"><a class="tab" id="sw">${login ? '계정이 없나요? 가입하기' : '이미 계정이 있나요? 로그인'}</a></p>
    </div>`;
  const submit = async () => {
    try {
      me = await api(login ? '/login' : '/signup', 'POST', { username: $('u').value.trim(), password: $('p').value });
      route();
    } catch (e) { $('err').textContent = e.message; }
  };
  $('go').onclick = submit;
  $('p').onkeydown = e => { if (e.key === 'Enter') submit(); };
  $('sw').onclick = () => { mode = login ? 'signup' : 'login'; viewAuth(); };
}

// ---- 홈: 내 일정 / 방 ----
function viewHome() {
  $app.innerHTML = `
    <div class="tabs">
      <button class="${tab === 'schedule' ? 'on' : ''}" data-tab="schedule">내 일정</button>
      <button class="${tab === 'rooms' ? 'on' : ''}" data-tab="rooms">방 만들기</button>
    </div>
    <div id="pane"></div>`;
  $app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; viewHome(); });
  tab === 'schedule' ? paneSchedule() : paneRooms();
}

const today = new Date();
const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const wdOf = key => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return ymd(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); };
const fmtRange = (start, days) => days === 1 ? fmtDate(start) : `${fmtDate(start)} ~ ${fmtDate(addDays(start, days - 1))}`;
const cal = { y: today.getFullYear(), m: today.getMonth(), sel: ymd(today.getFullYear(), today.getMonth(), today.getDate()) };

async function paneSchedule() {
  const list = await api('/schedules');
  let kind = 'weekly';
  const picked = new Set();
  const wdOf = key => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
  const on = key => list.filter(s => s.weekday === wdOf(key) || (s.date && key >= s.date && key <= (s.end_date || s.date))).sort((a, b) => a.start.localeCompare(b.start));
  const todayKey = ymd(today.getFullYear(), today.getMonth(), today.getDate());

  // 달력 칸 (일요일 시작)
  const first = new Date(cal.y, cal.m, 1).getDay();
  const days = new Date(cal.y, cal.m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<div class="cell empty"></div>');
  for (let d = 1; d <= days; d++) {
    const key = ymd(cal.y, cal.m, d), ev = on(key), wd = (first + d - 1) % 7;
    cells.push(`<button class="cell ${key === cal.sel ? 'sel' : ''} ${key === todayKey ? 'today' : ''}" data-date="${key}" aria-label="${fmtDate(key)}">
      <span class="num ${wd === 0 ? 'sun' : wd === 6 ? 'sat' : ''}">${d}</span>
      ${ev.slice(0, 2).map(s => `<span class="bar ${s.event_id ? 'trip' : s.date ? 'once' : ''}">${esc(s.title)}</span>`).join('')}
      ${ev.length > 2 ? `<span class="more">+${ev.length - 2}</span>` : ''}</button>`);
  }
  const selEv = on(cal.sel);

  $('pane').innerHTML = `
    <div class="card">
      <div class="cal-head">
        <button class="ghost sm" id="prev" aria-label="이전 달">‹</button>
        <h2>${cal.y}년 ${cal.m + 1}월</h2>
        <button class="ghost sm" id="next" aria-label="다음 달">›</button>
      </div>
      <div class="grid dow">${DAYS.map((d, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${d}</span>`).join('')}</div>
      <div class="grid">${cells.join('')}</div>
    </div>
    <div class="card">
      <h2>${fmtDate(cal.sel)}</h2>
      ${selEv.length ? selEv.map(s => s.event_id
        ? `<div class="sch trip"><div><b>${esc(s.title)}</b>
            <small>확정된 약속 · ${esc(s.room_name)} · ${fmtDate(s.date)}${s.end_date !== s.date ? ' ~ ' + fmtDate(s.end_date) : ''}</small></div>
          <a class="chip" href="/e/${s.event_id}">보기</a></div>`
        : `<div class="sch"><div><b>${esc(s.title)}</b>
          <small>${s.start ? s.start + ' ~ ' + s.end : '시간 없음 (종일)'}${s.weekday !== null ? ' · 매주 ' + DAYS[s.weekday] + '요일' : ''}</small></div>
        <button class="ghost sm" data-del="${s.id}">삭제</button></div>`).join('') : '<p class="muted">이 날은 비어 있어요</p>'}
    </div>
    <div class="card">
      <h2>일정 추가</h2>
      <p class="muted">알바, 수업처럼 평소에 비어 있지 않은 시간을 적어 두면 방에서 약속을 잡을 때 겹치는지 알려줘요. 시간을 비워 두면 그날 종일로 봐요.</p>
      <input id="s-title" placeholder="무슨 일정인가요? (예: 카페 알바)">
      <div class="chips" id="s-kind">
        <button class="chip on" data-kind="weekly">매주 반복</button>
        <button class="chip" data-kind="once">하루만</button>
      </div>
      <div class="chips" id="s-days">${WEEK_ORDER.map(d => `<button class="chip day ${d === wdOf(cal.sel) ? 'on' : ''}" data-day="${d}">${DAYS[d]}</button>`).join('')}</div>
      <input id="s-date" type="date" value="${cal.sel}" hidden>
      <div class="row2">
        <label>시작 (선택)<input id="s-start" type="time"></label>
        <label>끝 (선택)<input id="s-end" type="time"></label>
      </div>
      <div class="err" id="err"></div>
      <button class="full" id="s-add">일정 넣기</button>
    </div>`;
  picked.add(wdOf(cal.sel));

  const shift = n => { const d = new Date(cal.y, cal.m + n, 1); cal.y = d.getFullYear(); cal.m = d.getMonth(); paneSchedule(); };
  $('prev').onclick = () => shift(-1);
  $('next').onclick = () => shift(1);
  $('pane').querySelectorAll('[data-date]').forEach(c => c.onclick = () => { cal.sel = c.dataset.date; paneSchedule(); });
  $('s-kind').onclick = e => {
    const b = e.target.closest('[data-kind]'); if (!b) return;
    kind = b.dataset.kind;
    $('s-kind').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
    $('s-days').hidden = kind !== 'weekly'; $('s-date').hidden = kind === 'weekly';
  };
  $('s-days').onclick = e => {
    const b = e.target.closest('[data-day]'); if (!b) return;
    const d = +b.dataset.day;
    picked.has(d) ? picked.delete(d) : picked.add(d);
    b.classList.toggle('on', picked.has(d));
  };
  $('s-add').onclick = async () => {
    const base = { title: $('s-title').value.trim(), start: $('s-start').value, end: $('s-end').value };
    try {
      if (kind === 'weekly') {
        if (!picked.size) throw new Error('요일을 하나 이상 골라주세요');
        for (const d of picked) await api('/schedules', 'POST', { ...base, weekday: d });
      } else {
        await api('/schedules', 'POST', { ...base, date: $('s-date').value });
      }
      paneSchedule();
    } catch (e) { $('err').textContent = e.message; }
  };
  $('pane').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/schedules/' + b.dataset.del, 'DELETE'); paneSchedule(); });
}

async function paneRooms() {
  const rooms = await api('/rooms');
  $('pane').innerHTML = `
    <div class="card">
      <h2>방 만들기</h2>
      <p class="muted">친구들과 약속을 잡을 방이에요. 만들고 나서 링크를 공유하세요.</p>
      <input id="r-name" placeholder="방 이름 (예: 동아리 친구들)">
      <div class="err" id="err"></div>
      <button class="full" id="r-add">방 만들기</button>
    </div>
    <div class="card list">
      <h2>내 방</h2>
      ${rooms.length ? rooms.map(r => `<a href="/r/${r.id}">${esc(r.name)} <span class="muted">· ${r.members}명</span></a>`).join('') : '<p class="muted">아직 참여한 방이 없어요</p>'}
    </div>`;
  $('r-add').onclick = async () => {
    try { const { id } = await api('/rooms', 'POST', { name: $('r-name').value }); nav('/r/' + id); }
    catch (e) { $('err').textContent = e.message; }
  };
}

// ---- 방 ----
function joinCard(e, reload) {
  $app.innerHTML = `<div class="card"><h2>${esc(e.data.roomName || '방')}</h2><p class="muted">초대받은 방이에요. 참여하면 약속을 보고 투표할 수 있어요.</p>
    <button class="full" id="join">방에 참여하기</button></div>`;
  $('join').onclick = async () => { await api(`/rooms/${e.data.roomId}/join`, 'POST'); reload(); };
}

async function viewRoom(id) {
  let r;
  try { r = await api('/rooms/' + id); }
  catch (e) {
    if (e.status === 403) return joinCard(e, () => viewRoom(id));
    $app.innerHTML = `<div class="card">${esc(e.message)}</div>`; return;
  }
  $app.innerHTML = `
    <div class="card">
      <h2>${esc(r.name)}</h2>
      <div class="chips">${r.members.map(m => `<span class="chip static">${esc(m.username)}</span>`).join('')}</div>
      <p class="muted">초대 링크</p>
      <div class="link">${location.origin}${location.pathname}#/r/${r.id}</div>
    </div>
    <div class="card">
      <h2>채팅</h2>
      <div class="chat" id="chat"><p class="muted" id="chat-empty">첫 메시지를 남겨 보세요</p></div>
      <div class="chat-in"><input id="msg" placeholder="메시지 입력" maxlength="1000" autocomplete="off"><button id="send">보내기</button></div>
    </div>
    <div class="card">
      <h2>약속 추가</h2>
      <p class="muted">이름과 며칠짜리인지만 정하면, 방 멤버의 일정이 합쳐진 달력에서 날짜를 투표해요.</p>
      <input id="title" placeholder="약속 이름 (예: 제주도 여행)">
      <label class="field">며칠간인가요?
        <span class="days-in"><input id="days" type="number" min="1" max="60" value="3" inputmode="numeric"> 일</span></label>
      <div class="err" id="err"></div>
      <button class="full" id="create">약속 만들기</button>
    </div>
    <div class="card list">
      <h2>약속 목록</h2>
      ${r.events.length ? r.events.map(e => `<a href="/e/${e.id}">${esc(e.title)}<span class="muted"> · ${e.days}일</span>${e.final_date ? ' <span class="badge ok">확정</span>' : ''}</a>`).join('') : '<p class="muted">아직 약속이 없어요</p>'}
    </div>
    <div class="card danger" id="leave-box"><button class="ghost" id="leave">방 나가기</button></div>
    <a class="tab" href="/">← 홈으로</a>`;
  startChat(id);
  $('leave').onclick = () => {
    const last = r.members.length === 1;
    $('leave-box').innerHTML = `<p>'${esc(r.name)}' 방에서 나갈까요?<br><span class="muted">${last ? '마지막 멤버라서 방이 사라져요.' : (r.owner_id === me.id ? '방장 권한은 다음 멤버에게 넘어가요. ' : '') + '내가 한 투표는 지워져요.'}</span></p>
      <div class="chips"><button class="chip danger-b" id="leave-yes">나가기</button><button class="chip" id="leave-no">취소</button></div>`;
    $('leave-no').onclick = () => viewRoom(id);
    $('leave-yes').onclick = async () => { await api(`/rooms/${id}/leave`, 'POST'); toast('방에서 나갔어요'); nav('/'); };
  };
  $('create').onclick = async () => {
    try {
      const { id: eid } = await api(`/rooms/${id}/events`, 'POST', { title: $('title').value.trim(), days: Number($('days').value) });
      nav('/e/' + eid);
    } catch (e) { $('err').textContent = e.message; }
  };
}

// 채팅: 3초마다 새 메시지를 가져와 아래에 붙인다 (입력 중인 글은 건드리지 않음)
function startChat(roomId) {
  let last = 0;
  const box = $('chat');
  const bubble = m => {
    $('chat-empty')?.remove();
    const mineMsg = m.user_id === me.id;
    const time = new Date(m.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.insertAdjacentHTML('beforeend', `<div class="msg ${mineMsg ? 'me' : ''}">
      ${mineMsg ? '' : `<span class="who">${esc(m.username)}</span>`}
      <div class="bub">${esc(m.text)}</div><span class="time">${time}</span></div>`);
    if (near || mineMsg) box.scrollTop = box.scrollHeight;
    last = Math.max(last, m.id);
  };
  const pull = async () => { try { (await api(`/rooms/${roomId}/messages?after=${last}`)).forEach(bubble); } catch {} };
  const send = async () => {
    const text = $('msg').value.trim(); if (!text) return;
    $('msg').value = '';
    try { bubble(await api(`/rooms/${roomId}/messages`, 'POST', { text })); } catch (e) { $('msg').value = text; toast(e.message); }
  };
  $('send').onclick = send;
  $('msg').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) send(); };
  pull().then(() => { box.scrollTop = box.scrollHeight; });
  pollTimer = setInterval(pull, 3000);
}

// ---- 약속 상세: 멤버 일정이 합쳐진 달력에서 1·2순위 투표, 방장이 확정 ----
const ev = { id: null, y: today.getFullYear(), m: today.getMonth(), sel: null };
const POINTS = { 1: 2, 2: 1 };

async function viewEvent(id) {
  let e;
  try { e = await api('/events/' + id); }
  catch (err) {
    if (err.status === 403) return joinCard(err, () => viewEvent(id));
    $app.innerHTML = `<div class="card">${esc(err.message)}</div>`; return;
  }
  if (ev.id !== id) Object.assign(ev, { id, y: today.getFullYear(), m: today.getMonth(), sel: null, draft: null });
  render(e, id);
}

function render(e, id) {
  const todayKey = ymd(today.getFullYear(), today.getMonth(), today.getDate());

  const busy = key => [...new Set(e.schedules.filter(s => s.weekday === wdOf(key) || s.date === key).map(s => s.username))];
  const freeAll = key => key >= todayKey && !busy(key).length;
  const validStart = key => { for (let i = 0; i < e.days; i++) if (!freeAll(addDays(key, i))) return false; return true; };
  const inFinal = key => e.final_date && key >= e.final_date && key <= addDays(e.final_date, e.days - 1);

  const mine = {};
  e.votes.filter(v => v.user_id === me.id).forEach(v => { mine[v.date] = v.rank; });
  if (!ev.draft) ev.draft = { ...mine };   // 저장 전까지는 여기에 모아 두었다가 한 번에 투표
  const draft = ev.draft;
  const dirty = JSON.stringify(Object.entries(draft).sort()) !== JSON.stringify(Object.entries(mine).sort());
  const picked = r => Object.keys(draft).filter(k => draft[k] === r).sort();
  const tally = {};
  e.votes.forEach(v => {
    const t = tally[v.date] ||= { date: v.date, score: 0, r1: [], r2: [] };
    t.score += POINTS[v.rank]; (v.rank === 1 ? t.r1 : t.r2).push(v.username);
  });
  const ranked = Object.values(tally).sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));

  const first = new Date(ev.y, ev.m, 1).getDay();
  const dim = new Date(ev.y, ev.m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<div class="cell empty"></div>');
  for (let d = 1; d <= dim; d++) {
    const key = ymd(ev.y, ev.m, d), b = busy(key), ok = validStart(key), wd = (first + d - 1) % 7;
    cells.push(`<button class="cell ${ok ? 'ok' : ''} ${inFinal(key) ? 'fin' : ''} ${key === ev.sel ? 'sel' : ''} ${key === todayKey ? 'today' : ''}" data-date="${key}" aria-label="${fmtDate(key)}">
      <span class="num ${wd === 0 ? 'sun' : wd === 6 ? 'sat' : ''}">${d}</span>
      ${b.length ? `<span class="bar" title="${esc(b.join(", "))}">${b.length}명</span>` : ''}
      ${draft[key] ? `<span class="rk rk${draft[key]}">${draft[key]}순위</span>` : ''}
      ${tally[key] ? `<span class="more">${tally[key].score}점</span>` : ''}</button>`);
  }

  const sel = ev.sel, selBusy = sel ? busy(sel) : [], selOk = sel ? validStart(sel) : false;
  const detail = !sel ? '<p class="muted">분홍색 칸은 모두 가능한 시작일이에요. 날짜를 여러 개 눌러 1순위, 2순위로 고른 뒤 한 번에 저장하세요.</p>' : `
    <h2>${fmtDate(sel)}</h2>
    <p class="muted">${selBusy.length ? '일정 있음: ' + esc(selBusy.join(', ')) : '이 날은 모두 가능해요'}</p>
    ${selOk ? `<p><b>${fmtRange(sel, e.days)}</b> (${e.days}일)</p>
      <div class="chips">
        <button class="chip ${draft[sel] === 1 ? 'on' : ''}" data-rank="1">1순위</button>
        <button class="chip ${draft[sel] === 2 ? 'on' : ''}" data-rank="2">2순위</button>
        ${draft[sel] ? '<button class="chip" data-rank="0">선택 해제</button>' : ''}
        ${e.isOwner ? `<button class="chip gold" data-final="${sel}">이 날로 확정</button>` : ''}
      </div>`
      : `<p class="muted">${sel < todayKey ? '지난 날이에요.' : `이 날부터 ${e.days}일 동안 모두가 비어 있지는 않아요.`}</p>`}`;

  $app.innerHTML = `
    <div class="card">
      <h2>${esc(e.title)}</h2>
      <p class="muted">${esc(e.room_name)} 방 · ${e.days}일 일정 · 방장 ${esc(e.owner)}</p>
      ${e.final_date ? `<div class="final-box">확정: <b>${fmtRange(e.final_date, e.days)}</b>
        ${e.isOwner ? '<button class="ghost sm" id="unfinal">확정 취소</button>' : ''}</div>` : ''}
      <div class="cal-head">
        <button class="ghost sm" id="prev" aria-label="이전 달">‹</button>
        <h3>${ev.y}년 ${ev.m + 1}월</h3>
        <button class="ghost sm" id="next" aria-label="다음 달">›</button>
      </div>
      <div class="grid dow">${DAYS.map((d, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${d}</span>`).join('')}</div>
      <div class="grid">${cells.join('')}</div>
      <p class="muted legend"><i class="sw ok"></i>모두 가능한 시작일 <i class="sw busy"></i>회색 숫자는 일정 있는 사람 수 · 멤버 ${e.members.length}명 일정 합산</p>
    </div>
    <div class="card">${detail}</div>
    <div class="votebar">
      <span>1순위 <b>${picked(1).length}</b> · 2순위 <b>${picked(2).length}</b></span>
      <button class="ghost sm" id="reset" ${dirty ? '' : 'disabled'}>되돌리기</button>
      <button class="sm" id="save" ${dirty ? '' : 'disabled'}>${dirty ? '투표 저장' : '저장됨'}</button>
    </div>
    <div class="card">
      <h2>투표 현황</h2>
      <p class="muted">1순위 2점, 2순위 1점으로 합산해요.</p>
      ${ranked.length ? ranked.slice(0, 5).map((t, i) => `<div class="slot ${t.date === e.final_date ? 'final' : ''}">
        <div><b>${i + 1}위 · ${fmtRange(t.date, e.days)}</b>
          <small>${t.r1.length ? '1순위 ' + esc(t.r1.join(', ')) : ''}${t.r1.length && t.r2.length ? ' / ' : ''}${t.r2.length ? '2순위 ' + esc(t.r2.join(', ')) : ''}</small></div>
        <div><span class="badge">${t.score}점</span>${e.isOwner && t.date !== e.final_date ? `<button class="ghost sm" data-final="${t.date}">확정</button>` : ''}</div>
      </div>`).join('') : '<p class="muted">아직 투표가 없어요. 달력에서 가능한 날을 골라 1·2순위를 정해 주세요.</p>'}
    </div>
    <div class="card"><h2>공유 링크</h2><div class="link">${location.origin}${location.pathname}#/e/${e.id}</div></div>
    ${e.canDelete ? '<div class="card danger" id="del-box"><button class="ghost" id="del">약속 삭제</button></div>' : ''}
    <a class="tab" href="/r/${e.room_id}">← ${esc(e.room_name)} 방으로</a>`;

  const redraw = () => viewEvent(id);     // 서버 상태가 바뀐 뒤
  const local = () => render(e, id);      // 투표 초안만 바뀔 때는 다시 불러오지 않음
  const shift = n => { const d = new Date(ev.y, ev.m + n, 1); ev.y = d.getFullYear(); ev.m = d.getMonth(); local(); };
  $('prev').onclick = () => shift(-1);
  $('next').onclick = () => shift(1);
  $app.querySelectorAll('[data-date]').forEach(c => c.onclick = () => {
    const key = c.dataset.date;
    ev.sel = key;
    if (validStart(key)) { const r = draft[key]; r === 1 ? draft[key] = 2 : r === 2 ? delete draft[key] : draft[key] = 1; }
    local();
  });
  $app.querySelectorAll('[data-rank]').forEach(b => b.onclick = () => {
    const rank = +b.dataset.rank;
    rank ? draft[sel] = rank : delete draft[sel];
    local();
  });
  $('reset').onclick = () => { ev.draft = null; local(); };
  $('save').onclick = async () => {
    try {
      await api(`/events/${id}/votes`, 'PUT', { picks: Object.entries(draft).map(([date, r]) => ({ date, rank: r })) });
      ev.draft = null; toast('투표를 저장했어요'); redraw();
    } catch (err) { toast(err.message); }
  };
  $app.querySelectorAll('[data-final]').forEach(b => b.onclick = async () => { await api(`/events/${id}/finalize`, 'POST', { date: b.dataset.final }); redraw(); });
  if ($('del')) $('del').onclick = () => {
    $('del-box').innerHTML = `<p>'${esc(e.title)}' 약속과 투표 기록이 모두 사라져요. 삭제할까요?</p>
      <div class="chips"><button class="chip danger-b" id="del-yes">삭제</button><button class="chip" id="del-no">취소</button></div>`;
    $('del-no').onclick = redraw;
    $('del-yes').onclick = async () => { await api('/events/' + id, 'DELETE'); ev.id = null; toast('약속을 삭제했어요'); nav('/r/' + e.room_id); };
  };
  if ($('unfinal')) $('unfinal').onclick = async () => { await api(`/events/${id}/finalize`, 'POST', { date: null }); redraw(); };
}

async function route() {
  clearInterval(pollTimer);
  if (me === null) me = await api('/me');
  renderUser();
  if (!me) return viewAuth();
  const path = router.get();
  let m;
  if ((m = path.match(/^\/r\/(\w+)/))) return viewRoom(m[1]);
  if ((m = path.match(/^\/e\/(\w+)/))) return viewEvent(m[1]);
  viewHome();
}

document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="/"]');
  if (a) { e.preventDefault(); nav(a.getAttribute('href')); }
});
window.onhashchange = route;
route();
