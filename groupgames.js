// ============================================================
//  groupgames.js — режим игр ТОЛЬКО для групповых чатов (стиль Red Cube)
//
//  Команды (в группе):
//    ставка 67  |  /bet 67        — задать ставку и открыть меню игр
//    ставка вб  |  вб  |  на все  — ва-банк (вся доступная сумма)
//    игры  |  /games              — меню игр с текущей ставкой
//    рейк  |  /rake               — рейкбек (кнопка «Забрать 1.4m»)
//
//  Кнопки работают ТОЛЬКО у того, кто написал команду. Остальным —
//  всплывающее окно «Это не ваши кнопки».
//  Кубики/мячи шлёт сам бот (sendDice) и читает значение из ответа
//  Telegram, поэтому результат нельзя подделать.
//
//  Баланс общий с Mini App: списание/зачисление идёт через ту же очередь
//  queueWallet, что и переводы (клиент применяет её при открытии игры).
//
//  Подключение в server.js (после создания `bot`):
//    require('./groupgames')({ bot, spendableBalance, queueWallet,
//      isAccountFrozen, isAdminId, parseAmount, rememberUser, escapeHtml });
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------- НАСТРОЙКИ (меняй здесь) ----------------
const CFG = {
    CUR: '💲',                 // знак валюты в сообщениях
    HOUSE_EDGE: 0.03,          // выплата = ставка × множитель × (1 − HOUSE_EDGE)
    RAKE_RATE: 0.005,          // рейкбек: доля от суммы ставок
    DEFAULT_BET: 10,
    MIN_BET: 1,
    MAX_THROWS_DICE: 3,        // 🎲: до 3 бросков
    MAX_THROWS_OTHER: 2,       // остальные эмодзи: до 2 бросков
    // сколько ждать окончания анимации после sendDice (мс). НЕ проверено на клиентах — подстрой.
    ANIM_MS: { '🎲': 3600, '🎯': 3600, '🎳': 4600, '⚽': 4600, '🏀': 4600, '🎰': 2800 },
};
const DATA_FILE = path.join(__dirname, 'groupgames.json');

// ---------------- ТАБЛИЦЫ ИСХОДОВ ----------------
// set — какие значения dice.value выигрывают. Множитель = 1 / (|set| / |values|).
// verified:false — соответствие «значение → название исхода» взято из скриншотов Red Cube
// (по их множителям) и НЕ подтверждено на живом Telegram. Проверка: админ-команда /dicetest.
const SLOT_SYM = ['BAR', '🍇', '🍋', '7️⃣'];            // индексы символов барабана 0..3
function slotDecode(v) { const x = v - 1; return [x & 3, (x >> 2) & 3, (x >> 4) & 3]; }
const slotSet = (f) => { const s = []; for (let v = 1; v <= 64; v++) if (f(slotDecode(v))) s.push(v); return s; };

