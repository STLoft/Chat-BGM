// Chat BGM — 채팅 장면을 읽고 어울리는 곡을 골라 YouTube 공식 음원으로 틀어 주는 확장
//
// 흐름
//   1. 최근 메시지를 모델에게 보내 분위기와 후보 곡(가수·제목·장르)을 JSON으로 받는다.
//      후보는 설정에서 체크한 장르 안에서만 받고, 장르가 어긋난 답은 버린다.
//   2. 후보를 차례로 YouTube Data API에서 찾아 공식 음원(Topic 채널, "Provided to YouTube by",
//      Official Audio, 공식 채널)을 고른다. 검색은 한 번에 할당량 100을 쓰므로
//      재생할 차례가 된 곡만 찾고, 찾은 결과는 설정에 캐시한다.
//   3. YouTube IFrame 플레이어로 재생한다. 곡이 끝나면 다음 후보로, 후보가 떨어지면 다시 추천받는다.
//
// 화면
//   · 빠른 답장 줄의 음표 아이콘: 누르면 재생·일시정지, 꾹 누르면 플레이어(영상·추천곡·재생 기록)
//   · 메시지 단추의 음표: 그 메시지까지의 대화로 추천
//   · 곡 카드(선택): 답장을 쓰는 모델이 답장 끝에 <bgm> 태그로 곡을 적으면 메시지 아래에 카드로 그린다.

const MODULE = 'chat_bgm';
const LOG = '[Chat BGM]';
const ctx = () => SillyTavern.getContext();

const GENRES = [
    { id: 'kpop', label: 'K-POP', hint: 'K-pop (Korean idol / dance pop)' },
    { id: 'ballad', label: '발라드', hint: 'Korean ballad' },
    { id: 'kindie', label: '인디', hint: 'Korean indie / band music' },
    { id: 'rnb', label: 'R&B·소울', hint: 'R&B / soul' },
    { id: 'hiphop', label: '힙합', hint: 'hip-hop / rap' },
    { id: 'pop', label: '팝', hint: 'Western pop' },
    { id: 'rock', label: '록·밴드', hint: 'rock / alternative' },
    { id: 'jpop', label: 'J-POP', hint: 'J-pop' },
    { id: 'citypop', label: '시티팝', hint: 'city pop' },
    { id: 'jazz', label: '재즈', hint: 'jazz' },
    { id: 'classical', label: '클래식', hint: 'classical music' },
    { id: 'lofi', label: '로파이·칠', hint: 'lo-fi / chill beats' },
    { id: 'electronic', label: '일렉트로닉', hint: 'electronic / synth / house' },
    { id: 'acoustic', label: '어쿠스틱·포크', hint: 'acoustic / folk / singer-songwriter' },
    { id: 'ost', label: '영화·드라마 OST', hint: 'film / TV drama soundtrack' },
    { id: 'gameost', label: '게임·애니 OST', hint: 'video game / anime soundtrack' },
    { id: 'ambient', label: '앰비언트·뉴에이지', hint: 'ambient / new age / solo piano' },
];

const DEFAULTS = Object.freeze({
    enabled: true,
    apiKey: '',
    profileId: '',
    customGenres: '',
    instrumentalOnly: false,
    officialOnly: true,
    auto: true,
    autoEvery: 6,
    switchNow: false,
    repeat: 'off',
    contextMessages: 12,
    candidates: 4,
    volume: 60,
    card: false,
    cardAutoPlay: false,
    cardOnPick: true,
    cardStyle: 'pill',
    cardRemove: false,
});

const DEFAULT_GENRES = ['ballad', 'kindie', 'pop', 'ost'];
const CACHE_MAX = 300;
const MISS_TTL = 3 * 24 * 60 * 60 * 1000;
const PLAYED_MAX = 100;
const REPEAT_MODES = ['off', 'one', 'star'];
const CARD_STYLES = { pill: '알약', player: '미니 플레이어', line: '한 줄 글자', vinyl: 'LP판', bar: '진행 막대' };
const REPEAT_LABELS = { off: '반복 끔 (곡이 끝나면 다음 추천곡)', one: '한 곡 반복', star: '★ 곡들 반복' };
// 생각(추론)하는 모델은 생각에 쓴 토큰도 이 한도에 들어가므로 넉넉하게 둔다.
const RESPONSE_TOKENS = 4000;

const st = {
    queue: [],
    current: null,
    mood: '',
    status: '',
    statusError: false,
    busy: false,
    counter: 0,
    player: null,
    playerReady: null,
    ytPromise: null,
    playerState: -1,
    errStreak: 0,
    hintTimer: 0,
    needTap: false,
    panelOpen: false,
    tab: 'queue',
    icon: null,
    iconQueued: false,
    cardTimer: 0,
};

// ── 설정 ────────────────────────────────────────────────────────────────

function S() {
    const all = ctx().extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = {};
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined || typeof s[k] !== typeof v) s[k] = v;
    }
    if (!Array.isArray(s.genres)) s.genres = [...DEFAULT_GENRES];
    // played: [{ artist, title, genre, reason, kind, t }] 오래된 것부터. 예전 판은 history에 "가수 - 제목" 글자만 두었다.
    if (!Array.isArray(s.played)) {
        s.played = (Array.isArray(s.history) ? s.history : []).map((name) => {
            const [artist, ...rest] = String(name).split(' - ');
            return { artist, title: rest.join(' - '), genre: '', reason: '', kind: '', t: 0 };
        }).filter((p) => p.artist && p.title);
    }
    delete s.history;
    // repeat: off(다음 추천곡으로) · one(한 곡 반복) · star(별표 단 곡들 반복). 예전 판은 autoNext 참·거짓만 있었다.
    if (s.autoNext === false && s.repeat === 'off') s.repeat = 'one';
    delete s.autoNext;
    if (!REPEAT_MODES.includes(s.repeat)) s.repeat = 'off';
    if (!CARD_STYLES[s.cardStyle]) s.cardStyle = 'pill';
    if (!s.cache || typeof s.cache !== 'object') s.cache = {};
    if (s.pos && (typeof s.pos.x !== 'number' || typeof s.pos.y !== 'number')) s.pos = null;
    return s;
}

const save = () => ctx().saveSettingsDebounced();

