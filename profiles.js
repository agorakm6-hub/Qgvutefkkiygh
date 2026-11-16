// ============================================================
//  profiles.js — Профиль 2.0, Genesis Pepe Coin, рейтинги, подарки.
//
//  • Монета Genesis: ровно 50 штук (#1…#50), купить нельзя. Весь запас с первого запуска у админа.
//    Дальше — только выдача админом (/coin give …) и розыгрыш: каждые 20 игроков одна монета
//    уходит случайному игроку (см. onNewUser).
//  • Профиль: титулы, рамки, фоны (открываются по достижениям или дарятся), карточка-картинка.
//  • Рейтинги: Crash / Flappy / крупнейший выигрыш / игры в чатах / ставки / богатые; неделя и всё время.
//    ВАЖНО: рекорды из Mini App присылает клиент (проверить их сервер не может) — в рейтингах они без галочки.
//    Игры в группах считает сам сервер — это «проверенный» рейтинг (с галочкой).
//  • Бот: профиль / топ / подарить / предметы (+ /profile /top /gift /items), админ: /coin.
//  • Инлайн: @бот profile  → карточка-картинка в любой чат.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const card = require('./profilecard');

const COIN_TOTAL = 50;
const MILESTONE_USERS = 20;            // каждые N игроков — одна монета случайному игроку
const DAY = 86400000;

// ---------------- КАТАЛОГ КОСМЕТИКИ ----------------
const ITEMS = {
    title: [
        { id: 'newbie', def: true, n: { ru: 'Новичок', ro: 'Începător', en: 'Rookie' } },
        { id: 'player', need: { k: 'bets', n: 50 }, n: { ru: 'Игрок', ro: 'Jucător', en: 'Player' } },
        { id: 'rocketeer', need: { k: 'crash', n: 5 }, n: { ru: 'Ракетчик', ro: 'Rachetar', en: 'Rocketeer' } },
        { id: 'legend', need: { k: 'crash', n: 50 }, n: { ru: 'Легенда Crash', ro: 'Legenda Crash', en: 'Crash Legend' } },
        { id: 'pilot', need: { k: 'flappy', n: 25 }, n: { ru: 'Пилот', ro: 'Pilot', en: 'Pilot' } },
        { id: 'whale', need: { k: 'win', n: 1e6 }, n: { ru: 'Кит', ro: 'Balenă', en: 'Whale' } },
        { id: 'chatking', need: { k: 'gwins', n: 25 }, n: { ru: 'Король чата', ro: 'Regele chatului', en: 'Chat King' } },
        { id: 'genesis', need: { k: 'coin' }, n: { ru: 'Genesis Holder', ro: 'Genesis Holder', en: 'Genesis Holder' } },
    ],
    frame: [
        { id: 'plain', def: true, n: { ru: 'Обычная', ro: 'Simplă', en: 'Plain' } },
        { id: 'green', need: { k: 'wins', n: 25 }, n: { ru: 'Зелёная', ro: 'Verde', en: 'Green' } },
        { id: 'gold', need: { k: 'win', n: 1e5 }, n: { ru: 'Золотая', ro: 'Aurie', en: 'Gold' } },
        { id: 'neon', need: { k: 'crash', n: 20 }, n: { ru: 'Неоновая', ro: 'Neon', en: 'Neon' } },
        { id: 'genesis', need: { k: 'coin' }, n: { ru: 'Genesis', ro: 'Genesis', en: 'Genesis' } },
    ],
    bg: [
        { id: 'classic', def: true, n: { ru: 'Классика', ro: 'Clasic', en: 'Classic' } },
        { id: 'pepe', need: { k: 'bets', n: 20 }, n: { ru: 'Пепе', ro: 'Pepe', en: 'Pepe' } },
        { id: 'space', need: { k: 'crash', n: 5 }, n: { ru: 'Космос', ro: 'Cosmos', en: 'Space' } },
        { id: 'sunset', need: { k: 'flappy', n: 10 }, n: { ru: 'Закат', ro: 'Apus', en: 'Sunset' } },
        { id: 'genesis', need: { k: 'coin' }, n: { ru: 'Genesis', ro: 'Genesis', en: 'Genesis' } },
    ],
};
const SLOTS = Object.keys(ITEMS);
const fmtShort = (n) => card.fmtShort ? card.fmtShort(n) : require('./profilecard_draw').fmtShort(n);

