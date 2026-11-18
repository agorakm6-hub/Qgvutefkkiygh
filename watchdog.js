// watchdog.js — разбор крупных скачков баланса.
// Когда игрок присылает баланс, который вырос на очень большую сумму (по умолчанию от 1 000 000 000 зиксов),
// бот сразу шлёт админу .txt-файл с тем, что игрок делал ДО этого: журнал действий из клиента, запросы к серверу,
// историю присланных балансов и подсказки, что похоже на причину. Игра при этом не обязательна: файл придёт и для «баланс взялся из воздуха».
//
// Подключение (server.js):
//   watchdogApi = require('./watchdog')({ bot, adminId, loadUsers, loadBank, loadWalletPending, getUserLanguage });
//   watchdogApi.trace(userId, url, payload)                 — на каждый API-запрос (делается в readBody)
//   watchdogApi.onBalanceReport({ user, prev, prevTs, coins, clientLog }) — в /api/report-balance ДО записи нового баланса
//
// Порог: переменная окружения BIGWIN_THRESHOLD (число зиксов, по умолчанию 1e9).
// Ограничения: след хранится в памяти (после перезапуска сервера пропадает), журнал клиента игрок может подделать или не прислать —
// отсутствие журнала тоже отмечается в файле.
'use strict';

module.exports = function init(deps) {
    const { bot, adminId, loadUsers, loadBank, loadWalletPending, getUserLanguage } = deps;
    const BIG = Number(process.env.BIGWIN_THRESHOLD) > 0 ? Number(process.env.BIGWIN_THRESHOLD) : 1e9;
    const COOLDOWN_MS = 5 * 60 * 1000;       // не чаще одного файла на игрока раз в 5 минут
    const MAX_PER_HOUR = 30;                 // общий предохранитель от потока файлов
    const MAX_USERS = 3000;

    const trails = new Map();                // uid -> { req: [], reports: [], client: [], lastAlert }
    let hourStart = Date.now(), hourCount = 0;

    function rec(uid) {
        const k = String(uid);
        let r = trails.get(k);
        if (!r) {
            r = { req: [], reports: [], client: [], lastAlert: 0 };
            trails.set(k, r);
            if (trails.size > MAX_USERS) trails.delete(trails.keys().next().value);
        }
        return r;
    }

    // ---- запросы к серверу (без initData и без самого журнала) ----
    function trace(uid, url, payload) {
        try {
            const r = rec(uid);
            let s = '';
            if (payload && typeof payload === 'object') {
                const c = Object.assign({}, payload); delete c.initData; delete c.log;
                s = JSON.stringify(c);
                if (s.length > 160) s = s.slice(0, 160) + '…';
                if (s === '{}') s = '';
            }
            r.req.push({ t: Date.now(), u: String(url || '').slice(0, 60), s });
            if (r.req.length > 100) r.req.splice(0, r.req.length - 100);
        } catch (e) { /* пусто */ }
    }

    // ---- журнал клиента: чистим (не доверяем) и склеиваем с прошлыми, чтобы старое не терялось ----
    function cleanLog(log) {
        if (!Array.isArray(log)) return null;
        const out = [];
        for (const e of log.slice(-200)) {
            if (!e || typeof e !== 'object' || typeof e.k !== 'string') continue;
            const c = {};
            for (const key of Object.keys(e).slice(0, 12)) {
                const v = e[key];
                const kk = String(key).slice(0, 12);
                if (typeof v === 'number' && isFinite(v)) c[kk] = v;
                else if (typeof v === 'string') c[kk] = v.slice(0, 80);
                else if (typeof v === 'boolean') c[kk] = v;
            }
            c.k = String(e.k).slice(0, 24);
            if (typeof c.t !== 'number') c.t = 0;
            out.push(c);
        }
        return out;
    }
    function mergeClient(r, log) {
        const seen = new Set(r.client.map((e) => JSON.stringify(e)));
        for (const e of log) { const k = JSON.stringify(e); if (!seen.has(k)) { r.client.push(e); seen.add(k); } }
        r.client.sort((a, b) => a.t - b.t);
        if (r.client.length > 400) r.client.splice(0, r.client.length - 400);
    }

    // ---- форматирование ----
    const pad = (x, n = 2) => String(x).padStart(n, '0');
    function iso(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; }
    function hms(ts) { const d = new Date(ts); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`; }
    function num(n) {
        n = Number(n);
        if (!isFinite(n)) return String(n);
        if (Math.abs(n) < 1e15) return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
        return n.toExponential(3).replace('e+', 'e');
    }
    function ago(ms) { const s = Math.round(ms / 1000); if (s < 90) return `${s} с`; const m = Math.round(s / 60); if (m < 120) return `${m} мин`; return `${(m / 60).toFixed(1)} ч`; }
    function detail(e) {
        const parts = [];
        for (const k of Object.keys(e)) {
            if (k === 't' || k === 'k') continue;
            const v = e[k];
            parts.push(`${k}=${typeof v === 'number' ? num(v) : v}`);
        }
        return parts.join('  ');
    }

    // ---- подсказки: что видно по следу ----
    function hints(r, ctx) {
        const out = [];
        const log = r.client;
        const before = log.filter((e) => e.t && e.t <= ctx.now);
        if (!ctx.hasLog) out.push('Клиент НЕ прислал журнал с этим балансом: либо старая версия приложения, либо баланс отправлен напрямую на /api/report-balance в обход приложения.');
        const tamper = before.filter((e) => e.k === 'TAMPER' || e.k === 'TAMPER_START');
        tamper.slice(-5).forEach((e) => out.push(`ПРАВКА БАЛАНСА В ОБХОД ИГРЫ (${e.k}) в ${hms(e.t)}: ${detail(e)}. Баланс менялся не через addCoins/spendCoins/банк/переводы (консоль, редактирование localStorage или подмена кода).`));
        const adm = before.filter((e) => e.k === 'admin_panel_open' || e.k === 'admin_gen');
        adm.slice(-6).forEach((e) => out.push(`Админ-панель в клиенте: ${e.k} в ${hms(e.t)} ${detail(e)}. Панель и генерация кодов работают целиком на стороне клиента, любой игрок может её открыть долгим нажатием на вкладку промокода.`));
        const promos = before.filter((e) => e.k === 'promo');
        if (promos.length) out.push(`Промокоды, которые вводил игрок: ${promos.slice(-8).map((e) => `${e.c}@${hms(e.t)}`).join(', ')}`);
        const adds = before.filter((e) => e.k === 'add' && typeof e.n === 'number').sort((a, b) => b.n - a.n).slice(0, 5);
        adds.forEach((e, i) => { if (i === 0 || e.n >= BIG / 10) out.push(`Крупное начисление: +${num(e.n)} в ${hms(e.t)}, вызвано из: ${e.f || '?'}`); });
        const win10 = before.filter((e) => e.t >= ctx.now - 10 * 60 * 1000);
        const spends = win10.filter((e) => e.k === 'spend').length, wins = win10.filter((e) => e.k === 'win').length;
        out.push(`За 10 минут до отчёта в журнале: ставок ${spends}, побед ${wins}, запросов к серверу ${r.req.filter((q) => q.t >= ctx.now - 10 * 60 * 1000).length}.`);
        if (ctx.hasLog && !tamper.length && !adm.length && !adds.length) out.push('В журнале нет события, которое объясняет скачок: баланс, вероятно, выставлен в обход кода игры или журнал был очищен.');
        return out;
    }

    function buildReport(user, ctx) {
        const uid = String(user.id), r = rec(uid);
        const us = (loadUsers() || {})[uid] || {};
        const bank = (loadBank() || {})[uid];
        const wallet = (loadWalletPending() || {})[uid];
        const L = [];
        L.push('CROWN CASINO — КРУПНЫЙ СКАЧОК БАЛАНСА');
        L.push(`Время отчёта (UTC): ${iso(ctx.now)}`);
        L.push(`Порог: ${num(BIG)} зиксов за одно сообщение баланса (BIGWIN_THRESHOLD)`);
        L.push('');
        L.push('== ИГРОК ==');
        L.push(`id: ${uid}`);
        L.push(`имя: ${us.name || [user.first_name, user.last_name].filter(Boolean).join(' ') || '—'}   @${user.username || us.username || '—'}   язык: ${getUserLanguage(uid) || user.language_code || '—'}`);
        L.push('');
        L.push('== БАЛАНС ==');
        L.push(ctx.prev === null ? 'раньше сервер баланса этого игрока не знал (первое сообщение)' : `был известен серверу: ${num(ctx.prev)}  (${ctx.prevTs ? ago(ctx.now - ctx.prevTs) + ' назад' : 'время неизвестно'})`);
        L.push(`прислан сейчас:       ${num(ctx.coins)}  (${ctx.coins.toExponential(3)})`);
        L.push(`прирост:              +${num(ctx.delta)}${ctx.prev > 0 ? `   (×${(ctx.coins / ctx.prev).toExponential(2)} к прошлому)` : ''}`);
        L.push('');
        L.push('== ЧТО ПОХОЖЕ НА ПРИЧИНУ (автоматические подсказки, это предположения) ==');
        hints(r, ctx).forEach((h) => L.push(`- ${h}`));
        L.push('');
        L.push(`== ЖУРНАЛ ДЕЙСТВИЙ ИЗ КЛИЕНТА (${r.client.length} записей, от старых к новым; времена по часам устройства, UTC) ==`);
        L.push('add=начисление, spend=трата, bank=банк, promo=ввод кода, win=победа, api=запрос в банк, TAMPER=правка в обход игры');
        if (!r.client.length) L.push('(пусто)');
        r.client.forEach((e) => L.push(`${e.t ? hms(e.t) : '--:--:--'}  ${e.k.padEnd(16)} ${detail(e)}`));
        L.push('');
        L.push(`== ЗАПРОСЫ К СЕРВЕРУ ОТ ЭТОГО ИГРОКА (последние ${r.req.length}) ==`);
        if (!r.req.length) L.push('(сервер не видел запросов от него с момента последнего запуска: возможно, сервер перезапускался)');
        r.req.forEach((q) => L.push(`${hms(q.t)}  ${q.u}${q.s ? '  ' + q.s : ''}`));
        L.push('');
        L.push(`== ИСТОРИЯ ПРИСЛАННЫХ БАЛАНСОВ (последние ${r.reports.length}) ==`);
        r.reports.forEach((x) => L.push(`${hms(x.t)}  ${num(x.coins)}`));
        L.push('');
        L.push('== БАНК И ОТЛОЖЕННЫЕ ПЕРЕВОДЫ (из файлов сервера) ==');
        L.push(bank ? JSON.stringify(bank) : '(записи в банке нет)');
        L.push(wallet ? JSON.stringify(wallet) : '(отложенных переводов нет)');
        return L.join('\n');
    }

    // Вызывать ДО записи нового баланса: prev — то, что сервер знал раньше (null, если ничего)
    async function onBalanceReport(p) {
        try {
            const { user, prev, prevTs, coins } = p;
            if (!user || !user.id || !isFinite(coins)) return;
            const now = Date.now(), r = rec(user.id);
            r.reports.push({ t: now, coins });
            if (r.reports.length > 40) r.reports.splice(0, r.reports.length - 40);
            const log = cleanLog(p.clientLog);
            if (log) mergeClient(r, log);

            if (String(user.id) === String(adminId)) return;               // у админа баланс может быть любым
            const delta = prev === null || prev === undefined ? coins : coins - prev;
            if (!(delta >= BIG)) return;
            if (now - r.lastAlert < COOLDOWN_MS) return;
            if (now - hourStart > 3600 * 1000) { hourStart = now; hourCount = 0; }
            if (hourCount >= MAX_PER_HOUR) return;
            r.lastAlert = now; hourCount++;

            const ctx = { now, prev: prev === undefined ? null : prev, prevTs, coins, delta, hasLog: !!log && log.length > 0 };
            const text = buildReport(user, ctx);
            const nm = (user.username ? '@' + user.username : (user.first_name || 'игрок'));
            const caption = `⚠️ Крупный скачок баланса: ${nm} (id ${user.id})\n+${num(delta)} зиксов за одно обновление. Внутри — что он делал до этого.`;
            await bot.sendDocument(adminId, Buffer.from(text, 'utf8'), { caption }, { filename: `bigwin_${user.id}_${Math.floor(now / 1000)}.txt`, contentType: 'text/plain' });
        } catch (e) { console.error('watchdog error:', e.message); }
    }

    return { trace, onBalanceReport, _buildForTest: buildReport };
};