// ── 작은 도구 ────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const $id = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const trackName = (t) => `${t.artist} - ${t.title}`;
const recentNames = (count) => S().played.slice(-count).map(trackName);
const nk = (v) => String(v ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function decodeEntities(text) {
    const box = document.createElement('textarea');
    box.innerHTML = String(text ?? '');
    return box.value;
}

function toast(kind, message) {
    if (window.toastr?.[kind]) window.toastr[kind](message, 'Chat BGM');
    else console.log(LOG, message);
}

// ── 장르 ────────────────────────────────────────────────────────────────

// 체크한 기본 장르 + 직접 적은 장르. 모델에게는 id와 설명을 주고, 답의 genre가 이 id 중 하나인지 확인한다.
function allowedGenres() {
    const s = S();
    const list = GENRES.filter((g) => s.genres.includes(g.id));
    s.customGenres.split(/[,\n]/).map((v) => v.trim()).filter(Boolean).slice(0, 12).forEach((name, i) => {
        list.push({ id: `custom${i + 1}`, label: name, hint: name });
    });
    return list;
}

function matchGenre(value, allowed) {
    const key = nk(value);
    if (!key) return null;
    return allowed.find((g) => nk(g.id) === key || nk(g.label) === key || nk(g.hint) === key) || null;
}

// ── 장면 읽기 ────────────────────────────────────────────────────────────

function cleanText(text) {
    return String(text ?? '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// upTo를 주면 그 메시지까지만 읽는다(메시지 단추로 추천받을 때).
// 평소에는 숨긴 메시지를 건너뛰지만, 메시지를 직접 고른 경우에는 숨긴 메시지도 읽는다.
function collectScene(upTo = null) {
    const s = S();
    const lines = [];
    let total = 0;
    const chat = ctx().chat || [];
    const last = Number.isInteger(upTo) ? clamp(upTo, 0, chat.length - 1) : chat.length - 1;
    for (let i = last; i >= 0 && lines.length < s.contextMessages && total < 12000; i--) {
        const m = chat[i];
        if (!m || (m.is_system && upTo === null)) continue;
        const text = cleanText(m.mes).slice(0, 1500);
        if (!text) continue;
        lines.unshift(`${m.name || (m.is_user ? 'User' : 'Character')}: ${text}`);
        total += text.length;
    }
    return lines.join('\n\n');
}

function buildPrompt(scene, allowed) {
    const s = S();
    const count = clamp(s.candidates, 1, 8);
    const genreLines = allowed.map((g) => `- ${g.id}: ${g.hint}`).join('\n');
    const recent = recentNames(15);
    const system = [
        'You are a music supervisor choosing background music for an ongoing story scene.',
        'Read the latest part of the scene and work out its mood, pace and setting. The most recent messages matter most.',
        `Recommend ${count} real, commercially released songs that fit the scene and can be found on YouTube as official audio.`,
        '',
        'Rules:',
        '- Choose ONLY from the allowed genres below. Never recommend a song from any other genre, even if it would fit better.',
        '- Only recommend songs you are certain exist. Never invent an artist or a title.',
        '- Write the artist and title exactly as on the official release, in the original script (for example 아이유 / 밤편지, not a translation).',
        '- Spread the picks over different artists.',
        s.instrumentalOnly ? '- Instrumental tracks only: no vocals, no lyrics.' : '',
        recent.length ? `- Do not recommend any of these, they were played recently: ${recent.join('; ')}` : '',
        '',
        'Allowed genres (id: description):',
        genreLines,
        '',
        'Answer with one JSON object and nothing else:',
        '{"mood":"<the scene mood in Korean, under 30 characters>","tracks":[{"artist":"...","title":"...","genre":"<one allowed genre id>","reason":"<one short Korean sentence on why it fits>"}]}',
    ].filter((line) => line !== '').join('\n');
    const user = `<scene>\n${scene}\n</scene>\n\nRecommend the background music for this scene as JSON.`;
    return { system, user };
}

async function askModel(system, user) {
    const s = S();
    const c = ctx();
    if (s.profileId) {
        const service = c.ConnectionManagerRequestService;
        if (!service) throw new Error('연결 프로필 기능을 쓸 수 없습니다. 분석 연결을 "현재 연결"로 바꿔 주세요.');
        const result = await service.sendRequest(
            s.profileId,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            RESPONSE_TOKENS,
        );
        return String((typeof result === 'string' ? result : result?.content) ?? '');
    }
    return String(await c.generateRaw({ prompt: user, systemPrompt: system, responseLength: RESPONSE_TOKENS }) ?? '');
}

// 답 전체가 JSON으로 읽히지 않으면(중간에 끊겼거나 앞뒤에 말이 붙은 경우) 곡 하나하나를 따로 건진다.
function readJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const data = JSON.parse(text.slice(start, end + 1));
            if (Array.isArray(data?.tracks)) return data;
        } catch { /* 아래에서 조각으로 다시 읽는다 */ }
    }
    const tracks = [];
    for (const piece of text.match(/\{[^{}]*"artist"[^{}]*\}/g) || []) {
        try { tracks.push(JSON.parse(piece)); } catch { /* 깨진 조각은 건너뜀 */ }
    }
    if (!tracks.length) return null;
    return { mood: text.match(/"mood"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? '', tracks };
}

function parseAnswer(raw, allowed) {
    const text = String(raw ?? '').trim();
    const data = readJson(text);
    if (!data) {
        console.warn(LOG, '읽지 못한 모델 답:', text);
        if (!text) throw new Error('모델이 빈 답을 돌려주었습니다. 생각(추론)에 토큰을 다 썼을 수 있으니 분석에 쓸 연결을 다른 모델로 바꿔 보세요.');
        throw new Error(`모델이 추천 목록 대신 다른 답을 돌려주었습니다: "${text.slice(0, 90)}${text.length > 90 ? '…' : ''}"`);
    }
    const played = new Set(recentNames(40).map(nk));
    const seen = new Set();
    const tracks = [];
    let offGenre = 0;
    for (const t of Array.isArray(data?.tracks) ? data.tracks : []) {
        const artist = String(t?.artist ?? '').trim();
        const title = String(t?.title ?? '').trim();
        if (!artist || !title) continue;
        const genre = matchGenre(t?.genre, allowed);
        if (!genre) { offGenre++; continue; }
        const key = nk(trackName({ artist, title }));
        if (seen.has(key) || played.has(key)) continue;
        seen.add(key);
        tracks.push({ artist, title, genre: genre.label, reason: String(t?.reason ?? '').trim() });
    }
    if (offGenre) console.log(LOG, `선택한 장르 밖의 추천 ${offGenre}곡을 뺐습니다.`);
    return { mood: String(data?.mood ?? '').trim(), tracks };
}

// ── YouTube 검색 ─────────────────────────────────────────────────────────

const BAD_WORDS = [
    'cover', 'live', 'remix', 'karaoke', 'nightcore', 'sped up', 'slowed', 'reverb', '8d', 'reaction',
    'fancam', 'instrumental', 'inst', '1 hour', 'playlist', 'mashup', 'tribute', 'piano ver',
    '커버', '라이브', '노래방', '직캠', '1시간', '플레이리스트', '모음', '리믹스', '반주',
];

function hasWord(text, word) {
    if (/^[a-z0-9 ]+$/.test(word)) return new RegExp(`(^|[^a-z0-9])${word.replace(/ /g, '\\s*')}([^a-z0-9]|$)`, 'i').test(text);
    return text.includes(word);
}

// 검색 결과 하나가 요청한 곡의 공식 음원일 가능성을 점수로 매긴다.
function rateVideo(item, index, track) {
    const title = decodeEntities(item.snippet?.title);
    const channel = decodeEntities(item.snippet?.channelTitle);
    const description = String(item.snippet?.description ?? '');
    const wanted = `${track.artist} ${track.title}`.toLowerCase();
    const lower = title.toLowerCase();

    const topic = /\s-\sTopic$/i.test(channel);
    const provided = /^Provided to YouTube by/i.test(description.trim());
    const audioTitle = /official\s*audio|official\s*lyric|공식\s*음원|오피셜\s*오디오/i.test(title);
    const channelKey = nk(channel.replace(/\s-\sTopic$/i, ''));
    const artistKey = nk(track.artist);
    const officialChannel = topic || /vevo$/i.test(channel.trim()) || /official/i.test(channel)
        || (artistKey.length > 1 && (channelKey === artistKey || channelKey.includes(artistKey)));
    const officialVideo = officialChannel && /official|m\/?v|뮤직\s*비디오/i.test(title);

    let kind = '';
    if (topic || provided || audioTitle) kind = 'audio';
    else if (officialVideo || officialChannel) kind = 'video';

    let score = Math.max(0, 8 - index) * 3;
    if (topic || provided) score += 120;
    if (audioTitle) score += 80;
    if (officialVideo) score += 50;
    if (officialChannel) score += 30;
    score += nk(title).includes(nk(track.title)) ? 40 : -40;
    if (artistKey.length > 1 && (nk(title).includes(artistKey) || channelKey.includes(artistKey))) score += 25;
    for (const word of BAD_WORDS) {
        if (S().instrumentalOnly && /^(instrumental|inst|반주)$/.test(word)) continue;
        if (hasWord(lower, word) && !hasWord(wanted, word)) score -= 100;
    }
    return { id: item.id?.videoId, title, channel, kind, score };
}

function apiErrorMessage(status, body) {
    const reason = body?.error?.errors?.[0]?.reason || '';
    const message = body?.error?.message || '';
    if (/quota|dailyLimit|rateLimit/i.test(reason)) return '오늘 쓸 수 있는 YouTube 검색 할당량을 다 썼습니다. 내일 다시 쓸 수 있습니다.';
    if (/keyInvalid/i.test(reason) || /API key not valid/i.test(message)) return 'YouTube API 키가 올바르지 않습니다.';
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(`${reason} ${message}`)) return '이 키의 프로젝트에서 YouTube Data API v3를 사용 설정해 주세요.';
    if (/forbidden|referer|ipRefererBlocked|API_KEY_/i.test(`${reason} ${message}`)) return 'YouTube API 키의 사용 제한 때문에 요청이 막혔습니다. 키의 제한 설정을 확인해 주세요.';
    return `YouTube 검색에 실패했습니다 (${status}${message ? `: ${message}` : ''}).`;
}

const cacheKey = (track) => `${nk(track.artist)}|${nk(track.title)}|${S().officialOnly ? 1 : 0}${S().instrumentalOnly ? 'i' : ''}`;

function cachePut(key, value) {
    const s = S();
    s.cache[key] = { ...value, t: Date.now() };
    const keys = Object.keys(s.cache);
    if (keys.length > CACHE_MAX) {
        keys.sort((a, b) => (s.cache[a].t || 0) - (s.cache[b].t || 0)).slice(0, keys.length - CACHE_MAX).forEach((k) => delete s.cache[k]);
    }
    save();
}