const GAMES = {
    dice: {
        emoji: '🎲', title: 'Кубик', values: 6, verified: true,
        outcomes: [
            { k: 'even', t: 'Чёт', set: [2, 4, 6] }, { k: 'odd', t: 'Нечёт', set: [1, 3, 5] },
            { k: 'low', t: 'Меньше', set: [1, 2, 3] }, { k: 'high', t: 'Больше', set: [4, 5, 6] },
            { k: 'n1', t: '1', set: [1] }, { k: 'n2', t: '2', set: [2] }, { k: 'n3', t: '3', set: [3] },
            { k: 'n4', t: '4', set: [4] }, { k: 'n5', t: '5', set: [5] }, { k: 'n6', t: '6', set: [6] },
        ],
        layout: [['even', 'odd'], ['low', 'high'], ['n1', 'n2', 'n3'], ['n4', 'n5', 'n6']],
        gated: [{ t: 'Лесенка (x2.2)', note: 'Правила «Лесенки» не заданы — режим выключен.' }],
    },
    football: {
        emoji: '⚽', title: 'Футбол', values: 5, verified: false,
        outcomes: [
            { k: 'center', t: 'Гол в центр', set: [5] }, { k: 'corner', t: 'Гол в угол', set: [4] },
            { k: 'rebound', t: 'Гол от штанги', set: [3] }, { k: 'any', t: 'Любой гол', set: [3, 4, 5] },
            { k: 'post', t: 'Удар об штангу', set: [2] }, { k: 'miss', t: 'Промах', set: [1, 2] },
        ],
        layout: [['center', 'corner'], ['rebound', 'any'], ['post', 'miss']],
    },
    basket: {
        emoji: '🏀', title: 'Баскетбол', values: 5, verified: false,
        outcomes: [
            { k: 'swish', t: 'Чистый гол', set: [5] }, { k: 'spin', t: 'Прокрут', set: [2, 4] },
            { k: 'stuck', t: 'Застрял мяч', set: [3] }, { k: 'any', t: 'Любой гол', set: [4, 5] },
            { k: 'bounce', t: 'Отскок', set: [1] }, { k: 'miss', t: 'Промах', set: [1, 2, 3] },
        ],
        layout: [['swish', 'spin'], ['stuck', 'any'], ['bounce', 'miss']],
    },
    darts: {
        emoji: '🎯', title: 'Дартс', values: 6, verified: false,
        outcomes: [
            { k: 'center', t: '🎯 Центр', set: [6] }, { k: 'red', t: '🔴 Сектор', set: [2, 4] },
            { k: 'bounce', t: '🛑 Отскок', set: [1] }, { k: 'white', t: '⚪ Сектор', set: [3, 5] },
            { k: 'anysec', t: 'Любой сектор', set: [2, 3, 4, 5] },
            { k: 'redc', t: '🔴 Сектор или Центр', set: [2, 4, 6] }, { k: 'whiteb', t: '⚪ Сектор или Отскок', set: [3, 5, 1] },
        ],
        layout: [['center', 'red'], ['bounce', 'white'], ['anysec'], ['redc'], ['whiteb']],
    },
    bowling: {
        emoji: '🎳', title: 'Боулинг', values: 6, verified: false,
        outcomes: [
            { k: 'strike', t: 'Страйк', set: [6] }, { k: 'miss', t: 'Промах', set: [1] },
            { k: 'p1', t: 'Сбито 1 / 6', set: [2] }, { k: 'p3', t: 'Сбито 3 / 6', set: [3] },
            { k: 'p4', t: 'Сбито 4 / 6', set: [4] }, { k: 'p5', t: 'Сбито 5 / 6', set: [5] },
        ],
        layout: [['strike', 'miss'], ['p1', 'p3'], ['p4', 'p5']],
    },
    slots: {
        emoji: '🎰', title: 'Слоты', values: 64, verified: true,   // декодирование 4×4×4 общеизвестно
        outcomes: [
            { k: 's7', t: '3 Семёрки', set: slotSet(r => r[0] === 3 && r[1] === 3 && r[2] === 3) },
            { k: 'lem', t: '3 Лимона', set: slotSet(r => r[0] === 2 && r[1] === 2 && r[2] === 2) },
            { k: 'grp', t: '3 Винограда', set: slotSet(r => r[0] === 1 && r[1] === 1 && r[2] === 1) },
            { k: 'bar', t: '3 Бара', set: slotSet(r => r[0] === 0 && r[1] === 0 && r[2] === 0) },
            { k: 'any3', t: 'Любая комбинация', set: slotSet(r => r[0] === r[1] && r[1] === r[2]) },
            { k: 'uniq', t: 'Уникальные символы', set: slotSet(r => r[0] !== r[1] && r[1] !== r[2] && r[0] !== r[2]) },
        ],
        layout: [['s7', 'lem'], ['grp', 'bar'], ['any3'], ['uniq']],
        gated: [{ t: 'Точный исход', note: 'Правила «Точного исхода» не заданы — режим выключен.' }],
    },
};
const GAME_ORDER = ['dice', 'football', 'basket', 'darts', 'bowling', 'slots'];

