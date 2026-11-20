// tracker.js — сбор данных по ОДНОМУ подозрительному аккаунту (мошенник), чтобы передать их в заявление.
// Работает только для аккаунтов из списка наблюдения; про остальных игроков ничего не сохраняется.
//
// Админ-команды (только ты, в личке с ботом):
//   /watch 123456789 [заметка]     — поставить на наблюдение по Telegram id
//   /watch @username [заметка]     — по нику (при первом заходе id запомнится, смена ника не собьёт)
//   /unwatch 123456789 | @username — снять
//   /watchlist                     — кто на наблюдении и когда последний раз заходил
//   /watchexport 123456789         — файл со всей собранной историей этого игрока (для заявления)
//
// Когда наблюдаемый открывает мини-апп, тебе сразу приходит сообщение: что видит сервер (IP и заголовки), данные Telegram
// из подписанного initData и сведения об устройстве, которые присылает приложение (/api/hello).
//
// Что это НЕ даёт: если человек сидит через VPN/прокси, сервер видит адрес VPN, а не его настоящий. Настоящий адрес
// сервер узнать не может. С VPN помогает другое: Telegram id, ник, повторяющиеся устройство/часовой пояс/язык/версия
// Telegram, время активности. Запросы к Telegram и к провайдеру VPN делает правоохранительный орган, а не ты.
// Какой заголовок с IP считать настоящим, зависит от хостинга, поэтому в отчёт попадают ВСЕ (см. ipHeaders).
'use strict';
const http = require('http');

