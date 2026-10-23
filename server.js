const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const webpush = require('web-push');

const db = new Database(process.env.DB_PATH || 'itdda.db');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, weekday INTEGER, date TEXT, start TEXT NOT NULL, end TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, user_id));
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id),
  days INTEGER NOT NULL DEFAULT 1, final_date TEXT);
CREATE TABLE IF NOT EXISTS event_votes (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, rank INTEGER NOT NULL CHECK (rank IN (1, 2)),
  PRIMARY KEY (event_id, user_id, date));
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL);
`);

const app = express();
app.set('trust proxy', 1); // 호스팅 서비스의 HTTPS 프록시 뒤에서 쿠키가 동작하도록
const prod = process.env.NODE_ENV === 'production';
if (prod && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET 환경변수가 필요합니다'); process.exit(1);   // 기본값으로는 로그인 쿠키를 위조할 수 있어서 막음
}

// ---- CORS: 프론트엔드가 다른 주소에서 쿠키를 실어 API를 부를 수 있게 ----
const origins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && origins.includes(origin)) {
    res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' });
    if (req.method === 'OPTIONS') {
      res.set({ 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.sendStatus(204);
    }
  } else if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
    // 허용 안 된 사이트에서 로그인 쿠키를 이용해 요청을 보내는 것(CSRF) 차단
    return res.status(403).json({ error: '허용되지 않은 출처입니다' });
  }
  next();
});

app.use(express.json());
// 프론트가 다른 사이트(도메인)에 있으면 COOKIE_SAMESITE=none 필요 (HTTPS 필수)
const sameSite = process.env.COOKIE_SAMESITE || 'lax';
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite, secure: prod || sameSite === 'none', maxAge: 1000 * 60 * 60 * 24 * 14 },
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

const auth = (req, res, next) =>
  req.session.uid ? next() : res.status(401).json({ error: '로그인이 필요합니다' });

// ---- 푸시 알림 (Web Push, VAPID 키는 첫 실행 때 vapid.json 에 만들어짐) ----
let vapid = process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE
  ? { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE } : null;
if (!vapid) {
  try { vapid = JSON.parse(fs.readFileSync(process.env.VAPID_FILE || 'vapid.json', 'utf8')); }
  catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(process.env.VAPID_FILE || 'vapid.json', JSON.stringify(vapid)); }
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

function notify(userIds, payload) {
  if (!userIds.length) return;
  const subs = db.prepare(`SELECT * FROM push_subs WHERE user_id IN (${userIds.map(() => '?').join(',')})`).all(...userIds);
  subs.forEach(s => webpush
    .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload))
    .catch(err => { if ([404, 410].includes(err.statusCode)) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(s.endpoint); }));
}
const othersIn = (roomId, uid) =>
  db.prepare('SELECT user_id FROM room_members WHERE room_id = ? AND user_id != ?').all(roomId, uid).map(r => r.user_id);
const nameOf = uid => db.prepare('SELECT username FROM users WHERE id = ?').get(uid).username;

// ---- 인증 ----
app.post('/api/signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || username.length < 2 || !password || password.length < 4)
    return res.status(400).json({ error: '아이디 2자 이상, 비밀번호 4자 이상' });
  try {
    const r = db.prepare('INSERT INTO users (username, hash) VALUES (?, ?)')
      .run(username, bcrypt.hashSync(password, 10));
    req.session.uid = r.lastInsertRowid;
    res.json({ id: r.lastInsertRowid, username });
  } catch {
    res.status(409).json({ error: '이미 사용 중인 아이디입니다' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!u || !bcrypt.compareSync(password || '', u.hash))
    return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다' });
  req.session.uid = u.id;
  res.json({ id: u.id, username: u.username });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', (req, res) => {
  const u = req.session.uid &&
    db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.uid);
  res.json(u || null);
});

// ---- 내 일정 (매주 반복 또는 하루짜리) ----
const TIME = /^\d\d:\d\d$/;
// 'YYYY-MM-DD' 에서 n일 뒤 / 시작일부터 days일치 날짜 목록
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const expand = (date, days) => Array.from({ length: days }, (_, i) => addDays(date, i));

// 내 일정 = 직접 넣은 일정 + 내가 속한 방에서 확정된 약속 (확정/취소/삭제에 따라 저절로 따라감)
app.get('/api/schedules', auth, (req, res) => {
  const own = db.prepare('SELECT * FROM schedules WHERE user_id = ? ORDER BY start').all(req.session.uid);
  const trips = db.prepare(`SELECT e.id, e.title, e.final_date, e.days, r.name AS room_name FROM events e
    JOIN room_members m ON m.room_id = e.room_id AND m.user_id = ?
    JOIN rooms r ON r.id = e.room_id WHERE e.final_date IS NOT NULL`).all(req.session.uid)
    .map(t => ({ id: 'e:' + t.id, title: t.title, weekday: null, date: t.final_date,
      end_date: addDays(t.final_date, t.days - 1), start: '', end: '', event_id: t.id, room_name: t.room_name }));
  res.json([...own, ...trips]);
});

app.post('/api/schedules', auth, (req, res) => {
  const { title, weekday, date, start, end } = req.body;
  const wd = Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : null;
  // 시간은 선택사항: 비워 두면 종일 일정 (start/end = '')
  const timed = !!(start || end);
  if (!title || (timed && (!TIME.test(start) || !TIME.test(end) || end <= start)) || (wd === null && !date))
    return res.status(400).json({ error: '제목과 요일(또는 날짜)을 확인하세요. 시간은 시작과 끝을 함께 넣어야 해요' });
  const r = db.prepare('INSERT INTO schedules (user_id, title, weekday, date, start, end) VALUES (?,?,?,?,?,?)')
    .run(req.session.uid, title, wd, wd === null ? date : null, start || '', end || '');
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/schedules/:id', auth, (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id = ? AND user_id = ?').run(req.params.id, req.session.uid);
  res.json({ ok: true });
});

// ---- 방 ----
const isMember = (roomId, uid) =>
  !!db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, uid);

app.post('/api/rooms', auth, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '방 이름을 입력하세요' });
  const id = crypto.randomBytes(4).toString('hex');
  db.transaction(() => {
    db.prepare('INSERT INTO rooms (id, name, owner_id) VALUES (?,?,?)').run(id, name, req.session.uid);
    db.prepare('INSERT INTO room_members (room_id, user_id) VALUES (?,?)').run(id, req.session.uid);
  })();
  res.json({ id });
});

app.get('/api/rooms', auth, (req, res) => {
  res.json(db.prepare(`SELECT r.id, r.name,
      (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) AS members
    FROM rooms r JOIN room_members m ON m.room_id = r.id AND m.user_id = ?
    ORDER BY r.rowid DESC`).all(req.session.uid));
});

// 링크를 받은 사람은 로그인 후 참여
app.post('/api/rooms/:id/join', auth, (req, res) => {
  if (!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(req.params.id))
    return res.status(404).json({ error: '없는 방입니다' });
  db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?,?)').run(req.params.id, req.session.uid);
  res.json({ ok: true });
});

// 방 나가기: 내 투표 삭제, 방장이면 다음 멤버에게 넘김, 마지막 멤버면 방 삭제
app.post('/api/rooms/:id/leave', auth, (req, res) => {
  const room = db.prepare('SELECT owner_id FROM rooms WHERE id = ?').get(req.params.id);
  if (!room || !isMember(req.params.id, req.session.uid)) return res.status(404).json({ error: '참여 중인 방이 아닙니다' });
  const uid = req.session.uid, id = req.params.id;
  db.transaction(() => {
    db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(id, uid);
    db.prepare('DELETE FROM event_votes WHERE user_id = ? AND event_id IN (SELECT id FROM events WHERE room_id = ?)').run(uid, id);
    const next = db.prepare('SELECT user_id FROM room_members WHERE room_id = ? ORDER BY rowid LIMIT 1').get(id);
    if (!next) return db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
    const owner = room.owner_id === uid ? next.user_id : room.owner_id;
    db.prepare('UPDATE rooms SET owner_id = ? WHERE id = ?').run(owner, id);
    db.prepare('UPDATE events SET owner_id = ? WHERE room_id = ? AND owner_id = ?').run(owner, id, uid);
  })();
  res.json({ ok: true });
});

app.get('/api/rooms/:id', auth, (req, res) => {
  const r = db.prepare('SELECT id, name, owner_id FROM rooms WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '없는 방입니다' });
  if (!isMember(r.id, req.session.uid)) return res.status(403).json({ error: '아직 참여하지 않은 방입니다', roomId: r.id, roomName: r.name });
  const members = db.prepare(`SELECT u.id, u.username FROM room_members m
    JOIN users u ON u.id = m.user_id WHERE m.room_id = ?`).all(r.id);
  const events = db.prepare('SELECT id, title, days, final_date FROM events WHERE room_id = ? ORDER BY rowid DESC').all(r.id);
  res.json({ ...r, members, events });
});

// ---- 약속 (방 안에서 만든다): 며칠짜리인지만 정하고, 날짜는 멤버 일정을 보며 투표 ----
const DATE = /^\d{4}-\d\d-\d\d$/;

app.post('/api/rooms/:id/events', auth, (req, res) => {
  if (!isMember(req.params.id, req.session.uid)) return res.status(403).json({ error: '방 참여자만 약속을 만들 수 있어요' });
  const title = (req.body.title || '').trim();
  const days = Number(req.body.days);
  if (!title || !Number.isInteger(days) || days < 1 || days > 60)
    return res.status(400).json({ error: '약속 이름과 일수(1~60일)를 입력하세요' });
  const id = crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO events (id, room_id, title, owner_id, days) VALUES (?,?,?,?,?)')
    .run(id, req.params.id, title, req.session.uid, days);
  notify(othersIn(req.params.id, req.session.uid), {
    title: '새 약속이 생겼어요', body: `${nameOf(req.session.uid)}님이 '${title}' 약속을 만들었어요`, url: '/#/e/' + id });
  res.json({ id });
});

// 방 멤버 전원의 일정을 합친 캘린더 데이터 (일정 내용은 빼고 누가 바쁜지만 내려줌)
app.get('/api/events/:id', auth, (req, res) => {
  const e = db.prepare(`SELECT e.id, e.title, e.days, e.room_id, e.owner_id, e.final_date, u.username AS owner, r.name AS room_name, r.owner_id AS room_owner_id
    FROM events e JOIN users u ON u.id = e.owner_id JOIN rooms r ON r.id = e.room_id WHERE e.id = ?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: '없는 약속입니다' });
  if (!isMember(e.room_id, req.session.uid)) return res.status(403).json({ error: '아직 참여하지 않은 방입니다', roomId: e.room_id, roomName: e.room_name });
  const members = db.prepare(`SELECT u.id, u.username FROM room_members m
    JOIN users u ON u.id = m.user_id WHERE m.room_id = ?`).all(e.room_id);
  const schedules = db.prepare(`SELECT u.username, s.weekday, s.date FROM schedules s
    JOIN room_members m ON m.user_id = s.user_id AND m.room_id = ?
    JOIN users u ON u.id = s.user_id`).all(e.room_id);
  const votes = db.prepare(`SELECT v.user_id, u.username, v.date, v.rank FROM event_votes v
    JOIN users u ON u.id = v.user_id WHERE v.event_id = ?`).all(e.id);
  // 다른 약속에서 이미 확정된 날도 해당 멤버가 바쁜 날로 합산 (이 약속 자신은 제외)
  db.prepare(`SELECT e2.final_date, e2.days, u.username FROM events e2
    JOIN room_members m2 ON m2.room_id = e2.room_id
    JOIN room_members m ON m.user_id = m2.user_id AND m.room_id = ?
    JOIN users u ON u.id = m2.user_id
    WHERE e2.final_date IS NOT NULL AND e2.id != ?`).all(e.room_id, e.id)
    .forEach(t => expand(t.final_date, t.days).forEach(date => schedules.push({ username: t.username, weekday: null, date })));
  res.json({ ...e, members, schedules, votes, isOwner: e.owner_id === req.session.uid,
    canDelete: e.owner_id === req.session.uid || e.room_owner_id === req.session.uid });
});