// Авторские игры: бот сам берёт число 1..N, выигрыш только если выпало N (шанс 1/N → множитель xN).
const AUTHOR = [
    { id: 'compass', e: '🧭', t: 'Компас', n: 2 }, { id: 'fish', e: '🐟', t: 'Рыба', n: 3 },
    { id: 'balloon', e: '🎈', t: 'Шарик', n: 5 }, { id: 'mine', e: '💣', t: 'Мина', n: 10 },
    { id: 'pad', e: '🎮', t: 'Геймпад', n: 20 }, { id: 'butterfly', e: '🦋', t: 'Бабочка', n: 30 },
    { id: 'rocket', e: '🚀', t: 'Ракета', n: 50 }, { id: 'whale', e: '🐋', t: 'Кит', n: 100 },
];

// ---------------- УТИЛИТЫ ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fmtShort(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    if (n < 1000) return String(n);
    const units = [['t', 1e12], ['b', 1e9], ['m', 1e6], ['k', 1e3]];
    for (const [s, v] of units) {
        if (n >= v) {
            const x = n / v;
            if (x >= 1e6) return x.toExponential(2).replace('+', '') + s;
            const str = x >= 100 ? String(Math.floor(x)) : x >= 10 ? String(Math.floor(x * 10) / 10) : String(Math.floor(x * 100) / 100);
            return str + s;
        }
    }
    return String(n);
}
function fmtMult(x) {
    if (x >= 1000) return String(Math.floor(x));
    return String(Math.floor(x * 100 + 1e-9) / 100);
}
const outcomeMult = (game, oc, n) => Math.pow(game.values / oc.set.length, n);
const throwsMax = (game) => (game.emoji === '🎲' ? CFG.MAX_THROWS_DICE : CFG.MAX_THROWS_OTHER);
const payoutFor = (stake, mult) => Math.floor(stake * mult * (1 - CFG.HOUSE_EDGE) + 1e-9);