module.exports = function init(deps) {
    const { bot, adminId, fs, path, dir } = deps;
    const LIST_FILE = path.join(dir, 'watchlist.json');
    const LOG_FILE = path.join(dir, 'tracker-log.jsonl');
    const ALL_LOG_FILE = path.join(dir, 'tracker-all-log.jsonl');   // журнал тестового режима «все» (для /watchallexport)
    const MAX_LOG_BYTES = 5 * 1024 * 1024;
    const ALL_COOLDOWN_MS = 20 * 1000;        // один файл на игрока за один заход (повторные api-вызовы в те же 20с не дублируют)
    const ALL_MAX_PER_HOUR = 600;             // предохранитель от потока файлов, если игроков много
    const allLast = new Map();
    let allHour = { start: Date.now(), n: 0 };
    const REALERT_MS = 30 * 60 * 1000;                       // повторное сообщение не чаще раза в 30 минут, если ничего не изменилось
    const IPLOOKUP = process.env.TRACKER_IPLOOKUP === '1';   // по умолчанию IP третьим лицам не отправляем

    let list = null;                                         // { ids: {id:{note,addedAt}}, names: {name:{note,addedAt}} }
    const last = new Map();                                  // uid -> { t, ip, ua, devFp }
    const geoCache = new Map();

    function load() {
        if (list) return list;
        try { list = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')); } catch (e) { list = {}; }
        list.ids = list.ids || {}; list.names = list.names || {};
        return list;
    }
    function save() { try { fs.writeFileSync(LIST_FILE, JSON.stringify(load(), null, 1), 'utf8'); } catch (e) { console.error('tracker save:', e.message); } }
    function setAllMode(on) { load().allMode = !!on; save(); }
    function isAllMode() { return !!load().allMode; }
    const pad = (x) => String(x).padStart(2, '0');
    function iso(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`; }
    const cut = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

    function matchWatched(user) {
        const L = load(), id = String(user.id);
        if (L.ids[id]) return { key: id, note: L.ids[id].note };
        const un = String(user.username || '').toLowerCase();
        if (un && L.names[un]) {                              // нашли по нику -> запоминаем id
            L.ids[id] = { note: L.names[un].note, addedAt: L.names[un].addedAt, viaName: un };
            delete L.names[un]; save();
            return { key: id, note: L.ids[id].note, resolved: true };
        }
        return null;
    }

    // ---------- что видит сервер ----------
    const IP_HEADERS = ['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-forwarded-for', 'forwarded', 'via', 'x-render-origin-server'];
    const SKIP_HEADERS = new Set(['cookie', 'authorization']);   // в свой же лог их писать незачем и небезопасно хранить
    function allHeaders(req) {
        const h = req.headers || {}, out = {};
        for (const k of Object.keys(h)) { if (SKIP_HEADERS.has(k)) continue; out[k] = cut(h[k], 300); }
        return out;
    }
    function netInfo(req) {
        const h = req.headers || {};
        const ipHeaders = {};
        for (const k of IP_HEADERS) if (h[k]) ipHeaders[k] = cut(h[k], 200);
        const sock = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress).replace(/^::ffff:/, '') : '';
        // «лучшее предположение»: заголовок CDN, иначе первый адрес из x-forwarded-for, иначе адрес сокета
        let best = '';
        if (h['cf-connecting-ip']) best = String(h['cf-connecting-ip']).trim();
        else if (h['x-forwarded-for']) best = String(h['x-forwarded-for']).split(',')[0].trim();
        else best = sock;
        return {
            ip: cut(best, 64), socketIp: cut(sock, 64), ipHeaders,
            ua: cut(h['user-agent'], 300), lang: cut(h['accept-language'], 100),
            origin: cut(h['origin'] || h['referer'], 200),
            ch: { ua: cut(h['sec-ch-ua'], 160), platform: cut(h['sec-ch-ua-platform'], 40), mobile: cut(h['sec-ch-ua-mobile'], 10), model: cut(h['sec-ch-ua-model'], 60) },
            headers: allHeaders(req),
        };
    }
    function initInfo(initData) {                            // данные Telegram из уже проверенной подписи (кроме подписи)
        const out = {};
        try {
            const p = new URLSearchParams(String(initData || ''));
            for (const k of ['auth_date', 'chat_type', 'chat_instance', 'start_param', 'can_send_after']) if (p.get(k)) out[k] = cut(p.get(k), 80);
            if (out.auth_date) out.auth_date_utc = iso(Number(out.auth_date) * 1000);
        } catch (e) { /* пусто */ }
        return out;
    }
    function cleanDev(d) {                                   // сведения об устройстве из приложения: только известные поля, ограниченной длины
        if (!d || typeof d !== 'object') return null;
        const o = {};
        const put = (k, v) => { if (v !== undefined && v !== null && v !== '') o[k] = typeof v === 'number' ? v : (Array.isArray(v) ? v.slice(0, 6).map((x) => cut(x, 20)) : cut(v, 160)); };
        for (const k of ['ua', 'plat', 'lang', 'langs', 'tz', 'tzo', 'scr', 'hc', 'dm', 'tp', 'cs', 'conn', 'tgPlat', 'tgVer', 'tgScheme', 'vp', 'dpr', 'webglV', 'webglR', 'lsId', 'canvasFp', 'webrtc', 'battery', 'touch', 'cookieOn', 'refUrl']) put(k, d[k]);
        return Object.keys(o).length ? o : null;
    }
    function devFp(dev) {
        if (!dev) return '';
        return require('crypto').createHash('sha1').update(JSON.stringify([dev.ua, dev.plat, dev.tz, dev.scr, dev.hc, dev.dm, dev.tp, dev.tgPlat, dev.tgVer, dev.webglR])).digest('hex').slice(0, 12);
    }

    // ---------- необязательно: страна/провайдер/признак VPN по IP ----------
    function geo(ip) {
        if (!IPLOOKUP || !ip) return Promise.resolve(null);
        if (geoCache.has(ip)) return Promise.resolve(geoCache.get(ip));
        return new Promise((resolve) => {
            const rq = http.get({ host: 'ip-api.com', path: `/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,isp,org,as,mobile,proxy,hosting`, timeout: 4000 }, (res) => {
                let b = ''; res.on('data', (c) => { b += c; if (b.length > 4000) rq.destroy(); });
                res.on('end', () => { try { const j = JSON.parse(b); const r = j.status === 'success' ? j : null; geoCache.set(ip, r); resolve(r); } catch (e) { resolve(null); } });
            });
            rq.on('timeout', () => { rq.destroy(); resolve(null); });
            rq.on('error', () => resolve(null));
        });
    }

    // ---------- журнал ----------
    function appendLog(entry) {
        try {
            try { if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) { const txt = fs.readFileSync(LOG_FILE, 'utf8'); fs.writeFileSync(LOG_FILE, txt.slice(Math.floor(txt.length / 2)).replace(/^[^\n]*\n/, ''), 'utf8'); } } catch (e) { /* файла ещё нет */ }
            fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
        } catch (e) { console.error('tracker log:', e.message); }
    }
    function appendAllLog(entry) {
        try {
            try { if (fs.statSync(ALL_LOG_FILE).size > MAX_LOG_BYTES) { const txt = fs.readFileSync(ALL_LOG_FILE, 'utf8'); fs.writeFileSync(ALL_LOG_FILE, txt.slice(Math.floor(txt.length / 2)).replace(/^[^\n]*\n/, ''), 'utf8'); } } catch (e) { /* файла ещё нет */ }
            fs.appendFileSync(ALL_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
        } catch (e) { console.error('tracker all-log:', e.message); }
    }
    function readLog(uid) {
        const rows = [];
        try {
            for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
                if (!line) continue;
                try { const e = JSON.parse(line); if (String(e.uid) === String(uid)) rows.push(e); } catch (e2) { /* битая строка */ }
            }
        } catch (e) { /* пусто */ }
        return rows;
    }

    // ---------- отчёты ----------
    function userBlock(u, w) {
        const L = [];
        L.push(`Telegram id: ${u.id}`);
        L.push(`ник: ${u.username ? '@' + u.username : '—'}   имя: ${[u.first_name, u.last_name].filter(Boolean).join(' ') || '—'}`);
        L.push(`язык Telegram: ${u.language_code || '—'}   Premium: ${u.is_premium ? 'да' : 'нет'}   писать в ЛС разрешено: ${u.allows_write_to_pm ? 'да' : 'нет'}`);
        if (u.photo_url) L.push(`фото: ${cut(u.photo_url, 200)}`);
        if (w && w.note) L.push(`заметка: ${w.note}`);
        return L;
    }
    function fmtGeo(g) { return g ? `${g.country || '?'}, ${g.regionName || ''} ${g.city || ''}; провайдер: ${g.isp || '?'} / ${g.org || '?'} / ${g.as || '?'}; мобильная сеть: ${g.mobile ? 'да' : 'нет'}; прокси/VPN: ${g.proxy ? 'да' : 'нет'}; дата-центр: ${g.hosting ? 'да' : 'нет'}` : null; }
    function fmtEntry(e, g) {
        const L = [];
        L.push(`время: ${iso(e.t)}   запрос: ${e.url}`);
        L.push(`IP (лучшее предположение): ${e.net.ip || '—'}   адрес сокета: ${e.net.socketIp || '—'}`);
        const hk = Object.keys(e.net.ipHeaders || {});
        if (hk.length) L.push('заголовки с адресами: ' + hk.map((k) => `${k}=${e.net.ipHeaders[k]}`).join(' | '));
        if (e.net.headers) L.push('все заголовки запроса: ' + Object.keys(e.net.headers).map((k) => `${k}=${e.net.headers[k]}`).join(' | '));
        const gg = fmtGeo(g); if (gg) L.push(`по IP: ${gg}`);
        L.push(`User-Agent: ${e.net.ua || '—'}`);
        L.push(`Accept-Language: ${e.net.lang || '—'}`);
        const ch = e.net.ch || {}; if (ch.ua || ch.platform || ch.model) L.push(`Client Hints: ${[ch.ua, ch.platform, ch.model, ch.mobile].filter(Boolean).join(' ')}`);
        if (e.init && Object.keys(e.init).length) L.push('данные запуска Telegram: ' + Object.keys(e.init).map((k) => `${k}=${e.init[k]}`).join(' '));
        if (e.dev) L.push('устройство (из приложения): ' + Object.keys(e.dev).map((k) => `${k}=${Array.isArray(e.dev[k]) ? e.dev[k].join('/') : e.dev[k]}`).join('  '));
        return L;
    }
    async function notify(text) {
        try { await bot.sendMessage(adminId, text.slice(0, 3900)); } catch (e) { console.error('tracker notify:', e.message); }
    }

    async function onRequest(user, req, payload) {
        try {
            if (!user || !user.id) return;
            const w = matchWatched(user);
            if (!w) return;
            const t = Date.now();
            const dev = cleanDev(payload && payload.dev);
            const entry = { t, uid: String(user.id), un: user.username || '', url: cut(req.url, 60), net: netInfo(req), init: initInfo(payload && payload.initData), dev: dev || undefined };
            appendLog(entry);
            const prev = last.get(entry.uid);
            const fp = devFp(dev);
            const changed = !prev || prev.ip !== entry.net.ip || prev.ua !== entry.net.ua || (fp && prev.fp !== fp);
            const stale = !prev || t - prev.t > REALERT_MS;
            const isHello = String(req.url || '').indexOf('/api/hello') === 0;
            last.set(entry.uid, { t: (changed || stale) ? t : prev.t, ip: entry.net.ip, ua: entry.net.ua, fp: fp || (prev && prev.fp) || '' });
            if (!(changed || stale || (isHello && dev && (!prev || !prev.fp)))) return;
            const g = await geo(entry.net.ip);
            const head = !prev ? '🔎 Наблюдаемый аккаунт открыл мини-апп' : (prev.ip !== entry.net.ip ? '🔎 Наблюдаемый: сменился IP' : '🔎 Наблюдаемый снова в сети');
            await notify([head, '', ...userBlock(user, w), '', ...fmtEntry(entry, g)].join('\n'));
        } catch (e) { console.error('tracker error:', e.message); }
    }

    function exportText(uid) {
        const rows = readLog(uid), L = [];
        const w = load().ids[String(uid)];
        L.push('CROWN CASINO — СВОДКА ПО НАБЛЮДАЕМОМУ АККАУНТУ');
        L.push(`сформирована: ${iso(Date.now())}`);
        L.push(`Telegram id: ${uid}${w && w.note ? `   заметка: ${w.note}` : ''}`);
        L.push(`записей: ${rows.length}${rows.length ? `   первая: ${iso(rows[0].t)}   последняя: ${iso(rows[rows.length - 1].t)}` : ''}`);
        L.push('Все времена в UTC. IP — тот, что видел сервер; при VPN/прокси это адрес VPN, не настоящий.');
        L.push('');
        const ips = new Map(), uas = new Map(), devs = new Map(), names = new Set();
        for (const e of rows) {
            const a = ips.get(e.net.ip) || { n: 0, first: e.t, last: e.t }; a.n++; a.last = e.t; ips.set(e.net.ip, a);
            const b = uas.get(e.net.ua) || { n: 0 }; b.n++; uas.set(e.net.ua, b);
            if (e.dev) { const f = devFp(e.dev), c = devs.get(f) || { n: 0, dev: e.dev, first: e.t, last: e.t }; c.n++; c.last = e.t; devs.set(f, c); }
            if (e.un) names.add('@' + e.un);
        }
        L.push('== НИКИ, С КОТОРЫМИ ЗАХОДИЛ =='); L.push([...names].join(', ') || '—'); L.push('');
        L.push('== АДРЕСА (IP): сколько раз, первый и последний заход =='); [...ips.entries()].sort((x, y) => y[1].n - x[1].n).forEach(([ip, v]) => L.push(`${ip || '—'}   ×${v.n}   ${iso(v.first)} — ${iso(v.last)}`)); L.push('');
        L.push('== УСТРОЙСТВА (по данным приложения) =='); if (!devs.size) L.push('—'); devs.forEach((v, f) => L.push(`[${f}] ×${v.n}  ${iso(v.first)} — ${iso(v.last)}\n   ` + Object.keys(v.dev).map((k) => `${k}=${Array.isArray(v.dev[k]) ? v.dev[k].join('/') : v.dev[k]}`).join('  '))); L.push('');
        L.push('== USER-AGENT =='); [...uas.entries()].forEach(([ua, v]) => L.push(`×${v.n}  ${ua}`)); L.push('');
        L.push('== ВСЕ ЗАПИСИ (от старых к новым) ==');
        rows.forEach((e) => { L.push(''); fmtEntry(e, null).forEach((x) => L.push(x)); });
        return L.join('\n');
    }

    // ---------- тестовый режим: файл на КАЖДЫЙ запуск, от КАЖДОГО игрока ----------
    async function onHello(user, req, payload) {
        try {
            if (!user || !user.id) return;
            if (String(user.id) === String(adminId)) return;   // себя не трогаем
            const watched = matchWatched(user);                // параллельно продолжает работать точечное наблюдение (сообщением, как и раньше)
            if (watched) await onRequest(user, req, payload);
            if (!isAllMode()) return;
            const t = Date.now();
            const dev = cleanDev(payload && payload.dev);
            const entry = { t, uid: String(user.id), un: user.username || '', url: cut(req.url, 60), net: netInfo(req), init: initInfo(payload && payload.initData), dev: dev || undefined, user: { username: user.username || '', first_name: user.first_name || '', last_name: user.last_name || '', language_code: user.language_code || '', is_premium: !!user.is_premium } };
            if (isAllMode()) {
                appendAllLog(entry);
                const key = entry.uid;
                const last1 = allLast.get(key) || 0;
                if (t - last1 < ALL_COOLDOWN_MS) return;          // тот же запуск, несколько вызовов подряд — не дублируем
                if (t - allHour.start > 3600 * 1000) { allHour = { start: t, n: 0 }; }
                if (allHour.n >= ALL_MAX_PER_HOUR) return;        // предохранитель: иначе при наплыве игроков зальёт личку файлами
                allLast.set(key, t); allHour.n += 1;
                const g = await geo(entry.net.ip);
                const text = [
                    'CROWN CASINO — ТЕСТОВЫЙ РЕЖИМ: ЗАПУСК ПРИЛОЖЕНИЯ', '',
                    ...userBlock(user, watched), '', ...fmtEntry(entry, g),
                ].join('\n');
                try { await bot.sendDocument(adminId, Buffer.from(text, 'utf8'), { caption: `Запуск: ${user.username ? '@' + user.username : (user.first_name || 'игрок')} (id ${user.id})` }, { filename: `hello_${user.id}_${Math.floor(t / 1000)}.txt`, contentType: 'text/plain' }); }
                catch (e) { console.error('tracker all-mode send:', e.message); }
            }
        } catch (e) { console.error('tracker onHello:', e.message); }
    }

    // ---------- команды админа ----------
    function parseTarget(arg) {
        arg = String(arg || '').trim();
        if (/^\d{3,20}$/.test(arg)) return { id: arg };
        const m = arg.match(/^@?([A-Za-z0-9_]{4,32})$/);
        return m ? { name: m[1].toLowerCase() } : null;
    }
    bot.on('message', async (msg) => {
        try {
            if (!msg || typeof msg.text !== 'string' || !msg.chat || msg.chat.type !== 'private') return;
            if (String(msg.from && msg.from.id) !== String(adminId)) return;
            const mAll = msg.text.trim().match(/^\/watchall(?:@\w+)?(?:\s+(on|off|status))?\s*$/i);
            if (mAll) {
                const arg = (mAll[1] || 'status').toLowerCase();
                if (arg === 'on') { setAllMode(true); await bot.sendMessage(msg.chat.id, '⚠️ Тестовый режим включён: файл с данными будет приходить при запуске приложения от КАЖДОГО игрока. Для разовой проверки — выключи потом командой /watchall off.'); return; }
                if (arg === 'off') { setAllMode(false); await bot.sendMessage(msg.chat.id, 'Тестовый режим выключен. Точечное наблюдение (/watch) продолжает работать как обычно.'); return; }
                await bot.sendMessage(msg.chat.id, `Тестовый режим сейчас: ${isAllMode() ? 'включён' : 'выключен'}.\n/watchall on — включить (файл при КАЖДОМ запуске у всех)\n/watchall off — выключить`); return;
            }
            const m = msg.text.trim().match(/^\/(watch|unwatch|watchlist|watchexport)(?:@\w+)?(?:\s+(\S+))?(?:\s+([\s\S]+))?$/i);
            if (!m) return;
            const cmd = m[1].toLowerCase(), arg = m[2], note = cut(m[3] || '', 200), L = load(), reply = (t) => bot.sendMessage(msg.chat.id, t);
            if (cmd === 'watchlist') {
                const lines = [];
                for (const [id, v] of Object.entries(L.ids)) { const l = last.get(id); lines.push(`id ${id}${v.note ? ' — ' + v.note : ''}${l ? `  (в этом запуске заходил: ${iso(l.t)})` : ''}`); }
                for (const [n, v] of Object.entries(L.names)) lines.push(`@${n}${v.note ? ' — ' + v.note : ''}  (id ещё не известен)`);
                await reply(lines.length ? 'На наблюдении:\n' + lines.join('\n') : 'Список наблюдения пуст. Добавить: /watch 123456789 заметка'); return;
            }
            const tg = parseTarget(arg);
            if (!tg) { await reply('Нужно указать Telegram id или @ник.\n/watch 123456789 заметка\n/unwatch @ник\n/watchexport 123456789'); return; }
            if (cmd === 'watch') {
                if (tg.id) L.ids[tg.id] = { note, addedAt: Date.now() }; else L.names[tg.name] = { note, addedAt: Date.now() };
                save(); await reply(`Поставил на наблюдение: ${tg.id ? 'id ' + tg.id : '@' + tg.name}. Когда он откроет мини-апп, придёт сообщение с данными.`); return;
            }
            if (cmd === 'unwatch') {
                let had = false;
                if (tg.id) { had = !!L.ids[tg.id]; delete L.ids[tg.id]; } else { had = !!L.names[tg.name]; delete L.names[tg.name]; for (const [id, v] of Object.entries(L.ids)) if (v.viaName === tg.name) { delete L.ids[id]; had = true; } }
                save(); await reply(had ? 'Снял с наблюдения. Уже собранные записи остались в файле.' : 'Такого в списке нет.'); return;
            }
            if (cmd === 'watchexport') {
                if (!tg.id) { await reply('Для выгрузки нужен числовой Telegram id.'); return; }
                await bot.sendDocument(msg.chat.id, Buffer.from(exportText(tg.id), 'utf8'), { caption: `Сводка по id ${tg.id}` }, { filename: `watch_${tg.id}_${Math.floor(Date.now() / 1000)}.txt`, contentType: 'text/plain' });
            }
        } catch (e) { console.error('tracker command:', e.message); }
    });

    return { onRequest, onHello, exportText, isAllMode, setAllMode, _load: load, _reset: () => { list = null; last.clear(); allLast.clear(); } };
};