const HINT = {
    ru: { bets: (n) => `Сделай ${n} ставок`, wins: (n) => `Одержи ${n} побед`, crash: (n) => `Забери ×${n} в Crash`, flappy: (n) => `Набери ${n} очков во Flappy`, win: (n) => `Выиграй ${fmtShort(n)} за раз`, gwins: (n) => `${n} побед в играх чата`, coin: () => 'Нужна монета Genesis' },
    ro: { bets: (n) => `Fă ${n} pariuri`, wins: (n) => `Câștigă de ${n} ori`, crash: (n) => `Ia ×${n} în Crash`, flappy: (n) => `Fă ${n} puncte în Flappy`, win: (n) => `Câștigă ${fmtShort(n)} deodată`, gwins: (n) => `${n} victorii în jocurile din chat`, coin: () => 'Ai nevoie de moneda Genesis' },
    en: { bets: (n) => `Place ${n} bets`, wins: (n) => `Win ${n} times`, crash: (n) => `Cash out ×${n} in Crash`, flappy: (n) => `Score ${n} in Flappy`, win: (n) => `Win ${fmtShort(n)} at once`, gwins: (n) => `${n} wins in chat games`, coin: () => 'Genesis coin required' },
};
const BOARD_NAMES = {
    ru: { crash: 'Crash · лучший икс', flappy: 'Flappy · рекорд', win: 'Крупнейший выигрыш', group: 'Игры в чатах', bets: 'Больше всего ставок', rich: 'Богатейшие' },
    ro: { crash: 'Crash · cel mai mare x', flappy: 'Flappy · record', win: 'Cel mai mare câștig', group: 'Jocuri în chat', bets: 'Cele mai multe pariuri', rich: 'Cei mai bogați' },
    en: { crash: 'Crash · best multiplier', flappy: 'Flappy · record', win: 'Biggest win', group: 'Chat games', bets: 'Most bets', rich: 'Richest' },
};
const BOARDS = {
    crash: { wk: 'crash', all: (r) => r.st.crashBest, fmt: (v) => '×' + (Math.floor(v * 100) / 100), verified: false },
    flappy: { wk: 'flappy', all: (r) => r.st.flappyBest, fmt: (v) => String(v), verified: false },
    win: { wk: 'win', all: (r) => Math.max(r.st.biggestWin, r.st.gBiggest), fmt: (v) => fmtShort(v), verified: false },
    group: { wk: 'g', all: (r) => r.st.gBiggest, fmt: (v) => fmtShort(v), verified: true },
    bets: { wk: null, all: (r) => r.st.bets + r.st.gBets, fmt: (v) => fmtShort(v), verified: false },
    rich: { wk: null, all: null, fmt: (v) => fmtShort(v), verified: false },
};
const BOARD_ORDER = ['crash', 'flappy', 'win', 'group', 'bets', 'rich'];

const T = {
    ru: {
        title: 'Профиль', open: '🎮 Открыть Crown Casino', noCanvas: 'Картинка недоступна — вот текстовая карточка:',
        bets: 'Ставок', wins: 'Побед', crash: 'Лучший икс', flappy: 'Flappy', win: 'Крупнейший выигрыш', level: 'Уровень', coin: 'Genesis Pepe Coin',
        top: 'Рейтинг', week: 'Неделя', all: 'Всё время', verified: '✓ результаты проверены сервером', unverified: 'рекорды присылает приложение', empty: 'Пока никого нет.', you: 'Вы',
        notYours: 'Это не ваши кнопки', gifted: (it, to) => `🎁 Вы подарили «${it}» → ${to}`, giftGot: (it, from) => `🎁 ${from} подарил(а) вам «${it}»`,
        giftHow: 'Ответьте на сообщение игрока: <code>подарить frame:gold</code>. Список ваших предметов: <code>предметы</code>',
        giftBad: 'Такого предмета нет или он у вас не открыт.', giftLimit: 'Лимит подарков на сегодня исчерпан (3).', giftSelf: 'Себе дарить нельзя.', giftNoUser: 'Ответьте на сообщение игрока, которому дарите.',
        items: 'Ваши предметы', coinWon: (n, t) => `🎉 <b>Вам досталась Genesis Pepe Coin #${n} из ${t}!</b>\nЭто очень редкая монета — её нельзя купить. Откройте профиль: карточка стала особенной.`,
        coinGiven: (n) => `🪙 Админ выдал вам Genesis Pepe Coin <b>#${n}</b>!`, coinTaken: (n) => `Монета Genesis #${n} возвращена админу.`,
    },
    ro: {
        title: 'Profil', open: '🎮 Deschide Crown Casino', noCanvas: 'Imaginea nu este disponibilă — iată cardul text:',
        bets: 'Pariuri', wins: 'Victorii', crash: 'Cel mai mare x', flappy: 'Flappy', win: 'Cel mai mare câștig', level: 'Nivel', coin: 'Genesis Pepe Coin',
        top: 'Clasament', week: 'Săptămâna', all: 'Tot timpul', verified: '✓ rezultate verificate de server', unverified: 'recordurile vin din aplicație', empty: 'Încă nimeni.', you: 'Tu',
        notYours: 'Acestea nu sunt butoanele tale', gifted: (it, to) => `🎁 Ai dăruit «${it}» → ${to}`, giftGot: (it, from) => `🎁 ${from} ți-a dăruit «${it}»`,
        giftHow: 'Răspunde la mesajul jucătorului: <code>dăruiește frame:gold</code>. Lista ta: <code>items</code>',
        giftBad: 'Nu există sau nu ți-e deblocat.', giftLimit: 'Limita de cadouri pe azi (3) s-a epuizat.', giftSelf: 'Nu poți dărui ție.', giftNoUser: 'Răspunde la mesajul jucătorului.',
        items: 'Obiectele tale', coinWon: (n, t) => `🎉 <b>Ai primit Genesis Pepe Coin #${n} din ${t}!</b>\nEste o monedă foarte rară — nu se poate cumpăra.`,
        coinGiven: (n) => `🪙 Adminul ți-a dat Genesis Pepe Coin <b>#${n}</b>!`, coinTaken: (n) => `Moneda Genesis #${n} a fost returnată adminului.`,
    },
    en: {
        title: 'Profile', open: '🎮 Open Crown Casino', noCanvas: 'Image unavailable — here is the text card:',
        bets: 'Bets', wins: 'Wins', crash: 'Best multiplier', flappy: 'Flappy', win: 'Biggest win', level: 'Level', coin: 'Genesis Pepe Coin',
        top: 'Leaderboard', week: 'Week', all: 'All time', verified: '✓ results verified by the server', unverified: 'records are reported by the app', empty: 'Nobody yet.', you: 'You',
        notYours: 'These are not your buttons', gifted: (it, to) => `🎁 You gifted “${it}” → ${to}`, giftGot: (it, from) => `🎁 ${from} gifted you “${it}”`,
        giftHow: 'Reply to a player: <code>gift frame:gold</code>. Your items: <code>items</code>',
        giftBad: 'No such item or you have not unlocked it.', giftLimit: 'Daily gift limit reached (3).', giftSelf: 'You cannot gift yourself.', giftNoUser: 'Reply to the player you are gifting.',
        items: 'Your items', coinWon: (n, t) => `🎉 <b>You received Genesis Pepe Coin #${n} of ${t}!</b>\nIt is extremely rare and cannot be bought.`,
        coinGiven: (n) => `🪙 The admin gave you Genesis Pepe Coin <b>#${n}</b>!`, coinTaken: (n) => `Genesis coin #${n} was returned to the admin.`,
    },
};