// 내 투표를 통째로 교체: picks = [{ date: 'YYYY-MM-DD', rank: 1 | 2 }]
app.put('/api/events/:id/votes', auth, (req, res) => {
  const e = db.prepare('SELECT room_id FROM events WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: '없는 약속입니다' });
  if (!isMember(e.room_id, req.session.uid)) return res.status(403).json({ error: '방 참여자만 투표할 수 있어요' });
  const picks = Array.isArray(req.body.picks) ? req.body.picks : [];
  if (picks.some(p => !DATE.test(p.date) || ![1, 2].includes(p.rank)))
    return res.status(400).json({ error: '투표 형식이 올바르지 않아요' });
  db.transaction(() => {
    db.prepare('DELETE FROM event_votes WHERE event_id = ? AND user_id = ?').run(req.params.id, req.session.uid);
    const ins = db.prepare('INSERT OR REPLACE INTO event_votes (event_id, user_id, date, rank) VALUES (?,?,?,?)');
    picks.forEach(p => ins.run(req.params.id, req.session.uid, p.date, p.rank));
  })();
  res.json({ ok: true });
});

app.post('/api/events/:id/finalize', auth, (req, res) => {
  const date = req.body.date ?? null;
  if (date !== null && !DATE.test(date)) return res.status(400).json({ error: '날짜 형식이 올바르지 않아요' });
  const r = db.prepare('UPDATE events SET final_date = ? WHERE id = ? AND owner_id = ?')
    .run(date, req.params.id, req.session.uid);
  if (!r.changes) return res.status(403).json({ error: '방장만 확정할 수 있어요' });
  if (date) {
    const e = db.prepare('SELECT room_id, title, days FROM events WHERE id = ?').get(req.params.id);
    notify(othersIn(e.room_id, req.session.uid), {
      title: '약속 날짜가 확정됐어요', body: `'${e.title}' ${date}부터 ${e.days}일`, url: '/#/e/' + req.params.id });
  }
  res.json({ ok: true });
});

// 약속 삭제: 약속을 만든 사람 또는 방장
app.delete('/api/events/:id', auth, (req, res) => {
  const e = db.prepare(`SELECT e.owner_id, r.owner_id AS room_owner_id FROM events e
    JOIN rooms r ON r.id = e.room_id WHERE e.id = ?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: '없는 약속입니다' });
  if (![e.owner_id, e.room_owner_id].includes(req.session.uid))
    return res.status(403).json({ error: '약속을 만든 사람이나 방장만 삭제할 수 있어요' });
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- 방 채팅 (클라이언트가 몇 초마다 after 이후 메시지를 가져감) ----
app.get('/api/rooms/:id/messages', auth, (req, res) => {
  if (!isMember(req.params.id, req.session.uid)) return res.status(403).json({ error: '방 참여자만 볼 수 있어요' });
  const after = Number(req.query.after) || 0;
  const rows = db.prepare(`SELECT * FROM (
      SELECT m.id, m.user_id, u.username, m.text, m.created_at FROM messages m
      JOIN users u ON u.id = m.user_id WHERE m.room_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT 100)
    ORDER BY id`).all(req.params.id, after);
  res.json(rows);
});

app.post('/api/rooms/:id/messages', auth, (req, res) => {
  if (!isMember(req.params.id, req.session.uid)) return res.status(403).json({ error: '방 참여자만 보낼 수 있어요' });
  const text = String(req.body.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: '메시지를 입력하세요' });
  const created_at = new Date().toISOString();
  const r = db.prepare('INSERT INTO messages (room_id, user_id, text, created_at) VALUES (?,?,?,?)')
    .run(req.params.id, req.session.uid, text, created_at);
  const me = nameOf(req.session.uid);
  const room = db.prepare('SELECT name FROM rooms WHERE id = ?').get(req.params.id);
  notify(othersIn(req.params.id, req.session.uid), {
    title: room.name, body: `${me}: ${text.slice(0, 80)}`, url: '/#/r/' + req.params.id, tag: 'chat-' + req.params.id });
  res.json({ id: r.lastInsertRowid, user_id: req.session.uid, username: me, text, created_at });
});

// ---- 푸시 구독 ----
app.get('/api/push/key', auth, (_req, res) => res.json({ key: vapid.publicKey }));

app.post('/api/push/subscribe', auth, (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: '구독 정보가 올바르지 않아요' });
  db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth) VALUES (?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(endpoint, req.session.uid, keys.p256dh, keys.auth);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', auth, (req, res) => {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(req.body.endpoint, req.session.uid);
  res.json({ ok: true });
});

app.use((_req, res) => res.status(404).json({ error: '없는 API입니다' }));
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '요청 형식이 올바르지 않아요' });
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했어요' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`JJ야 API http://localhost:${port}`));