async function findVideo(track) {
    const s = S();
    const key = cacheKey(track);
    const hit = s.cache[key];
    if (hit?.id) return hit;
    if (hit && Date.now() - (hit.t || 0) < MISS_TTL) return null;

    const params = new URLSearchParams({
        part: 'snippet',
        type: 'video',
        videoCategoryId: '10',
        videoEmbeddable: 'true',
        maxResults: '8',
        q: `${track.artist} ${track.title} ${s.instrumentalOnly ? 'official' : 'official audio'}`,
        key: s.apiKey,
    });
    let response;
    try {
        response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    } catch {
        throw new Error('YouTube에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.');
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(apiErrorMessage(response.status, body));

    const rated = (body?.items || [])
        .map((item, i) => rateVideo(item, i, track))
        .filter((v) => v.id && v.score > 0 && (!s.officialOnly || v.kind))
        .sort((a, b) => b.score - a.score);
    const best = rated[0];
    if (!best) {
        cachePut(key, { id: null });
        return null;
    }
    const video = { id: best.id, title: best.title, channel: best.channel, kind: best.kind };
    cachePut(key, video);
    return video;
}

// ── 플레이어 ─────────────────────────────────────────────────────────────

function loadYouTubeApi() {
    if (st.ytPromise) return st.ytPromise;
    st.ytPromise = new Promise((resolve, reject) => {
        if (window.YT?.Player) return resolve(window.YT);
        const previous = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
            try { previous?.(); } catch (e) { console.warn(LOG, e); }
            resolve(window.YT);
        };
        if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
            const tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';
            tag.onerror = () => { st.ytPromise = null; reject(new Error('YouTube 플레이어를 불러오지 못했습니다.')); };
            document.head.appendChild(tag);
        }
        // 다른 확장이 먼저 불러 둔 경우에는 준비 신호가 다시 오지 않으므로 직접 확인한다.
        const started = Date.now();
        const timer = setInterval(() => {
            if (window.YT?.Player) { clearInterval(timer); resolve(window.YT); }
            else if (Date.now() - started > 20000) { clearInterval(timer); st.ytPromise = null; reject(new Error('YouTube 플레이어를 불러오지 못했습니다.')); }
        }, 250);
    });
    return st.ytPromise;
}

async function ensurePlayer() {
    if (st.playerReady) return st.playerReady;
    const YT = await loadYouTubeApi();
    st.playerReady = new Promise((resolve) => {
        st.player = new YT.Player('cbgm_player', {
            width: '100%',
            height: '100%',
            playerVars: { playsinline: 1, rel: 0, controls: 1, origin: location.origin },
            events: {
                onReady: () => resolve(st.player),
                onStateChange: onPlayerState,
                onError: onPlayerError,
            },
        });
    });
    return st.playerReady;
}

const isPlaying = () => st.playerState === 1 || st.playerState === 3;

function onPlayerState(event) {
    st.playerState = event.data;
    if (event.data === 1) {
        st.errStreak = 0;
        st.needTap = false;
        clearTimeout(st.hintTimer);
        nameDirectTrack();
    }
    if (event.data === 0) onTrackEnded();
    render();
}

// 2·5: 잘못된 영상, 100: 삭제·비공개, 101·150: 다른 사이트 재생 금지
function onPlayerError(event) {
    console.warn(LOG, 'player error', event?.data, st.current?.video?.id);
    if (st.current?.direct) {
        st.current = null;
        setStatus('이 영상은 틀 수 없습니다. 주소가 맞는지, 다른 사이트에서의 재생이 막힌 영상은 아닌지 확인해 주세요.', true);
        return;
    }
    if (st.current) cachePut(cacheKey(st.current), { id: null });
    st.current = null;
    if (++st.errStreak > 4) {
        setStatus('재생할 수 없는 영상이 이어져 멈췄습니다. ✨로 다시 추천받아 보세요.', true);
        return;
    }
    playNext();
}

async function onTrackEnded() {
    const s = S();
    if (s.repeat === 'one') {
        st.player?.seekTo(0);
        st.player?.playVideo();
        return;
    }
    if (s.repeat === 'star' && await playNextStar()) return;
    if (st.queue.length) await playNext();
    else await recommend({ switchNow: true });
}

async function startVideo(track, video) {
    const s = S();
    st.current = { ...track, video };
    const name = nk(trackName(track));
    // 주소로 직접 넣은 곡은 이름을 나중에 알게 되므로 영상으로 같은 곡인지 가린다.
    const same = (p) => (track.direct ? p.direct && p.vid === video.id : !p.direct && nk(trackName(p)) === name);
    // 별표 단 곡은 자리를 옮기지 않는다. 옮기면 ★ 곡들 반복의 순서가 재생할 때마다 뒤섞인다.
    const starred = s.played.find((p) => p.star && same(p));
    if (starred) {
        starred.t = Date.now();
        starred.kind = video.kind;
        starred.vid = video.id;
    } else {
        s.played = s.played.filter((p) => !same(p))
            .concat({ ...trackFields(track), kind: video.kind, vid: video.id, t: Date.now(), star: false });
    }
    // 한도를 넘으면 별표가 없는 오래된 곡부터 뺀다.
    for (let i = 0; s.played.length > PLAYED_MAX && i < s.played.length;) {
        if (s.played[i].star) i++;
        else s.played.splice(i, 1);
    }
    save();
    scheduleCards();
    buildPanel();
    const player = await ensurePlayer();
    player.setVolume(s.volume);
    player.loadVideoById(video.id);
    // 브라우저가 소리 나는 자동 재생을 막으면 재생이 시작되지 않는다. 그때는 눌러 달라고 알린다.
    clearTimeout(st.hintTimer);
    st.needTap = false;
    st.hintTimer = setTimeout(() => {
        if (st.current?.video?.id !== video.id || isPlaying()) return;
        st.needTap = true;
        if (!st.panelOpen) toast('info', '브라우저가 자동 재생을 막았습니다. 음표를 한 번 눌러 주세요.');
        render();
    }, 4000);
    setStatus('');
}

// 재생 기록에 보이는 순서대로 별표 단 곡을 돌려 가며 튼다. 틀 곡이 없으면 false.
async function playNextStar() {
    const list = S().played.filter((p) => p.star).reverse();
    if (!list.length) return false;
    const current = st.current ? nk(trackName(st.current)) : '';
    const at = list.findIndex((p) => nk(trackName(p)) === current);
    for (let i = 1; i <= list.length; i++) {
        const t = list[(at + i) % list.length];
        let video;
        try {
            video = await resolveVideo(t);
        } catch (e) {
            setStatus(e.message, true);
            return true;
        }
        if (!video) continue;
        await startVideo(trackFields(t), video);
        return true;
    }
    return false;
}

async function playNext() {
    while (st.queue.length) {
        const track = st.queue.shift();
        let video;
        try {
            video = await findVideo(track);
        } catch (e) {
            st.queue.unshift(track);
            setStatus(e.message, true);
            return false;
        }
        if (!video) continue;
        await startVideo(track, video);
        return true;
    }
    setStatus(S().officialOnly
        ? '추천받은 곡의 공식 음원을 찾지 못했습니다. ✨로 다시 추천받아 보세요.'
        : '추천받은 곡을 YouTube에서 찾지 못했습니다. ✨로 다시 추천받아 보세요.', true);
    return false;
}

// ── 추천 ────────────────────────────────────────────────────────────────

async function recommend({ manual = false, switchNow = manual, upTo = null } = {}) {
    const s = S();
    if (!s.enabled || st.busy) return;
    const allowed = allowedGenres();
    if (!allowed.length) {
        setStatus('설정에서 장르를 하나 이상 체크해 주세요.', true);
        return;
    }
    const scene = collectScene(upTo);
    if (!scene) {
        setStatus('아직 읽을 채팅 내용이 없습니다.', true);
        return;
    }
    const chatId = ctx().getCurrentChatId?.();
    st.busy = true;
    setStatus('장면을 읽고 곡을 고르는 중…');
    try {
        const { system, user } = buildPrompt(scene, allowed);
        const raw = await askModel(system, user);
        if (chatId !== ctx().getCurrentChatId?.()) return;
        const { mood, tracks } = parseAnswer(raw, allowed);
        if (!tracks.length) throw new Error('체크한 장르 안에서 새로 추천받은 곡이 없습니다. 다시 시도해 주세요.');
        st.mood = mood;
        st.queue = tracks;
        st.tab = 'queue';
        setStatus('');
        const keep = Number.isInteger(upTo) && s.cardOnPick;
        if (!s.apiKey) {
            if (keep) attachCard(upTo, tracks[0]);
            setStatus('YouTube API 키를 넣으면 바로 재생됩니다. 지금은 추천곡을 누르면 YouTube 검색이 열립니다.', true);
            return;
        }
        if (switchNow || !st.current || !isPlaying()) {
            const started = await playNext();
            if (started && keep && chatId === ctx().getCurrentChatId?.()) attachCard(upTo, st.current);
        }
    } catch (e) {
        console.error(LOG, e);
        setStatus(e?.message || '추천을 받지 못했습니다.', true);
    } finally {
        st.busy = false;
        render();
    }
}

