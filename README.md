# JJ야 API

친구들과 약속(여행) 날짜를 정하는 앱의 백엔드. Node(Express) + SQLite. 모든 응답은 JSON입니다.

## 폴더
- `server.js` — 백엔드 API 서버
- `frontend/` — 정적 프론트엔드 (빌드 없음). 아무 정적 호스팅(Netlify, Vercel, GitHub Pages 등)에 그대로 올리면 됩니다.
  API 주소는 `frontend/config.js` 의 `API_URL` 에서 바꿉니다.

## 로컬 실행
    npm install
    CORS_ORIGIN=http://localhost:5173 npm start      # API: http://localhost:3000  (상태 확인: GET /health)
    npx serve frontend -l 5173                       # 다른 터미널에서. 브라우저로 http://localhost:5173

localhost 끼리는 포트가 달라도 같은 사이트라서 `COOKIE_SAMESITE` 설정 없이 로그인됩니다.

## 배포할 때 환경변수
| 이름 | 설명 |
|---|---|
| `NODE_ENV=production` | HTTPS 쿠키 사용 |
| `SESSION_SECRET` | 길고 임의의 문자열 (필수) |
| `CORS_ORIGIN` | 프론트엔드 주소, 쉼표로 여러 개 (예: `https://jjya.app,http://localhost:5173`). 여기 없는 출처에서 오는 POST/PUT/DELETE는 403 |
| `COOKIE_SAMESITE` | 기본 `lax`. 프론트와 API가 서로 다른 사이트(도메인)면 `none` (HTTPS 필수) |
| `DB_PATH` | SQLite 파일 위치. 재시작해도 남는 디스크(볼륨) 경로로 지정 (예: `/data/itdda.db`) |
| `VAPID_FILE` | 푸시 알림 키 파일 위치. 역시 볼륨 경로 (예: `/data/vapid.json`) |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` | 파일 대신 환경변수로 VAPID 키를 줄 때 |
| `VAPID_SUBJECT` | `mailto:내이메일` |
| `PORT` | 보통 호스팅이 자동 지정 |

프론트엔드는 로그인 쿠키를 쓰므로 `fetch(url, { credentials: 'include' })` 로 호출하세요.
푸시 알림의 `url` 값(`/#/e/<id>` 등)은 프론트엔드 라우트 기준입니다.
DB와 vapid 파일이 지워지면 계정과 알림 구독이 모두 사라지니 꼭 볼륨에 두세요.

## API
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/signup` · `/api/login` · `/api/logout` | `{ username, password }` |
| GET | `/api/me` | 로그인한 사용자 또는 `null` |
| GET/POST | `/api/schedules` | 내 일정 목록 / 추가 `{ title, weekday \| date, start?, end? }` |
| DELETE | `/api/schedules/:id` | 일정 삭제 |
| GET/POST | `/api/rooms` | 내 방 목록 / 방 만들기 `{ name }` |
| GET | `/api/rooms/:id` | 방 정보, 멤버, 약속 |
| POST | `/api/rooms/:id/join` · `/api/rooms/:id/leave` | 참여 / 나가기 |
| POST | `/api/rooms/:id/events` | 약속 만들기 `{ title, days }` |
| GET/POST | `/api/rooms/:id/messages` | 채팅 (`?after=<id>`) / 보내기 `{ text }` |
| GET | `/api/events/:id` | 약속 + 멤버 일정 + 투표 |
| PUT | `/api/events/:id/votes` | `{ picks: [{ date, rank: 1\|2 }] }` |
| POST | `/api/events/:id/finalize` | `{ date }` (`null` 이면 확정 취소) |
| DELETE | `/api/events/:id` | 약속 삭제 |
| GET | `/api/push/key` | VAPID 공개키 |
| POST | `/api/push/subscribe` · `/api/push/unsubscribe` | 푸시 구독 관리 |