module.exports = function initProfiles(deps) {
    const { bot, validateInitData, readBody, sendJson, loadUsers, isAdminId, isHidden, isAccountFrozen } = deps;
    const MAX_BODY = deps.MAX_API_BODY_BYTES || 65536;
    const ADMIN = String(deps.ADMIN_ID);
    const getLang = (uid) => { const l = deps.getUserLanguage ? deps.getUserLanguage(String(uid)) : null; return (l === 'ru' || l === 'ro' || l === 'en') ? l : 'ru'; };
    const esc = deps.escapeHtml || ((s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
    const FILE = deps.dataFile || path.join(__dirname, 'profiles.json');

    // ---------------- ХРАНИЛИЩЕ ----------------
    let db = null;
    function load() {
        try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { db = null; }
        if (!db || typeof db !== 'object') db = {};
        if (!db.users) db.users = {};
        if (!db.coins) db.coins = {};
        if (!db.milestone) db.milestone = { awarded: 0 };
        if (!db.giftLog) db.giftLog = {};
        // Все 50 монет с самого запуска у админа
        let changed = false;
        for (let i = 1; i <= COIN_TOTAL; i++) {
            if (!db.coins[i]) { db.coins[i] = { owner: ADMIN, since: Date.now(), history: [{ ts: Date.now(), to: ADMIN, why: 'genesis' }] }; changed = true; }
        }
        if (changed) saveNow();
    }
    let saveTimer = null;
    function saveNow() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db), 'utf8'); fs.renameSync(tmp, FILE); }
        catch (e) { console.error('profiles save error:', e.message); }
    }
    function saveSoon() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 1500); if (saveTimer.unref) saveTimer.unref(); }
    function reload() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } load(); }
    load();

    function rec(uid) {
        const k = String(uid);
        if (!db.users[k]) db.users[k] = { equip: {}, gifted: [], st: {}, wk: null, createdAt: Date.now() };
        const r = db.users[k];
        r.equip = r.equip || {}; r.gifted = r.gifted || [];
        const s = r.st = r.st || {};
        for (const f of ['bets', 'wins', 'biggestWin', 'crashBest', 'flappyBest', 'gBets', 'gWins', 'gBiggest', 'gBestMult']) if (typeof s[f] !== 'number' || !isFinite(s[f])) s[f] = 0;
        return r;
    }
    function wkKey(d) {
        d = d || new Date();
        const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
        const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
        return t.getUTCFullYear() + '-W' + String(Math.ceil(((t - y0) / DAY + 1) / 7)).padStart(2, '0');
    }
    function wk(r) {
        const key = wkKey();
        if (!r.wk || r.wk.key !== key) r.wk = { key, crash: 0, flappy: 0, win: 0, g: 0 };
        return r.wk;
    }

    // ---------------- МОНЕТА ----------------
    const coinsOf = (uid) => Object.keys(db.coins).filter((s) => db.coins[s].owner === String(uid)).map(Number).sort((a, b) => a - b);
    const badgeOf = (uid) => { const c = coinsOf(uid); return c.length && String(uid) !== ADMIN ? ` 🪙#${c[0]}` : (c.length ? ' 🪙' : ''); };
    function giveCoin(toUid, serial, why, fromUid) {
        fromUid = String(fromUid || ADMIN);
        if (serial == null) { const own = coinsOf(fromUid); if (!own.length) return null; serial = own[0]; }
        const c = db.coins[serial];
        if (!c || c.owner !== fromUid) return null;
        c.owner = String(toUid); c.since = Date.now();
        c.history.push({ ts: Date.now(), from: fromUid, to: String(toUid), why: why || 'admin' });
        saveNow();
        return Number(serial);
    }
    function notify(uid, text, extra) { return Promise.resolve(bot.sendMessage(uid, text, Object.assign({ parse_mode: 'HTML' }, extra || {}))).catch(() => { /* игрок не запускал бота */ }); }
    function eligibleForDraw() {
        const users = loadUsers ? loadUsers() : {};
        return Object.keys(users).filter((u) => u !== ADMIN && !(isHidden && isHidden(u)) && !(isAccountFrozen && isAccountFrozen(u)));
    }
    // Каждые MILESTONE_USERS игроков — монета случайному игроку. Вызывается, когда в реестре появился новый игрок.
    function onNewUser(uid, total) {
        try {
            let due = Math.floor(total / MILESTONE_USERS) - (db.milestone.awarded || 0);
            while (due > 0) {
                const pool = eligibleForDraw();
                if (!pool.length) break;
                const free = pool.filter((u) => coinsOf(u).length === 0);       // сначала те, у кого монеты ещё нет
                const list = free.length ? free : pool;
                const winner = list[crypto.randomInt(list.length)];
                const serial = giveCoin(winner, null, 'milestone-' + (db.milestone.awarded + 1) * MILESTONE_USERS, ADMIN);
                if (serial == null) break;                                          // запас у админа закончился
                db.milestone.awarded += 1; saveNow(); due -= 1;
                const lang = getLang(winner);
                notify(winner, T[lang].coinWon(serial, COIN_TOTAL));
                const u = loadUsers()[winner] || {};
                notify(ADMIN, `🎲 ${total} игроков: монета Genesis #${serial} досталась ${esc(u.name || winner)}${u.username ? ' (@' + esc(u.username) + ')' : ''} [id ${winner}]`);
            }
        } catch (e) { console.error('onNewUser:', e.message); }
    }

    // ---------------- СТАТИСТИКА / ОТКРЫТОЕ ----------------
    function stats(uid) {
        const r = rec(uid), s = r.st;
        return {
            bets: s.bets + s.gBets, wins: s.wins + s.gWins, crash: s.crashBest, flappy: s.flappyBest,
            win: Math.max(s.biggestWin, s.gBiggest), gwins: s.gWins, coin: coinsOf(uid).length > 0,
        };
    }
    function needMet(need, st) { return !need || (need.k === 'coin' ? st.coin : (st[need.k] || 0) >= need.n); }
    function unlocked(uid, slot, it, st) { const r = rec(uid); return !!it.def || needMet(it.need, st || stats(uid)) || r.gifted.includes(slot + ':' + it.id); }
    function equipped(uid, slot) {
        const r = rec(uid), st = stats(uid), list = ITEMS[slot];
        const want = r.equip[slot] || (st.coin && list.find((i) => i.id === 'genesis') ? 'genesis' : null);
        const it = list.find((i) => i.id === want);
        if (it && unlocked(uid, slot, it, st)) return it.id;
        return list.find((i) => i.def).id;
    }
    function levelOf(uid) { return Math.min(99, 1 + Math.floor(Math.sqrt(stats(uid).bets))); }
    function itemsView(uid, lang) {
        const st = stats(uid), out = {};
        for (const slot of SLOTS) {
            const eq = equipped(uid, slot);
            out[slot] = ITEMS[slot].map((it) => ({
                id: it.id, name: it.n[lang] || it.n.en, unlocked: unlocked(uid, slot, it, st), equipped: it.id === eq,
                hint: it.def ? '' : (HINT[lang][it.need.k] || HINT.en[it.need.k])(it.need.n),
            }));
        }
        return out;
    }
    function personOf(uid) { const u = (loadUsers ? loadUsers() : {})[String(uid)] || {}; return { name: u.name || 'Player', username: u.username || '' }; }
    function cardData(uid, lang) {
        const st = rec(uid).st, p = personOf(uid), coins = coinsOf(uid), L = lang || getLang(uid);
        const titleId = equipped(uid, 'title');
        return {
            name: p.name, username: p.username, titleText: ITEMS.title.find((i) => i.id === titleId).n[L], level: levelOf(uid),
            bg: equipped(uid, 'bg'), frame: equipped(uid, 'frame'), lang: L,
            coin: coins.length ? { serial: coins[0], total: COIN_TOTAL } : null,
            stats: { bets: st.bets + st.gBets, wins: st.wins + st.gWins, crashBest: st.crashBest, flappyBest: st.flappyBest, biggestWin: Math.max(st.biggestWin, st.gBiggest) },
        };
    }
    function cardVer(data) { return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex').slice(0, 8); }
    function cardUrl(uid) {
        const base = deps.getBaseUrl ? deps.getBaseUrl() : '';
        if (!base) return null;
        return String(base).replace(/\/+$/, '') + '/pc/' + uid + '-' + cardVer(cardData(uid)) + '.png';
    }
    function view(uid, lang) {
        const L = lang || getLang(uid), p = personOf(uid), st = stats(uid), coins = coinsOf(uid);
        return {
            id: String(uid), name: p.name, username: p.username, level: levelOf(uid), lang: L,
            stats: { bets: st.bets, wins: st.wins, crash: st.crash, flappy: st.flappy, win: st.win },
            items: itemsView(uid, L), coin: coins.length ? { serial: coins[0], total: COIN_TOTAL, all: coins } : null,
            equip: { title: equipped(uid, 'title'), frame: equipped(uid, 'frame'), bg: equipped(uid, 'bg') },
        };
    }

    // ---------------- СОБЫТИЯ ----------------
    function recordEvent(uid, type, value) {
        value = Number(value);
        if (!isFinite(value) || value <= 0) return false;
        const r = rec(uid), s = r.st, w = wk(r);
        if (type === 'crash') { value = Math.floor(Math.min(value, 100) * 100) / 100; if (value > s.crashBest) s.crashBest = value; if (value > w.crash) w.crash = value; }
        else if (type === 'flappy') { value = Math.min(Math.floor(value), 5000); if (value > s.flappyBest) s.flappyBest = value; if (value > w.flappy) w.flappy = value; }
        else if (type === 'win') { value = Math.min(Math.floor(value), 1e30); if (value > s.biggestWin) s.biggestWin = value; if (value > w.win) w.win = value; }
        else return false;
        saveSoon(); return true;
    }
    function reportSnapshot(uid, snap) {
        const r = rec(uid), s = r.st;
        const bets = Math.min(1e7, Math.max(0, Math.floor(Number(snap && snap.bets) || 0)));
        const wins = Math.min(bets, Math.max(0, Math.floor(Number(snap && snap.wins) || 0)));
        if (bets > s.bets) s.bets = bets;
        if (wins > s.wins) s.wins = wins;
        saveSoon();
    }
    function recordGroupGame(uid, g) {          // считает сам сервер → проверенные данные
        const r = rec(uid), s = r.st, w = wk(r);
        s.gBets += 1;
        if (g && g.win) {
            s.gWins += 1;
            const pay = Math.floor(Number(g.payout) || 0);
            if (pay > s.gBiggest) s.gBiggest = pay;
            if (pay > w.g) w.g = pay;
            if (g.mult > s.gBestMult) s.gBestMult = g.mult;
        }
        saveSoon();
    }

    // ---------------- РЕЙТИНГИ ----------------
    function top(game, period, requesterId) {
        const b = BOARDS[game]; if (!b) return null;
        const week = period === 'week' && !!b.wk, cur = wkKey(), rows = [];
        if (game === 'rich') {
            const users = loadUsers ? loadUsers() : {};
            for (const uid of Object.keys(users)) {
                if (isHidden && isHidden(uid) && uid !== String(requesterId)) continue;
                const v = deps.knownBalance ? deps.knownBalance(uid) : null;
                if (v && v > 0) rows.push({ uid, v });
            }
        } else {
            for (const uid of Object.keys(db.users)) {
                if (isHidden && isHidden(uid) && uid !== String(requesterId)) continue;
                const r = rec(uid);
                const v = week ? ((r.wk && r.wk.key === cur) ? r.wk[b.wk] : 0) : b.all(r);
                if (v > 0) rows.push({ uid, v });
            }
        }
        rows.sort((a, b2) => b2.v - a.v);
        const mine = rows.findIndex((x) => x.uid === String(requesterId));
        const list = rows.slice(0, 10).map((x, i) => {
            const c = coinsOf(x.uid);
            return { rank: i + 1, name: personOf(x.uid).name, value: x.v, valueText: b.fmt(x.v), coin: c.length && x.uid !== ADMIN ? c[0] : (c.length ? 0 : null), me: x.uid === String(requesterId) };
        });
        return {
            game, period: week ? 'week' : 'all', verified: b.verified, rows: list,
            me: mine >= 0 ? { rank: mine + 1, valueText: b.fmt(rows[mine].v) } : null, weekly: !!b.wk,
        };
    }

    // ---------------- ПОДАРКИ ----------------
    function giftItem(fromUid, toUid, itemKey) {
        const T0 = T[getLang(fromUid)];
        const [slot, id] = String(itemKey || '').split(':');
        const it = ITEMS[slot] && ITEMS[slot].find((i) => i.id === id);
        if (!it || it.def || id === 'genesis') return { err: T0.giftBad };            // базовые и Genesis-предметы не дарятся
        if (String(fromUid) === String(toUid)) return { err: T0.giftSelf };
        if (!unlocked(fromUid, slot, it)) return { err: T0.giftBad };
        const day = Math.floor(Date.now() / DAY), g = db.giftLog[fromUid] || { day, n: 0 };
        if (g.day !== day) { g.day = day; g.n = 0; }
        if (g.n >= 3) return { err: T0.giftLimit };
        const rr = rec(toUid), key = slot + ':' + id;
        if (!rr.gifted.includes(key)) rr.gifted.push(key);
        g.n += 1; db.giftLog[fromUid] = g; saveNow();
        return { ok: true, item: it };
    }

    // ---------------- КАРТОЧКА: текст / картинка ----------------
    function textCard(uid, lang) {
        const d = cardData(uid, lang), L = T[d.lang], s = d.stats;
        return `<b>${esc(d.name)}</b>${d.username ? ' @' + esc(d.username) : ''}\n${esc(d.titleText)} · ${L.level} ${d.level}\n` +
            `${L.bets}: ${fmtShort(s.bets)} · ${L.wins}: ${fmtShort(s.wins)}\n${L.crash}: ${s.crashBest ? '×' + s.crashBest : '—'} · ${L.flappy}: ${s.flappyBest || '—'}\n${L.win}: ${s.biggestWin ? fmtShort(s.biggestWin) : '—'}` +
            (d.coin ? `\n🪙 ${L.coin} #${d.coin.serial}/${d.coin.total}` : '');
    }
    function miniAppLink() {
        const bu = deps.getBotUsername && deps.getBotUsername(), sn = deps.getMiniAppShort && deps.getMiniAppShort();
        return bu && sn ? `https://t.me/${bu}/${sn}` : null;
    }
    async function sendCard(chatId, uid, lang, replyTo) {
        const L = T[lang];
        const link = miniAppLink();
        const markup = link ? { inline_keyboard: [[{ text: L.open, url: link }]] } : undefined;
        try {
            const png = await card.renderProfileCard(cardData(uid, lang));
            await bot.sendPhoto(chatId, png, { reply_to_message_id: replyTo, allow_sending_without_reply: true, reply_markup: markup }, { filename: 'profile.png', contentType: 'image/png' });
        } catch (e) {
            console.error('profile card:', e && e.message);
            await bot.sendMessage(chatId, `${L.noCanvas}\n\n${textCard(uid, lang)}`, { parse_mode: 'HTML', reply_to_message_id: replyTo, allow_sending_without_reply: true, reply_markup: markup });
        }
    }

    // ---------------- ТОП: меню ----------------
    function topText(res, lang) {
        const L = T[lang];
        if (!res) return L.empty;
        const head = `🏆 <b>${esc(BOARD_NAMES[lang][res.game])}</b> · ${res.period === 'week' ? L.week : L.all}\n`;
        const medals = ['🥇', '🥈', '🥉'];
        const lines = res.rows.map((x) => `${medals[x.rank - 1] || (x.rank + '.')} ${esc(x.name)}${x.coin != null ? ' 🪙' + (x.coin ? '#' + x.coin : '') : ''} — <b>${esc(x.valueText)}</b>${x.me ? ' ◀' : ''}`);
        const foot = `\n<i>${res.verified ? L.verified : L.unverified}</i>` + (res.me && !res.rows.some((x) => x.me) ? `\n${L.you}: #${res.me.rank} — ${res.me.valueText}` : '');
        return head + (lines.length ? lines.join('\n') : L.empty) + foot;
    }
    function topMarkup(owner, game, period, lang) {
        const L = T[lang], b = (g) => ({ text: (g === game ? '• ' : '') + BOARD_NAMES[lang][g], callback_data: `pf|${owner}|T|${g}|${period}` });
        const rows = [[b('crash'), b('flappy')], [b('win'), b('group')], [b('bets'), b('rich')]];
        if (BOARDS[game].wk) rows.push([
            { text: (period === 'week' ? '• ' : '') + L.week, callback_data: `pf|${owner}|T|${game}|week` },
            { text: (period === 'all' ? '• ' : '') + L.all, callback_data: `pf|${owner}|T|${game}|all` },
        ]);
        return { inline_keyboard: rows };
    }

    // ---------------- КОМАНДЫ БОТА ----------------
    const RE_PROFILE = /^(?:\/profile(?:@\w+)?|профиль|profil)$/i;
    const RE_TOP = /^(?:\/top(?:@\w+)?|топ|top|clasament)$/i;
    const RE_GIFT = /^(?:\/gift(?:@\w+)?|подарить|gift|dăruiește)\s+(\S+)\s*$/i;
    const RE_ITEMS = /^(?:\/items(?:@\w+)?|предметы|items)$/i;
    const RE_COIN = /^\/coin(?:@\w+)?(?:\s+(.*))?$/i;

    function resolveTarget(s) {
        s = String(s || '').trim().replace(/^@/, '');
        if (/^\d+$/.test(s)) return s;
        const users = loadUsers ? loadUsers() : {};
        const low = s.toLowerCase();
        return Object.keys(users).find((id) => (users[id].username || '').toLowerCase() === low) || null;
    }
    function coinStatus() {
        const byOwner = {};
        for (let i = 1; i <= COIN_TOTAL; i++) { const o = db.coins[i].owner; (byOwner[o] = byOwner[o] || []).push(i); }
        const users = loadUsers ? loadUsers() : {};
        const lines = Object.keys(byOwner).map((o) => {
            const u = users[o] || {};
            return `${o === ADMIN ? '👑 админ' : esc(u.name || o) + (u.username ? ' @' + esc(u.username) : '') + ' [' + o + ']'}: ${o === ADMIN ? byOwner[o].length + ' шт.' : '#' + byOwner[o].join(', #')}`;
        });
        return `🪙 <b>Genesis Pepe Coin</b> (всего ${COIN_TOTAL})\n${lines.join('\n')}\n\nРозыграно по достижению ${MILESTONE_USERS} игроков: ${db.milestone.awarded}\nИгроков сейчас: ${Object.keys(users).length}\n\n<code>/coin give @user [номер]</code> — выдать\n<code>/coin take @user</code> — вернуть админу`;
    }

    bot.on('message', async (msg) => {
        try {
            if (!msg || !msg.from || msg.from.is_bot || typeof msg.text !== 'string') return;
            const text = msg.text.trim();
            const uid = String(msg.from.id), chatId = msg.chat.id, lang = getLang(uid);
            let m;
            if (isAccountFrozen && !isAdminId(uid) && isAccountFrozen(uid)) return;
            if ((m = text.match(RE_COIN))) {
                if (!isAdminId(uid)) return;
                const parts = String(m[1] || '').trim().split(/\s+/).filter(Boolean);
                if (!parts.length) { await bot.sendMessage(chatId, coinStatus(), { parse_mode: 'HTML' }); return; }
                if (parts[0] === 'give' && parts[1]) {
                    const to = resolveTarget(parts[1]);
                    if (!to) { await bot.sendMessage(chatId, 'Игрок не найден (он должен хотя бы раз открыть Crown Casino).'); return; }
                    const serial = giveCoin(to, parts[2] ? parseInt(parts[2], 10) : null, 'admin-give', ADMIN);
                    if (serial == null) { await bot.sendMessage(chatId, 'Не получилось: у админа нет такой монеты (или запас закончился).'); return; }
                    notify(to, T[getLang(to)].coinGiven(serial));
                    await bot.sendMessage(chatId, `✅ Монета #${serial} → ${esc(personOf(to).name)} [${to}]`);
                } else if (parts[0] === 'take' && parts[1]) {
                    const from = resolveTarget(parts[1]);
                    const own = from ? coinsOf(from) : [];
                    if (!own.length) { await bot.sendMessage(chatId, 'У этого игрока нет монет.'); return; }
                    const serial = parts[2] ? parseInt(parts[2], 10) : own[0];
                    if (giveCoin(ADMIN, serial, 'admin-take', from) == null) { await bot.sendMessage(chatId, 'Не получилось.'); return; }
                    await bot.sendMessage(chatId, `✅ Монета #${serial} возвращена админу.`);
                } else await bot.sendMessage(chatId, coinStatus(), { parse_mode: 'HTML' });
                return;
            }
            if (RE_PROFILE.test(text)) {
                let target = uid;
                const rt = msg.reply_to_message && msg.reply_to_message.from;
                if (rt && !rt.is_bot) { target = String(rt.id); }
                await sendCard(chatId, target, getLang(target) === lang || target === uid ? lang : getLang(target), msg.message_id);
                return;
            }
            if (RE_TOP.test(text)) {
                const res = top('crash', 'all', uid);
                await bot.sendMessage(chatId, topText(res, lang), { parse_mode: 'HTML', reply_markup: topMarkup(uid, 'crash', 'all', lang), reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
                return;
            }
            if (RE_ITEMS.test(text)) {
                const iv = itemsView(uid, lang), L = T[lang];
                const lines = [];
                for (const slot of SLOTS) for (const it of iv[slot]) if (it.unlocked) lines.push(`<code>${slot}:${it.id}</code> — ${esc(it.name)}`);
                await bot.sendMessage(chatId, `<b>${L.items}</b>\n${lines.join('\n')}\n\n${L.giftHow}`, { parse_mode: 'HTML', reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
                return;
            }
            if ((m = text.match(RE_GIFT))) {
                const L = T[lang], rt = msg.reply_to_message && msg.reply_to_message.from;
                if (!rt || rt.is_bot) { await bot.sendMessage(chatId, `${L.giftNoUser}\n${L.giftHow}`, { parse_mode: 'HTML' }); return; }
                const res = giftItem(uid, String(rt.id), m[1]);
                if (res.err) { await bot.sendMessage(chatId, '⚠️ ' + res.err, { reply_to_message_id: msg.message_id, allow_sending_without_reply: true }); return; }
                const toName = esc(rt.first_name || rt.username || String(rt.id));
                await bot.sendMessage(chatId, esc(L.gifted(res.item.n[lang], rt.first_name || rt.username || rt.id)), { reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
                notify(rt.id, esc(T[getLang(rt.id)].giftGot(res.item.n[getLang(rt.id)], msg.from.first_name || msg.from.username || uid)));
                void toName;
            }
        } catch (e) { console.error('profiles message:', e && e.message); }
    });

    bot.on('callback_query', async (q) => {
        try {
            const data = q && q.data;
            if (typeof data !== 'string' || !data.startsWith('pf|')) return;
            const [, owner, act, game, period] = data.split('|');
            const uid = String(q.from.id), lang = getLang(uid);
            if (uid !== owner) { await bot.answerCallbackQuery(q.id, { text: T[lang].notYours, show_alert: true }).catch(() => { }); return; }
            if (act === 'T' && BOARDS[game] && q.message) {
                const p = period === 'week' && BOARDS[game].wk ? 'week' : 'all';
                await bot.answerCallbackQuery(q.id).catch(() => { });
                await bot.editMessageText(topText(top(game, p, uid), lang), {
                    chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'HTML', reply_markup: topMarkup(owner, game, p, lang),
                }).catch((e) => { if (!/not modified/i.test(e && e.message)) console.error('profiles top edit:', e && e.message); });
            } else await bot.answerCallbackQuery(q.id).catch(() => { });
        } catch (e) { console.error('profiles callback:', e && e.message); }
    });

    // ---------------- ИНЛАЙН: @бот profile ----------------
    async function answerInline(q) {
        const uid = String(q.from.id), lang = getLang(uid), L = T[lang];
        const url = card.isAvailable() ? cardUrl(uid) : null;
        const link = miniAppLink();
        const markup = link ? { inline_keyboard: [[{ text: L.open, url: link }]] } : undefined;
        let results;
        if (url) {
            results = [{ type: 'photo', id: 'pf' + uid + cardVer(cardData(uid)), photo_url: url, thumbnail_url: url, thumb_url: url, photo_width: card.W, photo_height: card.H, title: L.title, description: personOf(uid).name, reply_markup: markup }];
        } else {
            results = [{ type: 'article', id: 'pft' + uid, title: L.title, description: personOf(uid).name, input_message_content: { message_text: textCard(uid, lang), parse_mode: 'HTML' }, reply_markup: markup }];
        }
        await bot.answerInlineQuery(q.id, results, { cache_time: 0, is_personal: true });
    }

    // ---------------- HTTP ----------------
    function withUser(req, res, fn) {
        readBody(req, MAX_BODY, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let p = {}; try { p = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const user = validateInitData(p.initData || '');
            if (!user) { sendJson(res, 401, { ok: false }); return; }
            try { fn(user, p); } catch (e) { console.error('profiles api:', e && e.message); sendJson(res, 500, { ok: false }); }
        });
    }
    const evWindow = new Map();
    function handleRoutes(req, res) {
        const url = req.url;
        const mm = req.method === 'GET' && url.match(/^\/pc\/(\d+)-([a-z0-9]{1,16})\.png$/);
        if (mm) {
            card.renderProfileCard(cardData(mm[1])).then((png) => {
                res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'Content-Length': png.length });
                res.end(png);
            }).catch((e) => { console.error('card route:', e && e.message); res.writeHead(503); res.end(); });
            return true;
        }
        if (req.method !== 'POST') return false;
        if (url === '/api/profile') { withUser(req, res, (u) => sendJson(res, 200, { ok: true, me: view(u.id, getLang(u.id)), canvas: card.isAvailable(), botUsername: (deps.getBotUsername && deps.getBotUsername()) || '' })); return true; }
        if (url === '/api/profile-equip') {
            withUser(req, res, (u, p) => {
                const slot = String(p.slot || ''), id = String(p.id || '');
                const it = ITEMS[slot] && ITEMS[slot].find((i) => i.id === id);
                if (!it || !unlocked(u.id, slot, it)) { sendJson(res, 400, { ok: false }); return; }
                rec(u.id).equip[slot] = id; saveSoon();
                sendJson(res, 200, { ok: true, me: view(u.id, getLang(u.id)) });
            });
            return true;
        }
        if (url === '/api/profile-event') {
            withUser(req, res, (u, p) => {
                const now = Date.now(), w = evWindow.get(String(u.id)) || { t: now, n: 0 };
                if (now - w.t > 60000) { w.t = now; w.n = 0; }
                w.n += 1; evWindow.set(String(u.id), w);
                if (w.n > 120) { sendJson(res, 429, { ok: false }); return; }
                const ok = recordEvent(u.id, String(p.type || ''), p.value);
                sendJson(res, 200, { ok });
            });
            return true;
        }
        if (url === '/api/profile-report') { withUser(req, res, (u, p) => { reportSnapshot(u.id, p); sendJson(res, 200, { ok: true }); }); return true; }
        if (url === '/api/profile-top') {
            withUser(req, res, (u, p) => {
                const game = BOARDS[p.game] ? p.game : 'crash';
                sendJson(res, 200, { ok: true, boards: BOARD_ORDER.map((g) => ({ id: g, name: BOARD_NAMES[getLang(u.id)][g], weekly: !!BOARDS[g].wk, verified: BOARDS[g].verified })), top: top(game, p.period === 'week' ? 'week' : 'all', u.id) });
            });
            return true;
        }
        return false;
    }

    return {
        handleRoutes, answerInline, onNewUser, recordGroupGame, badgeOf, reload, cardData, cardUrl, view, top, giftItem,
        coinsOf, giveCoin, recordEvent, reportSnapshot, _db: () => db, ITEMS, COIN_TOTAL, flush: saveNow,
    };
};
module.exports.ITEMS = ITEMS;