function openSearch(track) {
    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(`${track.artist} ${track.title} official audio`)}`, '_blank', 'noopener');
}

// ── 주소로 직접 넣기 ─────────────────────────────────────────────────────
//
// YouTube 주소를 넣으면 검색 없이 그 영상을 그대로 튼다. 곡 이름은 재생이 시작된 뒤 플레이어에서 읽는다.
// 이렇게 넣은 곡은 direct·vid를 달고 다니며, 다시 틀 때도 검색하지 않고 같은 영상을 튼다.

const trackFields = (t) => ({
    artist: t.artist,
    title: t.title,
    genre: t.genre,
    reason: t.reason || '',
    ...(t.direct && t.vid ? { direct: true, vid: t.vid } : {}),
});

async function resolveVideo(track) {
    if (track.direct && track.vid) return { id: track.vid, title: track.title, channel: track.artist, kind: '' };
    return findVideo(track);
}

function parseVideoId(text) {
    const value = String(text ?? '').trim();
    if (/^[\w-]{11}$/.test(value)) return value;
    return value.match(/(?:youtu\.be\/|[?&]v=|\/(?:shorts|embed|live)\/)([\w-]{11})/)?.[1] || '';
}

async function playDirect(text) {
    const id = parseVideoId(text);
    if (!id) {
        setStatus('YouTube 영상 주소를 알아보지 못했습니다.', true);
        return false;
    }
    const known = S().played.find((p) => p.direct && p.vid === id);
    const track = known ? trackFields(known) : { artist: 'YouTube', title: '불러오는 중…', genre: '직접 넣기', reason: '', direct: true, vid: id };
    await startVideo(track, { id, title: '', channel: '', kind: '' });
    return true;
}

// 재생이 시작되면 플레이어가 알려 주는 제목·채널로 이름을 채운다.
function nameDirectTrack() {
    const cur = st.current;
    if (!cur?.direct || cur.named) return;
    const data = st.player?.getVideoData?.() || {};
    if (!data.title) return;
    cur.named = true;
    const entry = S().played.find((p) => p.direct && p.vid === cur.vid);
    if (entry && entry.title !== '불러오는 중…') {
        cur.title = entry.title;
        cur.artist = entry.artist;
        return;
    }
    cur.title = String(data.title);
    cur.artist = String(data.author || '').replace(/\s-\sTopic$/i, '') || 'YouTube';
    if (entry) {
        entry.title = cur.title;
        entry.artist = cur.artist;
        save();
    }
}

// 카드·기록·추천 목록에서 고른 곡 하나를 바로 튼다.
async function playTrack(track) {
    if (!track.direct && !S().apiKey) return openSearch(track);
    let video;
    try {
        video = await resolveVideo(track);
    } catch (e) {
        setStatus(e.message, true);
        return;
    }
    if (!video) {
        setStatus(`"${track.title}"의 ${S().officialOnly ? '공식 음원' : '영상'}을 YouTube에서 찾지 못했습니다.`, true);
        return;
    }
    st.queue = st.queue.filter((q) => nk(trackName(q)) !== nk(trackName(track)));
    await startVideo(track, video);
}

function stopAll() {
    clearTimeout(st.hintTimer);
    try { st.player?.stopVideo?.(); } catch { /* 플레이어가 아직 준비되지 않음 */ }
    st.current = null;
    st.needTap = false;
    st.playerState = -1;
    if (!st.busy) st.status = '';
    render();
}

function onMessageReceived(messageId) {
    const s = S();
    if (!s.enabled) return;
    const message = ctx().chat?.[messageId];
    if (!message || message.is_user || message.is_system) return;
    if (s.card && s.cardAutoPlay) {
        const track = readTag(message.mes);
        if (track) {
            st.counter = 0;
            autoPlayCard(track);
            return;
        }
    }
    // 답장 N개마다 다시 읽기는 음악이 나오는 동안에만, 반복이 꺼져 있을 때만 한다.
    if (!s.auto || s.repeat !== 'off' || !st.current || !isPlaying()) return;
    if (++st.counter < clamp(s.autoEvery, 1, 99)) return;
    st.counter = 0;
    setTimeout(() => recommend({ switchNow: S().switchNow }), 1500);
}

function onChatChanged() {
    st.counter = 0;
    st.queue = [];
    st.mood = '';
    if (!st.busy) st.status = '';
    render();
    updateInjection();
    scheduleCards();
}

// ── 곡 카드 (선택 기능) ──────────────────────────────────────────────────
//
// 답장을 쓰는 모델이 답장 끝에 <bgm artist="…" title="…" genre="…"> 한 줄을 적게 하고,
// 확장이 그 메시지 본문 맨 위 가운데에 곡 카드를 그린다. 태그 자체는 화면에 보이지 않는다.

const INJECT_KEY = 'chat_bgm_card';

function updateInjection() {
    const s = S();
    const allowed = allowedGenres();
    let text = '';
    if (s.enabled && s.card && allowed.length) {
        text = [
            '[Background music tag]',
            'At the very end of your reply, on its own final line, add exactly one tag naming a real, commercially released song that fits this scene as background music:',
            '<bgm artist="ARTIST" title="TITLE" genre="GENRE_ID">',
            `Allowed genres (use the id): ${allowed.map((g) => `${g.id} (${g.hint})`).join(', ')}.`,
            'Choose only from the allowed genres. Only name a song you are certain exists. Write the artist and title as on the official release, in the original script, with no double quotes inside the values.',
            s.instrumentalOnly ? 'Instrumental tracks only: no vocals.' : '',
            'Do not repeat a song already tagged earlier in this chat. Write the tag once, and never mention or explain it in the story text.',
        ].filter(Boolean).join('\n');
    }
    // 위치 1 = 채팅 안(깊이 0), 역할 0 = 시스템
    ctx().setExtensionPrompt?.(INJECT_KEY, text, 1, 0, false, 0);
}

function readTag(text) {
    let found = null;
    for (const m of String(text ?? '').matchAll(/<bgm\b([^>]*)>/gi)) found = m[1];
    if (found === null) return null;
    const attrs = {};
    for (const m of found.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '').trim();
    if (!attrs.artist || !attrs.title) return null;
    const genre = matchGenre(attrs.genre, allowedGenres());
    if (!genre) return null;
    return { artist: attrs.artist, title: attrs.title, genre: genre.label, reason: '' };
}

// 메시지 단추로 고른 곡은 본문을 건드리지 않고 메시지의 extra에 적어 둔다. 채팅 파일에 함께 저장된다.
function savedCard(message) {
    const c = message?.extra?.chat_bgm;
    if (!c?.artist || !c?.title) return null;
    return trackFields({ artist: String(c.artist), title: String(c.title), genre: String(c.genre || ''), direct: !!c.direct, vid: c.vid });
}

function attachCard(messageId, track) {
    const message = ctx().chat?.[messageId];
    if (!message || !track) return;
    message.extra = message.extra || {};
    const { reason, ...card } = trackFields(track);
    message.extra.chat_bgm = card;
    ctx().saveChat?.();
    scheduleCards();
}

// 재생 기록의 곡을 고른 메시지에 카드로 붙인다. 그 메시지에 카드가 이미 있으면 이 곡으로 바뀐다.
async function attachToMessage(track) {
    const c = ctx();
    const last = (c.chat?.length || 0) - 1;
    if (last < 0) return toast('info', '열려 있는 채팅이 없습니다.');
    const question = `"${track.title}" 카드를 붙일 메시지 번호를 적어 주세요 (0 ~ ${last}).\n그 메시지에 카드가 이미 있으면 이 곡으로 바뀝니다.`;
    let answer;
    // 팝업 내용은 HTML로 그려지므로 곡 이름을 그대로 넣지 않는다.
    if (c.callGenericPopup && c.POPUP_TYPE) answer = await c.callGenericPopup(esc(question).replace(/\n/g, '<br>'), c.POPUP_TYPE.INPUT, String(last));
    else answer = window.prompt(question, String(last));
    if (answer === null || answer === undefined || answer === false || String(answer).trim() === '') return;
    const text = String(answer).trim().replace(/^#/, '');
    const id = Number(text);
    if (!/^\d+$/.test(text) || id > last) return toast('warning', `메시지 번호는 0부터 ${last}까지의 숫자로 적어 주세요.`);
    attachCard(id, track);
    toast('success', `#${id} 메시지에 "${track.title}" 카드를 붙였습니다.`);
}

// 직접 붙인 카드는 extra에서 지우고, 모델이 답장에 적은 카드는 본문에서 <bgm> 태그를 지운다.
function detachCard(messageId) {
    const message = ctx().chat?.[messageId];
    if (!message) return;
    if (message.extra?.chat_bgm) {
        delete message.extra.chat_bgm;
    } else {
        const strip = (text) => String(text ?? '').replace(/\s*<bgm\b[^>]*>(\s*<\/bgm>)?/gi, '').trimEnd();
        if (!/<bgm\b/i.test(message.mes || '')) return;
        message.mes = strip(message.mes);
        const swipe = message.swipe_id;
        if (Array.isArray(message.swipes) && typeof message.swipes[swipe] === 'string') message.swipes[swipe] = strip(message.swipes[swipe]);
    }
    ctx().saveChat?.();
    scheduleCards();
}