module.exports = function initGroupGames(deps) {
    const { bot, spendableBalance, queueWallet, isAccountFrozen, isAdminId, parseAmount, rememberUser } = deps;
    const esc = deps.escapeHtml || ((s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
    const delayScale = typeof deps.delayScale === 'number' ? deps.delayScale : 1;   // 0 в тестах

    // ---- хранилище: ставка, оборот, накопленный рейкбек ----
    let db = {};
    try { db = JSON.parse(fs.readFileSync(deps.dataFile || DATA_FILE, 'utf8')); } catch (e) { db = {}; }
    let saveTimer = null;
    function saveSoon() {
        if (saveTimer) return;
        saveTimer = setTimeout(() => { saveTimer = null; try { fs.writeFileSync(deps.dataFile || DATA_FILE, JSON.stringify(db), 'utf8'); } catch (e) { /* пусто */ } }, 1500);
        if (saveTimer.unref) saveTimer.unref();
    }
    function rec(uid) {
        const k = String(uid);
        if (!db[k]) db[k] = { bet: CFG.DEFAULT_BET, turnover: 0, rake: 0 };
        return db[k];
    }
    const busy = new Set();

    // ---- вспомогательное ----
    const nameOf = (u) => esc(u.first_name || (u.username ? '@' + u.username : 'Игрок'));
    const mention = (u) => (u.username ? '@' + esc(u.username) : `<a href="tg://user?id=${u.id}">${nameOf(u)}</a>`);
    function balanceOf(uid) { const b = spendableBalance(uid); return b === null ? null : b; }
    function footer(uid) {
        const b = balanceOf(uid);
        return `➕ Ставка: ${fmtShort(rec(uid).bet)} ${CFG.CUR}\n💰 Баланс: ${fmtShort(b || 0)} ${CFG.CUR}`;
    }
    async function sendDiceMsg(chatId, emoji) {
        if (typeof bot.sendDice === 'function') return bot.sendDice(chatId, { emoji });
        return bot._request('sendDice', { form: { chat_id: chatId, emoji } });
    }
    const safe = (p) => Promise.resolve(p).catch((e) => { console.error('groupgames:', e && e.message); });

    // ---- меню ----
    const cb = (o, ...parts) => ['g', o, ...parts].join('|');
    function mainMenu(o, user) {
        const rows = [];
        const btns = GAME_ORDER.map((id) => {
            const g = GAMES[id];
            const max = Math.max(...g.outcomes.map((x) => outcomeMult(g, x, 1)));
            const maxAll = max ** throwsMax(g);
            return { text: `${g.emoji} (до x${fmtMult(maxAll)})`, callback_data: cb(o, 'G', id, 1) };
        });
        rows.push(btns.slice(0, 3), btns.slice(3, 6));
        rows.push([{ text: '🎭 Авторские', callback_data: cb(o, 'A') }]);
        return {
            text: `${mention(user)}, 🎮 Выберите игру, на которую хотите сделать ставку!\n\n${footer(user.id)}`,
            markup: { inline_keyboard: rows },
        };
    }
    function gameMenu(o, user, gid, n) {
        const g = GAMES[gid];
        const tm = throwsMax(g);
        n = Math.min(Math.max(1, n | 0), tm);
        const rows = [];
        rows.push(GAME_ORDER.map((id) => ({ text: id === gid ? `•${GAMES[id].emoji}•` : GAMES[id].emoji, callback_data: cb(o, 'G', id, 1) })));
        const thr = [];
        for (let i = 1; i <= tm; i++) {
            const label = i === 1 ? '1 Бросок' : `${i} Броска`;
            thr.push({ text: i === n ? `• ${label} •` : label, callback_data: cb(o, 'G', gid, i) });
        }
        rows.push(thr);
        const byKey = Object.fromEntries(g.outcomes.map((x) => [x.k, x]));
        for (const line of g.layout) {
            rows.push(line.map((k) => {
                const oc = byKey[k];
                return { text: `${oc.t} (x${fmtMult(outcomeMult(g, oc, n))})`, callback_data: cb(o, 'P', gid, n, k) };
            }));
        }
        for (const gt of g.gated || []) rows.push([{ text: gt.t, callback_data: cb(o, 'X', gid) }]);
        rows.push([{ text: '< Назад', callback_data: cb(o, 'M') }]);
        return {
            text: `${mention(user)}, ${g.emoji} Выберите исход игры, на который хотите сделать ставку!\n\n${footer(user.id)}`,
            markup: { inline_keyboard: rows },
        };
    }
    function authorMenu(o, user) {
        const btn = (a) => ({ text: `${a.e} x${a.n}`, callback_data: cb(o, 'Q', a.id) });
        return {
            text: `${mention(user)}, 🎮 Выберите авторскую игру!\n\n${footer(user.id)}`,
            markup: { inline_keyboard: [AUTHOR.slice(0, 4).map(btn), AUTHOR.slice(4).map(btn), [{ text: '< Назад', callback_data: cb(o, 'M') }]] },
        };
    }
    function rakeMenu(o, user) {
        const avail = Math.floor(rec(user.id).rake);
        return {
            text: `💸 <b>Рейкбек</b> — бонус, который моментально возвращает часть ставки игроку.\n\n💸 Доступно: ${fmtShort(avail)} ${CFG.CUR}`,
            markup: { inline_keyboard: [[{ text: `📥 Забрать ${fmtShort(avail)}${CFG.CUR}`, callback_data: cb(o, 'C') }], [{ text: '< Назад', callback_data: cb(o, 'M') }]] },
        };
    }
    async function show(chatId, replyTo, menu) {
        return bot.sendMessage(chatId, menu.text, {
            parse_mode: 'HTML', reply_markup: menu.markup, reply_to_message_id: replyTo, allow_sending_without_reply: true, disable_web_page_preview: true,
        });
    }
    async function edit(q, menu) {
        try {
            await bot.editMessageText(menu.text, {
                chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'HTML', reply_markup: menu.markup, disable_web_page_preview: true,
            });
        } catch (e) { if (!/not modified/i.test(e && e.message)) console.error('groupgames edit:', e && e.message); }
    }

    // ---- ставка ----
    function parseBetArg(arg, uid) {
        const s = String(arg || '').trim().toLowerCase();
        if (/^(вб|ва-?банк|на ?вс[её]|вс[её]|all|allin)$/.test(s)) {
            const b = balanceOf(uid);
            if (b === null) return { err: 'open_app' };
            if (b < CFG.MIN_BET) return { err: 'empty' };
            return { amount: Math.floor(b) };
        }
        const m = s.match(/^(\d+(?:[.,]\d+)?)\s*([kmbtкмбт]?)$/i);
        if (!m) return { err: 'bad' };
        const amount = parseAmount(m[1], m[2]);
        if (!amount || amount < CFG.MIN_BET) return { err: 'min' };
        return { amount };
    }
    const BET_ERR = {
        open_app: '⚠️ Сначала откройте Crown Casino один раз — я не знаю ваш баланс.',
        empty: '💰 Баланс пуст — ва-банк невозможен.',
        bad: '⚠️ Укажите сумму: <code>ставка 100</code>, <code>ставка 1.5k</code> или <code>ставка вб</code>',
        min: `⚠️ Минимальная ставка — ${CFG.MIN_BET}.`,
    };

    // ---- расчёт и отправка результата ----
    function settleAndText({ user, stake, win, mult, lines, emoji }) {
        const r = rec(user.id);
        let payout = 0;
        if (win) { payout = payoutFor(stake, mult); if (payout > 0) queueWallet(user.id, { credit: payout }); }
        r.turnover += stake; r.rake += stake * CFG.RAKE_RATE; saveSoon();
        const head = win ? `⏫ Выигрывает ${fmtShort(payout)} ${CFG.CUR}` : `⏬ Проигрывает ${fmtShort(stake)} ${CFG.CUR}`;
        const mark = win ? '✅' : '❌';
        return `${mention(user)}, ${head}\nСтавка ${fmtShort(stake)} ${CFG.CUR}${mark}${fmtMult(mult)}\n${lines}\n\n${footer(user.id)}`;
    }
    // Проверка и резерв ставки. Возвращает {stake} или {err}
    function reserve(user) {
        const stake = rec(user.id).bet;
        const bal = balanceOf(user.id);
        if (bal === null) return { err: 'Сначала откройте Crown Casino один раз.' };
        if (bal < stake) return { err: `Недостаточно средств. Баланс: ${fmtShort(bal)}, ставка: ${fmtShort(stake)}` };
        queueWallet(user.id, { debit: stake });
        return { stake };
    }

    async function playDice(q, gid, n, key) {
        const user = q.from, chatId = q.message.chat.id;
        const g = GAMES[gid]; const oc = g.outcomes.find((x) => x.k === key);
        if (!oc) return safe(bot.answerCallbackQuery(q.id));
        n = Math.min(Math.max(1, n | 0), throwsMax(g));
        const res = reserve(user);
        if (res.err) return safe(bot.answerCallbackQuery(q.id, { text: res.err, show_alert: true }));
        busy.add(String(user.id));
        let settled = false;
        const stake = res.stake;
        try {
            await safe(bot.answerCallbackQuery(q.id));
            await safe(bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }));
            const mult = outcomeMult(g, oc, n);
            const thr = n > 1 ? ` · ${n} броска (x${fmtMult(mult)})` : '';
            await bot.sendMessage(chatId, `<b>${nameOf(user)}</b> ставит ${fmtShort(stake)}${CFG.CUR}\n${g.emoji} ${esc(oc.t)}${thr}`, { parse_mode: 'HTML' });
            const values = [];
            for (let i = 0; i < n; i++) {
                const m = await sendDiceMsg(chatId, g.emoji);
                const v = m && m.dice && m.dice.value;
                if (!m || !m.dice || m.dice.emoji !== g.emoji || !(v >= 1 && v <= g.values)) throw new Error('bad dice response');
                values.push(v);
                await sleep((CFG.ANIM_MS[g.emoji] || 3500) * delayScale);
            }
            const win = values.every((v) => oc.set.includes(v));
            const lines = win
                ? `Победа, выпало: ${values.join(', ')}`
                : `Выпало: ${values.join(', ')}, а надо было: ${esc(oc.t)}${n > 1 ? ' в каждом броске' : ''}`;
            settled = true;
            await bot.sendMessage(chatId, settleAndText({ user, stake, win, mult, lines, emoji: g.emoji }), { parse_mode: 'HTML' });
        } catch (e) {
            console.error('groupgames playDice:', e && e.message);
            if (!settled) { queueWallet(user.id, { credit: stake }); safe(bot.sendMessage(chatId, `⚠️ ${nameOf(user)}, не удалось провести игру — ставка возвращена.`, { parse_mode: 'HTML' })); }
        } finally { busy.delete(String(user.id)); }
    }

    async function playAuthor(q, id) {
        const user = q.from, chatId = q.message.chat.id;
        const a = AUTHOR.find((x) => x.id === id);
        if (!a) return safe(bot.answerCallbackQuery(q.id));
        const res = reserve(user);
        if (res.err) return safe(bot.answerCallbackQuery(q.id, { text: res.err, show_alert: true }));
        busy.add(String(user.id));
        let settled = false;
        const stake = res.stake;
        try {
            await safe(bot.answerCallbackQuery(q.id));
            await safe(bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }));
            await bot.sendMessage(chatId, `<b>${nameOf(user)}</b> ставит ${fmtShort(stake)}${CFG.CUR}\n${a.e} ${a.t}`, { parse_mode: 'HTML' });
            await bot.sendMessage(chatId, a.e);
            await sleep(1200 * delayScale);
            const rolled = crypto.randomInt(1, a.n + 1);
            const win = rolled === a.n;
            const lines = win ? `Победа, выпало число ${rolled}` : `Выпало число ${rolled}, а надо было ${a.n}`;
            settled = true;
            await bot.sendMessage(chatId, settleAndText({ user, stake, win, mult: a.n, lines, emoji: a.e }), { parse_mode: 'HTML' });
        } catch (e) {
            console.error('groupgames playAuthor:', e && e.message);
            if (!settled) { queueWallet(user.id, { credit: stake }); safe(bot.sendMessage(chatId, `⚠️ ${nameOf(user)}, не удалось провести игру — ставка возвращена.`, { parse_mode: 'HTML' })); }
        } finally { busy.delete(String(user.id)); }
    }

    // ---- текстовые команды ----
    const RE_BET = /^(?:\/bet(?:@\w+)?|ставка)\s+(.+)$/i;
    const RE_ALLIN = /^(?:вб|ва-?банк|на\s?вс[её])$/i;
    const RE_GAMES = /^(?:\/games(?:@\w+)?|игры)$/i;
    const RE_RAKE = /^(?:\/rake(?:@\w+)?|рейк|рейкбек)$/i;
    const RE_PROBE = /^\/dicetest(?:@\w+)?\s*(\S+)?/i;

    bot.on('message', async (msg) => {
        try {
            if (!msg || !msg.from || msg.from.is_bot || typeof msg.text !== 'string') return;
            const text = msg.text.trim();
            const isGroup = msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup');
            let kind = null, arg = null, m;
            if ((m = text.match(RE_BET))) { kind = 'bet'; arg = m[1]; }
            else if (RE_ALLIN.test(text)) { kind = 'bet'; arg = 'вб'; }
            else if (RE_GAMES.test(text)) kind = 'games';
            else if (RE_RAKE.test(text)) kind = 'rake';
            else if ((m = text.match(RE_PROBE))) { kind = 'probe'; arg = m[1] || ''; }
            if (!kind) return;
            if (!isAdminId(msg.from.id) && isAccountFrozen(msg.from.id)) return;
            rememberUser(msg.from);

            if (!isGroup) {
                if (text.startsWith('/')) await safe(bot.sendMessage(msg.chat.id, '🎮 Игры в этом режиме работают только в групповых чатах. Добавьте бота в группу и напишите там <code>ставка 100</code>.', { parse_mode: 'HTML' }));
                return;
            }
            const user = msg.from, chatId = msg.chat.id, o = String(user.id);

            if (kind === 'probe') {
                if (!isAdminId(user.id)) return;
                const emoji = ['🎲', '🎯', '🎳', '⚽', '🏀', '🎰'].find((e) => (arg || '').includes(e));
                if (!emoji) { await safe(bot.sendMessage(chatId, 'Использование: /dicetest 🎲|🎯|🎳|⚽|🏀|🎰 — бот бросит эмодзи и напишет значение.')); return; }
                const d = await sendDiceMsg(chatId, emoji);
                await sleep((CFG.ANIM_MS[emoji] || 3500) * delayScale);
                await safe(bot.sendMessage(chatId, `${emoji} value = ${d && d.dice ? d.dice.value : '?'}`, { reply_to_message_id: d && d.message_id }));
                return;
            }
            if (busy.has(o)) return;
            if (kind === 'bet') {
                const r = parseBetArg(arg, user.id);
                if (r.err) { await safe(bot.sendMessage(chatId, BET_ERR[r.err], { parse_mode: 'HTML', reply_to_message_id: msg.message_id, allow_sending_without_reply: true })); return; }
                rec(user.id).bet = r.amount; saveSoon();
                await show(chatId, msg.message_id, mainMenu(o, user));
            } else if (kind === 'games') {
                await show(chatId, msg.message_id, mainMenu(o, user));
            } else if (kind === 'rake') {
                await show(chatId, msg.message_id, rakeMenu(o, user));
            }
        } catch (e) { console.error('groupgames message:', e && e.message); }
    });

    // ---- кнопки ----
    bot.on('callback_query', async (q) => {
        try {
            const data = q && q.data;
            if (typeof data !== 'string' || !data.startsWith('g|')) return;       // чужие callback'и не трогаем
            const [, o, act, a1, a2, a3] = data.split('|');
            if (String(q.from.id) !== o) { await safe(bot.answerCallbackQuery(q.id, { text: 'Это не ваши кнопки', show_alert: true })); return; }
            if (!q.message) return;
            if (!isAdminId(q.from.id) && isAccountFrozen(q.from.id)) { await safe(bot.answerCallbackQuery(q.id)); return; }
            if (busy.has(o)) { await safe(bot.answerCallbackQuery(q.id, { text: 'Подождите, игра ещё идёт', show_alert: false })); return; }
            const user = q.from;
            if (act === 'M') { await safe(bot.answerCallbackQuery(q.id)); await edit(q, mainMenu(o, user)); }
            else if (act === 'A') { await safe(bot.answerCallbackQuery(q.id)); await edit(q, authorMenu(o, user)); }
            else if (act === 'G') {
                if (!GAMES[a1]) { await safe(bot.answerCallbackQuery(q.id)); return; }
                await safe(bot.answerCallbackQuery(q.id)); await edit(q, gameMenu(o, user, a1, parseInt(a2, 10) || 1));
            }
            else if (act === 'X') {
                const g = GAMES[a1]; const gt = g && g.gated && g.gated[0];
                await safe(bot.answerCallbackQuery(q.id, { text: gt ? gt.note : 'Недоступно', show_alert: true }));
            }
            else if (act === 'P') { if (!GAMES[a1]) { await safe(bot.answerCallbackQuery(q.id)); return; } await playDice(q, a1, parseInt(a2, 10) || 1, a3); }
            else if (act === 'Q') { await playAuthor(q, a1); }
            else if (act === 'R') { await safe(bot.answerCallbackQuery(q.id)); await edit(q, rakeMenu(o, user)); }
            else if (act === 'C') {
                const r = rec(user.id);
                const avail = Math.floor(r.rake);
                if (avail < 1) { await safe(bot.answerCallbackQuery(q.id, { text: 'Пока нечего забирать', show_alert: true })); return; }
                r.rake -= avail; saveSoon();
                queueWallet(user.id, { credit: avail });
                await safe(bot.answerCallbackQuery(q.id, { text: `Получено ${fmtShort(avail)} ${CFG.CUR}` }));
                await edit(q, rakeMenu(o, user));
            }
            else await safe(bot.answerCallbackQuery(q.id));
        } catch (e) { console.error('groupgames callback:', e && e.message); }
    });

    return { GAMES, AUTHOR, CFG, fmtShort, fmtMult };
};
module.exports.fmtShort = fmtShort;
module.exports.fmtMult = fmtMult;
module.exports.GAMES = GAMES;
module.exports.AUTHOR = AUTHOR;
module.exports.CFG = CFG;