// 재생한 적이 있어 영상을 아는 곡만 썸네일을 붙인다(카드마다 새로 검색하지 않는다).
// 그림은 저장하지 않고 매번 YouTube에서 불러온다. 지워진 영상은 작은 회색 그림이 오므로 걸러 낸다.
const thumbState = new Map();

function thumbFor(track) {
    const name = nk(trackName(track));
    const vid = (track.direct && track.vid) || S().played.find((p) => p.vid && nk(trackName(p)) === name)?.vid || S().cache[cacheKey(track)]?.id;
    if (!vid || !/^[\w-]{6,20}$/.test(vid)) return '';
    const url = `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`;
    const state = thumbState.get(vid);
    if (state === 'ok') return url;
    if (!state) {
        thumbState.set(vid, 'pending');
        const probe = new Image();
        probe.onload = () => { thumbState.set(vid, probe.naturalWidth > 120 ? 'ok' : 'bad'); scheduleCards(); };
        probe.onerror = () => thumbState.set(vid, 'bad');
        probe.src = url;
    }
    return '';
}

function autoPlayCard(track) {
    if (!S().apiKey) return;
    if (st.current && nk(trackName(st.current)) === nk(trackName(track))) return;
    if (!st.current || (isPlaying() && S().switchNow)) {
        playTrack(track);
        return;
    }
    // 듣던 곡이 있으면 끊지 않고 다음 차례에 넣는다.
    st.queue = [track, ...st.queue.filter((q) => nk(trackName(q)) !== nk(trackName(track)))];
    render();
}

// "HTML 태그 표시" 설정이 켜져 있으면 태그가 글자로 보이므로 지운다.
function stripTagText(root) {
    if (!root || !root.textContent.includes('bgm')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
        if (/<\/?bgm\b[^>]*>/i.test(node.nodeValue)) node.nodeValue = node.nodeValue.replace(/<\/?bgm\b[^>]*>/gi, '');
    }
}

function renderCards() {
    const s = S();
    const on = s.enabled && s.card;
    const chat = ctx().chat || [];
    document.querySelectorAll('#chat .mes').forEach((mes) => {
        const id = Number(mes.getAttribute('mesid'));
        const message = chat[id];
        // 직접 붙인 카드가 먼저고, 없으면 모델이 답장에 적은 태그를 쓴다.
        const kept = s.enabled ? savedCard(message) : null;
        const track = kept || (on && message && !message.is_user ? readTag(message.mes) : null);
        const thumb = track && (s.cardStyle === 'player' || s.cardStyle === 'vinyl') ? thumbFor(track) : '';
        const sig = track ? `${track.artist}|${track.title}|${track.genre}|${kept ? 'kept' : ''}|${s.cardStyle}|${thumb}` : '';
        const host = mes.querySelector('.mes_block .mes_text');
        // 편집 중에는 본문 자리에 입력 칸이 들어가 있으므로 그리지 않는다.
        const show = track && host && !host.querySelector('textarea');
        let old = null;
        for (const card of mes.querySelectorAll('.cbgm-card')) {
            if (show && !old && card.parentElement === host && card.dataset.sig === sig) old = card;
            else card.remove();
        }
        if (show && old && host.firstElementChild !== old) host.prepend(old);
        if (show && !old) {
            const card = document.createElement('div');
            card.className = `cbgm-card cbgm-card--${s.cardStyle}`;
            if (thumb) {
                card.classList.add('cbgm-card-thumb');
                card.style.setProperty('--cbgm-thumb', `url("${thumb}")`);
            }
            card.dataset.sig = sig;
            card.dataset.artist = track.artist;
            card.dataset.title = track.title;
            card.dataset.genre = track.genre;
            card.dataset.mesid = String(id);
            if (track.direct) card.dataset.vid = track.vid;
            // 본문 안의 <i>·<b>는 테마가 기울임과 색을 입히므로 span만 쓴다.
            card.title = '눌러서 재생·일시정지';
            // 모양(알약·미니 플레이어·한 줄·LP판·진행 막대)은 같은 뼈대를 두고 CSS로만 바꾼다.
            card.innerHTML = `
                <span class="cbgm-card-art"><span class="fa-solid fa-music"></span></span>
                <span class="cbgm-card-btn"><span class="fa-solid fa-play"></span></span>
                <span class="cbgm-card-name">
                    <span class="cbgm-card-title">${esc(track.title)}</span>
                    <span class="cbgm-card-artist">${esc(track.artist)}${track.genre ? `<span class="cbgm-card-sub"> · ${esc(track.genre)}</span>` : ''}</span>
                </span>
                ${track.genre ? `<span class="cbgm-card-genre">${esc(track.genre)}</span>` : ''}
                <span class="cbgm-card-eq"><span></span><span></span><span></span></span>
                <span class="cbgm-card-bar"><span class="cbgm-card-pos">0:00</span><span class="cbgm-card-track"><span></span></span><span class="cbgm-card-dur">0:00</span></span>
                <span class="cbgm-card-x fa-solid fa-xmark" title="카드 떼기"></span>`;
            host.prepend(card);
        }
        if (on && message && /<\/?bgm\b/i.test(message.mes || '')) stripTagText(mes.querySelector('.mes_text'));
    });
    renderCardStates();
}

// 지금 나오는 곡의 카드는 단추를 일시정지 모양으로 바꾼다.
function renderCardStates() {
    const playing = st.current && isPlaying() ? nk(trackName(st.current)) : '';
    document.querySelectorAll('#chat .cbgm-card').forEach((card) => {
        const on = !!playing && nk(`${card.dataset.artist} - ${card.dataset.title}`) === playing;
        card.classList.toggle('cbgm-card-on', on);
        const icon = card.querySelector('.cbgm-card-btn > span');
        if (icon) icon.className = `fa-solid ${on ? 'fa-pause' : 'fa-play'}`;
    });
}

// 진행 막대 모양일 때, 지금 나오는 곡의 카드에 재생 위치를 1초마다 적는다.
function renderCardProgress() {
    if (S().cardStyle !== 'bar' || !isPlaying()) return;
    const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    const pos = Number(st.player?.getCurrentTime?.()) || 0;
    const dur = Number(st.player?.getDuration?.()) || 0;
    document.querySelectorAll('#chat .cbgm-card-on').forEach((card) => {
        card.querySelector('.cbgm-card-track > span').style.width = `${dur ? Math.min(100, Math.round(pos / dur * 100)) : 0}%`;
        card.querySelector('.cbgm-card-pos').textContent = clock(pos);
        card.querySelector('.cbgm-card-dur').textContent = clock(dur);
    });
}

// 본문은 다른 확장(번역 등)이 알림 없이 다시 그리기도 하므로 채팅 영역의 변화를 지켜보다 카드를 다시 붙인다.
function watchChat() {
    const chat = $id('chat');
    if (chat) new MutationObserver(scheduleCards).observe(chat, { childList: true, subtree: true });
}

function scheduleCards() {
    clearTimeout(st.cardTimer);
    st.cardTimer = setTimeout(renderCards, 150);
}

// ── 빠른 답장 줄 아이콘 ───────────────────────────────────────────────────────
//
// 짧게 누르면 재생·일시정지, 꾹 누르거나 우클릭하면 플레이어를 연다.
// 빠른 답장은 세트가 바뀔 때마다 줄을 새로 그리므로 그때마다 다시 붙인다.

function findIconHost() {
    const scope = document.querySelector('#qr--bar') || document.querySelector('#qr--popout > .qr--body');
    if (!scope) return { host: $id('leftSendForm'), qr: false };
    const holders = scope.querySelectorAll(':scope > .qr--buttons');
    if (holders.length) return { host: holders[holders.length - 1], qr: true };
    const holder = document.createElement('div');
    holder.className = 'qr--buttons cbgm-qr-holder';
    scope.append(holder);
    return { host: holder, qr: true };
}

function buildIcon() {
    const icon = document.createElement('div');
    icon.id = 'cbgm_qr';
    icon.className = 'cbgm-qr interactable';
    icon.tabIndex = 0;
    icon.innerHTML = '<i class="fa-solid fa-music"></i>';

    let timer = 0;
    let start = null;
    let held = false;
    let lastHold = 0;
    const hold = () => {
        held = true;
        clearTimeout(timer);
        timer = 0;
        // 휴대폰에서는 꾹 누르면 contextmenu도 함께 오므로 한 번만 받는다.
        if (Date.now() - lastHold < 1000) return;
        lastHold = Date.now();
        togglePanel();
    };
    const cancel = () => { clearTimeout(timer); timer = 0; };
    icon.addEventListener('pointerdown', (e) => {
        if (e.button) return;
        held = false;
        start = { x: e.clientX, y: e.clientY };
        cancel();
        timer = setTimeout(hold, 500);
    });
    icon.addEventListener('pointermove', (e) => {
        if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
    });
    for (const name of ['pointerup', 'pointercancel', 'pointerleave']) icon.addEventListener(name, cancel);
    icon.addEventListener('contextmenu', (e) => { e.preventDefault(); hold(); });
    icon.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (held) { held = false; return; }
        onIconTap();
    });
    return icon;
}

function onIconTap() {
    const s = S();
    if (st.busy) return;
    if (!st.current) {
        if (st.queue.length && s.apiKey) playNext();
        else recommend({ manual: true });
        return;
    }
    if (isPlaying()) st.player?.pauseVideo();
    else st.player?.playVideo();
}

function syncIcon() {
    st.iconQueued = false;
    let icon = $id('cbgm_qr');
    if (!S().enabled) {
        icon?.remove();
        return;
    }
    const { host, qr } = findIconHost();
    if (!host) return;
    if (!icon) icon = st.icon || (st.icon = buildIcon());
    if (icon.parentElement !== host) host.append(icon);
    icon.classList.toggle('qr--button', qr);
    renderIcon();
}

function watchIconHost() {
    const queue = () => {
        if (st.iconQueued) return;
        st.iconQueued = true;
        requestAnimationFrame(syncIcon);
    };
    const observer = new MutationObserver(queue);
    const form = $id('send_form');
    if (form) observer.observe(form, { childList: true, subtree: true });
    observer.observe(document.body, { childList: true });
    syncIcon();
}

function renderIcon() {
    const icon = $id('cbgm_qr');
    if (!icon) return;
    icon.classList.toggle('cbgm-playing', !!st.current && isPlaying());
    icon.classList.toggle('cbgm-busy', st.busy);
    icon.classList.toggle('cbgm-need-tap', st.needTap);
    icon.title = st.current
        ? `${st.current.title} – ${st.current.artist}\n누르면 재생·일시정지, 꾹 누르면 플레이어`
        : 'Chat BGM\n누르면 지금 장면으로 추천, 꾹 누르면 플레이어';
}

// ── 플레이어 화면 ────────────────────────────────────────────────────────

function setStatus(text, isError = false) {
    st.status = text;
    st.statusError = isError;
    // 플레이어가 닫혀 있으면 문제를 볼 곳이 없으니 알림으로 띄운다.
    if (text && isError && !st.panelOpen) toast('warning', text);
    render();
}

function buildPanel() {
    if ($id('cbgm_panel')) return;
    const panel = document.createElement('div');
    panel.id = 'cbgm_panel';
    panel.className = 'cbgm-panel';
    panel.innerHTML = `
        <div class="cbgm-head">
            <i class="fa-solid fa-music"></i>
            <span class="cbgm-head-title">Chat BGM</span>
            <div class="cbgm-icon" data-act="close" title="닫기 (음악은 계속 나옵니다)"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="cbgm-video"><div id="cbgm_player"></div></div>
        <div class="cbgm-now"></div>
        <div class="cbgm-status"></div>
        <div class="cbgm-ctrl">
            <div class="cbgm-icon" data-act="toggle" title="재생·일시정지"><i class="fa-solid fa-play"></i></div>
            <div class="cbgm-icon" data-act="next" title="다음 곡"><i class="fa-solid fa-forward-step"></i></div>
            <div class="cbgm-icon" data-act="stop" title="끄기"><i class="fa-solid fa-stop"></i></div>
            <div class="cbgm-icon" data-act="repeat" title="한 곡 반복"><i class="fa-solid fa-repeat"></i></div>
            <div class="cbgm-icon" data-act="recommend" title="지금 장면으로 새로 추천"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
            <i class="fa-solid fa-volume-low cbgm-vol-icon"></i>
            <input type="range" class="cbgm-vol" min="0" max="100" step="1" title="음량">
        </div>
        <div class="cbgm-tabs">
            <div class="cbgm-tab" data-act="tab" data-tab="queue">추천곡</div>
            <div class="cbgm-tab" data-act="tab" data-tab="direct">직접 넣기</div>
            <div class="cbgm-tab" data-act="tab" data-tab="history">재생 기록</div>
        </div>
        <div class="cbgm-list"></div>`;
    document.body.appendChild(panel);

    panel.addEventListener('click', (e) => {
        const target = e.target.closest('[data-act]');
        if (target) onPanelAction(target.dataset.act, target);
    });
    panel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList?.contains('cbgm-direct-url')) onPanelAction('direct');
    });
    const volume = panel.querySelector('.cbgm-vol');
    volume.value = String(S().volume);
    volume.addEventListener('input', () => {
        S().volume = Number(volume.value);
        st.player?.setVolume?.(S().volume);
        save();
    });
    bindDrag(panel, panel.querySelector('.cbgm-head'));
    window.addEventListener('resize', placePanel);
}

// 기록을 지워도 별표를 단 곡은 남긴다.
function clearHistory() {
    const s = S();
    s.played = s.played.filter((p) => p.star);
}

// 재생 기록은 최근 것이 위에 오게 보여 준다.
const historyList = () => S().played.slice().reverse();

async function onPanelAction(act, target) {
    const s = S();
    if (act === 'close') return closePanel();
    if (act === 'stop') return stopAll();
    if (act === 'repeat') {
        // 누를 때마다 끔 → 한 곡 → ★ 곡들 순으로 바뀐다. 설정의 "곡이 끝나면"과 같은 값이다.
        s.repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(s.repeat) + 1) % REPEAT_MODES.length];
        save();
        const box = document.querySelector('#cbgm_settings [data-key="repeat"]');
        if (box) box.value = s.repeat;
        if (s.repeat === 'star' && !s.played.some((p) => p.star)) toast('info', '별표 단 곡이 아직 없습니다. 재생 기록에서 ☆를 눌러 주세요.');
        render();
        return;
    }
    if (act === 'recommend') return recommend({ manual: true });
    if (act === 'tab') {
        st.tab = target.dataset.tab;
        render();
        return;
    }
    if (act === 'next') {
        if (st.busy) return;
        if (s.repeat === 'star' && s.apiKey && await playNextStar()) return;
        if (st.queue.length && s.apiKey) await playNext();
        else await recommend({ manual: true });
        return;
    }
    if (act === 'toggle') return onIconTap();
    if (act === 'pick' || act === 'replay') {
        const list = act === 'pick' ? st.queue : historyList();
        const track = list[Number(target.dataset.index)];
        if (track) await playTrack(trackFields(track));
        return;
    }
    if (act === 'direct') {
        const input = $id('cbgm_panel').querySelector('.cbgm-direct-url');
        if (input.value.trim() && await playDirect(input.value)) input.value = '';
        return;
    }
    if (act === 'attach') {
        const track = historyList()[Number(target.dataset.index)];
        if (track) await attachToMessage(track);
        return;
    }
    if (act === 'star') {
        const track = historyList()[Number(target.dataset.index)];
        if (!track) return;
        track.star = !track.star;
        save();
        render();
        return;
    }
    if (act === 'clearHistory') {
        clearHistory();
        save();
        render();
    }
}

function openPanel() {
    buildPanel();
    st.panelOpen = true;
    $id('cbgm_panel').classList.add('cbgm-open');
    render();
    placePanel();
}

// 닫아도 음악은 계속 나온다. 끄는 것은 ■ 단추다.
function closePanel() {
    st.panelOpen = false;
    $id('cbgm_panel')?.classList.remove('cbgm-open');
}

function togglePanel() {
    if (!S().enabled) return toast('info', '확장 설정에서 Chat BGM의 "사용"을 켜 주세요.');
    if (st.panelOpen) closePanel();
    else openPanel();
}

// 모바일 실리태번은 html에 transform이 걸려 있어 bottom/right 기준이 어긋난다. 항상 left/top을 픽셀로 준다.
// 끌어서 옮긴 적이 없으면 빠른 답장 줄 아이콘 바로 위에 띄운다.
function placePanel() {
    const panel = $id('cbgm_panel');
    if (!panel) return;
    const s = S();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    let x = window.innerWidth - w - 12;
    let y = window.innerHeight - h - 110;
    const anchor = $id('cbgm_qr')?.getBoundingClientRect();
    if (s.pos) {
        x = s.pos.x;
        y = s.pos.y;
    } else if (anchor?.width) {
        x = anchor.left + anchor.width / 2 - w / 2;
        y = anchor.top - h - 8;
    }
    panel.style.left = `${clamp(x, 4, Math.max(4, window.innerWidth - w - 4))}px`;
    panel.style.top = `${clamp(y, 4, Math.max(4, window.innerHeight - h - 4))}px`;
}

function bindDrag(panel, handle) {
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('[data-act]')) return;
        drag = { dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop };
        handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
        if (!drag) return;
        S().pos = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
        placePanel();
    });
    const end = () => {
        if (!drag) return;
        drag = null;
        S().pos = { x: panel.offsetLeft, y: panel.offsetTop };
        save();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
}

function formatTime(t) {
    if (!t) return '';
    const d = new Date(t);
    const two = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function listRow(track, index, act, side) {
    const star = act === 'replay'
        ? `<span class="cbgm-star ${track.star ? 'cbgm-star-on' : ''}" data-act="star" data-index="${index}" title="별표를 달면 기록을 지워도 남습니다"><i class="${track.star ? 'fa-solid' : 'fa-regular'} fa-star"></i></span>`
        : '';
    return `
        <div class="cbgm-row-item" data-act="${act}" data-index="${index}" title="${esc(track.reason || '')}">
            ${star}
            <span class="cbgm-row-name"><b>${esc(track.title)}</b> <span>${esc(track.artist)}</span></span>
            <span class="cbgm-row-side">${esc(side)}</span>
            ${act === 'replay' ? `<span class="cbgm-row-go" data-act="attach" data-index="${index}" title="이 곡을 메시지에 카드로 붙이기"><i class="fa-solid fa-arrow-right"></i></span>` : ''}
        </div>`;
}

function render() {
    renderIcon();
    renderCardStates();
    const panel = $id('cbgm_panel');
    if (!panel) return;
    const before = panel.offsetHeight;
    panel.classList.toggle('cbgm-empty', !st.current);
    panel.querySelector('[data-act="toggle"] i').className = `fa-solid ${isPlaying() ? 'fa-pause' : 'fa-play'}`;
    panel.querySelector('[data-act="recommend"]').classList.toggle('cbgm-spin', st.busy);
    const repeat = panel.querySelector('[data-act="repeat"]');
    repeat.classList.toggle('cbgm-icon-on', S().repeat !== 'off');
    repeat.dataset.mode = S().repeat;
    repeat.title = REPEAT_LABELS[S().repeat];

    const now = panel.querySelector('.cbgm-now');
    if (st.current) {
        const t = st.current;
        const badge = t.video.kind === 'audio' ? '공식 음원' : t.video.kind === 'video' ? '공식 채널' : '비공식';
        now.innerHTML = `
            <div class="cbgm-title">${esc(t.title)}</div>
            <div class="cbgm-artist">${esc(t.artist)}</div>
            <div class="cbgm-tags">
                <span class="cbgm-tag">${esc(t.genre)}</span>
                ${t.direct ? '' : `<span class="cbgm-tag ${t.video.kind ? 'cbgm-tag-ok' : ''}" title="${esc(t.video.channel)}">${badge}</span>`}
            </div>
            ${t.reason ? `<div class="cbgm-reason">${esc(t.reason)}</div>` : ''}`;
    } else {
        now.innerHTML = '<div class="cbgm-hint"><i class="fa-solid fa-wand-magic-sparkles"></i> 를 누르면 지금 장면에 어울리는 곡을 골라 틀어 줍니다.</div>';
    }

    const status = panel.querySelector('.cbgm-status');
    const text = st.status || (st.needTap ? '브라우저가 자동 재생을 막았습니다. ▶ 를 눌러 주세요.' : '');
    status.textContent = text;
    status.classList.toggle('cbgm-error', !!text && (st.statusError || !st.status));
    status.hidden = !text;

    panel.querySelectorAll('.cbgm-tab').forEach((tab) => tab.classList.toggle('cbgm-tab-on', tab.dataset.tab === st.tab));
    const list = panel.querySelector('.cbgm-list');
    if (st.tab === 'direct') {
        // 적던 주소가 지워지지 않게, 이미 그려져 있으면 다시 그리지 않는다.
        if (!list.querySelector('.cbgm-direct')) {
            list.innerHTML = `
                <div class="cbgm-direct">
                    <input type="text" class="text_pole cbgm-direct-url" placeholder="YouTube 주소 붙여넣기">
                    <div class="cbgm-icon" data-act="direct" title="이 영상 틀기"><i class="fa-solid fa-play"></i></div>
                </div>
                <div class="cbgm-list-empty">주소의 영상을 그대로 틉니다. 검색 할당량을 쓰지 않고, 튼 곡은 재생 기록에 남습니다.</div>`;
        }
    } else if (st.tab === 'history') {
        const played = historyList();
        list.innerHTML = played.length
            ? `${played.map((t, i) => listRow(t, i, 'replay', formatTime(t.t))).join('')}
               <div class="cbgm-list-foot" data-act="clearHistory">재생 기록 지우기 (★제외)</div>`
            : '<div class="cbgm-list-empty">아직 재생한 곡이 없습니다.</div>';
    } else {
        list.innerHTML = st.queue.length
            ? `${st.mood ? `<div class="cbgm-list-mood"><i class="fa-solid fa-feather"></i> ${esc(st.mood)}</div>` : ''}
               ${st.queue.map((t, i) => listRow(t, i, 'pick', t.genre)).join('')}`
            : '<div class="cbgm-list-empty">대기 중인 추천곡이 없습니다.</div>';
    }
    if (panel.offsetHeight !== before) placePanel();
}

// ── 메뉴·메시지 단추·설정 서랍 ───────────────────────────────────────────

function addMenuItem() {
    if ($id('cbgm_wand')) return;
    const item = document.createElement('div');
    item.id = 'cbgm_wand';
    item.className = 'list-group-item flex-container flexGap5';
    item.innerHTML = '<div class="fa-solid fa-music extensionsMenuExtensionButton"></div><span>Chat BGM</span>';
    item.addEventListener('click', () => togglePanel());
    $id('extensionsMenu')?.appendChild(item);
}

// 메시지마다 음표 단추를 단다. 메시지를 꾹 눌러 뜨는 메뉴는 메시지 단추를 그대로 옮겨 보여 주므로 거기에도 나타난다.
const MES_BUTTON = '<div class="mes_button cbgm-mes-btn fa-solid fa-music interactable" title="이 대화로 음악 추천" tabindex="0"></div>';

function addMessageButton() {
    const targets = [
        document.querySelector('#message_template .mes_buttons .extraMesButtons'),
        ...document.querySelectorAll('#chat .mes .mes_buttons .extraMesButtons'),
    ];
    for (const box of targets) {
        if (box && !box.querySelector('.cbgm-mes-btn')) box.insertAdjacentHTML('afterbegin', MES_BUTTON);
    }
    jQuery(document).on('click', '.cbgm-mes-btn', function () {
        if (!S().enabled) return toast('info', '확장 설정에서 Chat BGM의 "사용"을 켜 주세요.');
        if (st.busy) return toast('info', '지금 곡을 고르는 중입니다.');
        const id = Number(this.closest('.mes')?.getAttribute('mesid'));
        recommend({ manual: true, upTo: Number.isInteger(id) ? id : null });
    });
    jQuery(document).on('click', '.cbgm-card', function (e) {
        if (!S().enabled) return;
        if (e.target.closest?.('.cbgm-card-x')) return S().cardRemove ? detachCard(Number(this.dataset.mesid)) : undefined;
        const track = trackFields({ artist: this.dataset.artist, title: this.dataset.title, genre: this.dataset.genre, direct: !!this.dataset.vid, vid: this.dataset.vid });
        // 이미 걸려 있는 곡이면 재생·일시정지만 바꾼다.
        if (st.current && nk(trackName(st.current)) === nk(trackName(track))) onIconTap();
        else playTrack(track);
    });
}

function fillProfiles(select) {
    const s = S();
    const profiles = ctx().extensionSettings?.connectionManager?.profiles || [];
    select.innerHTML = '<option value="">현재 연결 (지금 쓰는 모델)</option>'
        + profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('');
    select.value = profiles.some((p) => p.id === s.profileId) ? s.profileId : '';
}

// 설정이 바뀌면 프롬프트 지시문, 곡 카드, 빠른 답장 줄 아이콘을 맞춰 고친다.
function applySettings() {
    if (!S().enabled) {
        stopAll();
        closePanel();
    }
    document.body.classList.toggle('cbgm-show-x', S().enabled && S().cardRemove);
    updateInjection();
    scheduleCards();
    syncIcon();
    render();
}

function addSettingsDrawer() {
    const host = $id('extensions_settings2') || $id('extensions_settings');
    if (!host || $id('cbgm_settings')) return;
    const s = S();
    const box = document.createElement('div');
    box.id = 'cbgm_settings';
    box.className = 'cbgm-settings';
    box.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎵 Chat BGM</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p>최근 대화를 읽고 장면에 어울리는 곡을 골라 YouTube 공식 음원으로 틀어 줍니다.
                빠른 답장 줄의 <i class="fa-solid fa-music"></i> 를 누르면 재생·일시정지, 꾹 누르면(PC는 우클릭) 플레이어가 열립니다.</p>

                <label class="checkbox_label"><input type="checkbox" data-key="enabled"><span>사용</span></label>
                <div class="cbgm-row">
                    <div class="menu_button menu_button_icon" id="cbgm_open_btn"><i class="fa-solid fa-music"></i><span>플레이어 열기</span></div>
                    <div class="menu_button menu_button_icon" id="cbgm_now_btn"><i class="fa-solid fa-wand-magic-sparkles"></i><span>지금 추천받기</span></div>
                </div>

                <h4>장르</h4>
                <small>체크한 장르 안에서만 추천합니다.</small>
                <div class="cbgm-genres">
                    ${GENRES.map((g) => `<label class="checkbox_label"><input type="checkbox" data-genre="${g.id}"><span>${esc(g.label)}</span></label>`).join('')}
                </div>
                <div class="cbgm-row">
                    <div class="menu_button" id="cbgm_genre_all">모두 선택</div>
                    <div class="menu_button" id="cbgm_genre_none">모두 해제</div>
                </div>
                <label for="cbgm_custom">직접 적는 장르 (쉼표로 구분)</label>
                <input type="text" class="text_pole" id="cbgm_custom" data-key="customGenres" placeholder="예: 보사노바, 트로트, 포스트록">
                <label class="checkbox_label"><input type="checkbox" data-key="instrumentalOnly"><span>가사 없는 연주곡만</span></label>

                <h4>YouTube</h4>
                <label for="cbgm_key">YouTube Data API v3 키</label>
                <input type="password" class="text_pole" id="cbgm_key" data-key="apiKey" autocomplete="off" placeholder="AIza…">
                <small>Google Cloud 콘솔에서 YouTube Data API v3를 사용 설정하고 API 키를 만들어 넣습니다.
                검색 한 번에 할당량 100을 쓰며 기본 한도는 하루 10,000(약 100곡)입니다. 한 번 찾은 곡은 기억해 두고 다시 검색하지 않습니다.</small>
                <label class="checkbox_label"><input type="checkbox" data-key="officialOnly"><span>공식 음원·공식 채널 영상만 재생 (못 찾으면 다음 후보로)</span></label>

                <h4>추천</h4>
                <label for="cbgm_profile">분석에 쓸 연결</label>
                <select class="text_pole" id="cbgm_profile"></select>
                <small>추천받을 때마다 모델을 한 번 부릅니다. 값싼 모델의 연결 프로필을 골라 두면 좋습니다.</small>
                <label class="checkbox_label"><input type="checkbox" data-key="auto"><span>음악이 나오는 동안 캐릭터 답장 <input type="number" class="text_pole cbgm-num" data-key="autoEvery" min="1" max="99">개마다 장면을 다시 읽기</span></label>
                <label class="checkbox_label"><input type="checkbox" data-key="switchNow"><span>새 곡이 정해지면 듣던 곡을 끊고 바로 바꾸기 (끄면 곡이 끝난 뒤 바꿈)</span></label>
                <label for="cbgm_repeat">곡이 끝나면</label>
                <select class="text_pole" id="cbgm_repeat" data-key="repeat">
                    <option value="off">다음 추천곡으로</option>
                    <option value="one">한 곡 반복</option>
                    <option value="star">★ 곡들 반복</option>
                </select>
                <div class="cbgm-row cbgm-nums">
                    <label>읽을 메시지 수 <input type="number" class="text_pole cbgm-num" data-key="contextMessages" min="2" max="40"></label>
                    <label>한 번에 받을 후보 <input type="number" class="text_pole cbgm-num" data-key="candidates" min="1" max="8"></label>
                </div>

                <h4>곡 카드</h4>
                <label class="checkbox_label"><input type="checkbox" data-key="card"><span>답장에 곡 카드 넣기</span></label>
                <small>답장을 쓰는 모델이 장면에 맞는 곡을 하나 골라 답장 끝에 적고, 그 메시지 맨 위에 곡 카드를 그립니다.
                추천용 호출이 따로 들지 않는 대신 매 답장 프롬프트에 지시문과 장르 목록이 추가됩니다. 체크한 장르에서 벗어난 곡은 카드로 그리지 않습니다.</small>
                <label for="cbgm_card_style">카드 모양</label>
                <select class="text_pole" id="cbgm_card_style" data-key="cardStyle">
                    ${Object.entries(CARD_STYLES).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}
                </select>
                <label class="checkbox_label"><input type="checkbox" data-key="cardAutoPlay"><span>카드가 붙은 답장이 오면 그 곡을 자동으로 틀기 (끄면 카드를 눌렀을 때만)</span></label>
                <label class="checkbox_label"><input type="checkbox" data-key="cardOnPick"><span>메시지의 <i class="fa-solid fa-music"></i> 단추로 추천받은 곡을 그 메시지에 카드로 남기기</span></label>
                <label class="checkbox_label"><input type="checkbox" data-key="cardRemove"><span>카드에 삭제(✕) 버튼 보기</span></label>
                <small>끄면 메시지를 편집해 <code>&lt;bgm …&gt;</code> 줄을 지워 카드를 뗍니다.
                <i class="fa-solid fa-music"></i> 단추로 붙인 카드는 본문에 적히지 않으므로 이 옵션을 켜야 뗄 수 있습니다.</small>

                <div class="cbgm-row">
                    <div class="menu_button" id="cbgm_clear_btn">재생 기록·검색 기억 지우기</div>
                </div>
            </div>
        </div>`;
    host.appendChild(box);

    box.querySelectorAll('[data-key]').forEach((input) => {
        const key = input.dataset.key;
        if (input.type === 'checkbox') input.checked = !!s[key];
        else input.value = String(s[key]);
        input.addEventListener(input.type === 'checkbox' || input.type === 'number' ? 'change' : 'input', () => {
            const cur = S();
            if (input.type === 'checkbox') cur[key] = input.checked;
            else if (input.type === 'number') {
                cur[key] = clamp(Math.round(Number(input.value) || DEFAULTS[key]), Number(input.min), Number(input.max));
                input.value = String(cur[key]);
            } else cur[key] = input.value.trim();
            save();
            applySettings();
        });
    });
    // 숫자 칸을 눌러도 감싼 체크박스가 바뀌지 않게 한다.
    box.querySelectorAll('.checkbox_label .cbgm-num').forEach((n) => n.addEventListener('click', (e) => e.preventDefault()));

    const genreBoxes = [...box.querySelectorAll('[data-genre]')];
    const syncGenres = () => genreBoxes.forEach((b) => { b.checked = S().genres.includes(b.dataset.genre); });
    const setGenres = (list) => { S().genres = list; save(); syncGenres(); applySettings(); };
    syncGenres();
    genreBoxes.forEach((b) => b.addEventListener('change', () => setGenres(genreBoxes.filter((x) => x.checked).map((x) => x.dataset.genre))));
    box.querySelector('#cbgm_genre_all').addEventListener('click', () => setGenres(GENRES.map((g) => g.id)));
    box.querySelector('#cbgm_genre_none').addEventListener('click', () => setGenres([]));

    const profile = box.querySelector('#cbgm_profile');
    fillProfiles(profile);
    profile.addEventListener('pointerdown', () => { const v = profile.value; fillProfiles(profile); profile.value = v; });
    profile.addEventListener('change', () => { S().profileId = profile.value; save(); });

    box.querySelector('#cbgm_open_btn').addEventListener('click', () => { if (S().enabled) openPanel(); });
    box.querySelector('#cbgm_now_btn').addEventListener('click', () => {
        if (!S().enabled) return toast('info', '먼저 "사용"을 켜 주세요.');
        openPanel();
        recommend({ manual: true });
    });
    box.querySelector('#cbgm_clear_btn').addEventListener('click', () => {
        const cur = S();
        clearHistory();
        cur.cache = {};
        save();
        render();
        toast('success', '재생 기록과 검색 기억을 지웠습니다. 별표를 단 곡은 남겨 두었습니다.');
    });
}

function bindEvents() {
    const { eventSource, eventTypes: E } = ctx();
    eventSource.on(E.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(E.CHAT_CHANGED, onChatChanged);
    if (E.GENERATION_STARTED) eventSource.on(E.GENERATION_STARTED, updateInjection);
    const redraw = [
        E.CHARACTER_MESSAGE_RENDERED, E.MESSAGE_SWIPED, E.MESSAGE_EDITED, E.MESSAGE_UPDATED,
        E.MESSAGE_DELETED, E.MORE_MESSAGES_LOADED,
    ].filter(Boolean);
    for (const ev of redraw) eventSource.on(ev, scheduleCards);
}

jQuery(() => {
    S();
    addMenuItem();
    addMessageButton();
    addSettingsDrawer();
    bindEvents();
    document.body.classList.toggle('cbgm-show-x', S().enabled && S().cardRemove);
    watchIconHost();
    watchChat();
    setInterval(renderCardProgress, 1000);
    updateInjection();
    scheduleCards();
});
