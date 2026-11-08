// ============================================================
//  server.js — бот Crown Casino: раздаёт Mini App и принимает
//  оплату Telegram Stars за премиум-статус (webhook + анти-слип)
// ============================================================
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ====== КОНФИГ ======
const BOT_TOKEN = process.env.BOT_TOKEN || '';
if (!BOT_TOKEN) { console.error('❌ Не задан BOT_TOKEN.'); process.exit(1); }

const PORT = process.env.PORT || 10000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
if (!EXTERNAL_URL) { console.error('❌ Не найден RENDER_EXTERNAL_URL или WEBHOOK_URL.'); process.exit(1); }

// Секрет вебхука: Telegram присылает его в заголовке
// X-Telegram-Bot-Api-Secret-Token на каждый апдейт, сервер сверяет его перед
// обработкой — второй, независимый барьер сверх самого пути (который завязан
// на BOT_TOKEN и может утечь). Можно задать свой через переменную окружения
// WEBHOOK_SECRET, иначе генерируется случайный при каждом старте (тогда
// setWebHook ниже переустановит его автоматически при каждом рестарте).
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex');

const PREMIUM_PRICE_STARS = 25;
const PREMIUM_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const APP_TEMPLATE_FILE = path.join(__dirname, 'crown_casino_app.html'); // шаблон с {{ключами}}
const LOADER_FILE = path.join(__dirname, 'loader.html');
const SUPPORTED_LANGS = ['ru', 'ro', 'en'];
const DEFAULT_LANG = 'ru';
const LANG_DICT_DIR = require('fs').existsSync(path.join(__dirname, 'lang')) ? path.join(__dirname, 'lang') : __dirname; // lang/ru.json, lang/ro.json, lang/en.json

// Короткое имя Mini App, заданное в @BotFather (Bot Settings → Mini App →
// Edit Mini App → его "short name", например из ссылки t.me/mybot/casino —
// тут нужно "casino"). Без него инлайн-переводы (send/receive) открываться
// не будут как полноценный Mini App с initData — только обычной веб-страницей.
const MINI_APP_SHORT_NAME = process.env.MINI_APP_SHORT_NAME || '';
let BOT_USERNAME = '';

// ====== ХРАНЕНИЕ ПРЕМИУМ-СТАТУСОВ ======
// Простой JSON-файл рядом с сервером. ВАЖНО: на бесплатных планах Render диск
// не гарантированно переживает передеплой — для продакшена замените на
// настоящую БД, интерфейс load/grant можно оставить тем же.
const PREMIUM_FILE = path.join(__dirname, 'premium.json');

function loadPremiumData() {
    try { return JSON.parse(fs.readFileSync(PREMIUM_FILE, 'utf8')); }
    catch (e) { return {}; }
}
function savePremiumData(data) {
    fs.writeFileSync(PREMIUM_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function getPremiumUntil(userId) {
    const data = loadPremiumData();
    const rec = data[String(userId)];
    return rec ? rec.premiumUntil : 0;
}
// Начисляем премиум ТОЛЬКО отсюда, и вызываем это только из обработчика
// successful_payment ниже — там userId берётся из подтверждённого Telegram
// сообщения о реальном платеже, а не из того, что мог бы прислать клиент.
function grantPremiumDays(userId, days) {
    const data = loadPremiumData();
    const now = Date.now();
    const rec = data[String(userId)] || { premiumUntil: 0 };
    const base = rec.premiumUntil > now ? rec.premiumUntil : now;
    rec.premiumUntil = base + days * DAY_MS;
    data[String(userId)] = rec;
    savePremiumData(data);
    return rec.premiumUntil;
}

// ====== ЯЗЫК ИГРОКА (ru/ro/en) ======
// Выбор языка делается один раз на экране loader.html и запоминается здесь
// по Telegram ID — дальше сервер сразу отдаёт уже готовый переведённый HTML,
// без JS-переключения на клиенте (поэтому никакого "лага" при переводе нет).
const LANGUAGES_FILE = path.join(__dirname, 'languages.json');
function loadLanguages() {
    try { return JSON.parse(fs.readFileSync(LANGUAGES_FILE, 'utf8')); }
    catch (e) { return {}; }
}
function saveLanguages(data) {
    fs.writeFileSync(LANGUAGES_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function getUserLanguage(userId) {
    const data = loadLanguages();
    const rec = data[String(userId)];
    return rec && SUPPORTED_LANGS.includes(rec.lang) ? rec.lang : null;
}
function setUserLanguage(userId, lang) {
    const data = loadLanguages();
    data[String(userId)] = { lang, updatedAt: Date.now() };
    saveLanguages(data);
}

// ====== РЕНДЕР MINI APP ПОД ЯЗЫК ======
// crown_casino_app.html — это шаблон с {{ключами}} вместо текста. При старте
// сервера подставляем переводы из lang/<код>.json и держим готовый HTML каждого
// языка в памяти (renderedAppCache) — запрос отдаёт уже готовую строку, без
// какой-либо работы по переводу на лету.
function loadLangDict(lang) {
    const file = path.join(LANG_DICT_DIR, `${lang}.json`);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error(`❌ Не удалось прочитать словарь языка ${lang}:`, e.message); return {}; }
}
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
const renderedAppCache = {};
function renderAppForLang(lang) {
    if (renderedAppCache[lang]) return renderedAppCache[lang];
    const template = fs.readFileSync(APP_TEMPLATE_FILE, 'utf8');
    const dict = loadLangDict(lang);
    let html = template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (full, key) => {
        if (key === '__LANG_CODE__') return lang;
        if (key === '__LANG_JSON__') return JSON.stringify(dict).replace(/</g, '\\u003c');
        if (Object.prototype.hasOwnProperty.call(dict, key)) return escapeHtml(dict[key]);
        console.warn(`⚠️ Нет перевода для ключа "${key}" в языке ${lang}`);
        return full; // оставляем как есть, чтобы было видно проблему
    });
    renderedAppCache[lang] = html;
    return html;
}
// Прогреваем кэш при старте, чтобы первый запрос игрока был быстрым
for (const l of SUPPORTED_LANGS) { try { renderAppForLang(l); } catch (e) { console.error(`❌ Рендер ${l} не удался:`, e.message); } }

// ====== ПЕРЕВОДЫ МЕЖДУ ИГРОКАМИ (инлайн-режим: send / receive) ======
// Баланс зиксов в игре — клиентский (как и весь остальной игровой баланс),
// поэтому зачисления/списания по переводам не применяются мгновенно на
// сервере, а "откладываются" в wallet-pending.json и подхватываются клиентом
// при следующем открытии приложения — так же, как уже работают награды
// лидерборда (pendingCrowns / /api/claim-reward).
const TRANSFERS_FILE = path.join(__dirname, 'transfers.json');
function loadTransfers() { try { return JSON.parse(fs.readFileSync(TRANSFERS_FILE, 'utf8')); } catch (e) { return {}; } }
function saveTransfers(data) { fs.writeFileSync(TRANSFERS_FILE, JSON.stringify(data, null, 2), 'utf8'); }

const WALLET_FILE = path.join(__dirname, 'wallet-pending.json');
function loadWalletPending() { try { return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8')); } catch (e) { return {}; } }
function saveWalletPending(data) { fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2), 'utf8'); }
function queueWallet(userId, { credit = 0, debit = 0 }) {
    const data = loadWalletPending();
    const key = String(userId);
    const rec = data[key] || { credit: 0, debit: 0 };
    rec.credit = (rec.credit || 0) + credit;
    rec.debit = (rec.debit || 0) + debit;
    data[key] = rec;
    saveWalletPending(data);
}
function flushWalletPending(userId) {
    const data = loadWalletPending();
    const key = String(userId);
    const rec = data[key];
    if (!rec) return { credit: 0, debit: 0 };
    delete data[key];
    saveWalletPending(data);
    return { credit: rec.credit || 0, debit: rec.debit || 0 };
}
// ---- Реестр @username -> id (чтобы знать язык получателя по его нику) ----
const USERNAMES_FILE = path.join(__dirname, 'usernames.json');
let usernamesCache = null;
function loadUsernames() {
    if (usernamesCache) return usernamesCache;
    try { usernamesCache = JSON.parse(fs.readFileSync(USERNAMES_FILE, 'utf8')); } catch (e) { usernamesCache = {}; }
    return usernamesCache;
}
function rememberUser(user) {
    try {
        if (!user || !user.id || !user.username) return;
        const map = loadUsernames();
        const key = String(user.username).toLowerCase();
        if (map[key] === String(user.id)) return;
        map[key] = String(user.id);
        fs.writeFileSync(USERNAMES_FILE, JSON.stringify(map), 'utf8');
    } catch (e) { /* пусто */ }
}
// Язык получателя: по @нику; если не знаем его или он ещё не выбирал язык — английский
function recipientLang(targetUsername) {
    const id = loadUsernames()[String(targetUsername || '').toLowerCase()];
    return (id && getUserLanguage(id)) || 'en';
}

// ---- Известный серверу баланс игрока (его присылает клиент) ----
// Нужен, чтобы при send/receive проверять, хватает ли зиксов.
const BALANCES_FILE = path.join(__dirname, 'balances.json');
let balancesCache = null;
function loadBalances() {
    if (balancesCache) return balancesCache;
    try { balancesCache = JSON.parse(fs.readFileSync(BALANCES_FILE, 'utf8')); } catch (e) { balancesCache = {}; }
    return balancesCache;
}
let balancesSaveTimer = null;
function saveBalancesSoon() {
    if (balancesSaveTimer) return;
    balancesSaveTimer = setTimeout(() => {
        balancesSaveTimer = null;
        try { fs.writeFileSync(BALANCES_FILE, JSON.stringify(balancesCache || {}), 'utf8'); } catch (e) { /* пусто */ }
    }, 2000);
}
function setKnownBalance(userId, coins) {
    const b = loadBalances();
    b[String(userId)] = { coins: Math.floor(coins), ts: Date.now() };
    saveBalancesSoon();
}
// Баланс с учётом ещё не применённых клиентом переводов.
// null — игрок ещё ни разу не присылал баланс.
function getEffectiveBalance(userId) {
    const rec = loadBalances()[String(userId)];
    if (!rec) return null;
    const w = loadWalletPending()[String(userId)] || { credit: 0, debit: 0 };
    return rec.coins + (w.credit || 0) - (w.debit || 0);
}
function isAdminId(userId) { return String(userId) === ADMIN_TELEGRAM_ID; }

// ---- Суммы: 500, 5k, 2.5m, 1b, 67b, 1t (также к/м/б/т) ----
const AMOUNT_MULT = { '': 1, k: 1e3, 'к': 1e3, m: 1e6, 'м': 1e6, b: 1e9, 'б': 1e9, t: 1e12, 'т': 1e12 };
const MAX_TRANSFER = 1e15;
function parseAmount(numStr, suffix) {
    const n = parseFloat(String(numStr).replace(',', '.'));
    const mult = AMOUNT_MULT[String(suffix || '').toLowerCase()];
    if (!isFinite(n) || !mult) return 0;
    return Math.floor(n * mult + 1e-6);
}
function fmtNumber(n, lang) {
    const sep = lang === 'en' ? ',' : lang === 'ro' ? '.' : ' ';
    return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
function zixWord(n, lang) {
    if (lang !== 'ru') return 'zix';
    const a = Math.floor(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return 'зиксов';
    if (b > 1 && b < 5) return 'зикса';
    if (b === 1) return 'зикс';
    return 'зиксов';
}
function fmtZix(n, lang) { return `${fmtNumber(n, lang)} ${zixWord(n, lang)}`; }

function generateTransferId() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
// Ссылка на экран подтверждения чека — открывается как полноценный Mini App
// (с initData), поэтому используется формат t.me/<bot>/<shortname>?startapp=
function transferDeepLink(id) {
    if (!BOT_USERNAME || !MINI_APP_SHORT_NAME) return null;
    return `https://t.me/${BOT_USERNAME}/${MINI_APP_SHORT_NAME}?startapp=${id}`;
}

// ====== ХРАНЕНИЕ ПЛАТЕЖЕЙ (для возможности возврата) ======
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');
function loadPayments() {
    try { return JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8')); }
    catch (e) { return {}; }
}
function savePayments(data) {
    fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ====== ЛИМИТ ВОЗВРАТОВ: не более 2 в сутки на пользователя ======
const REFUNDS_FILE = path.join(__dirname, 'refunds.json');
function loadRefundCounts() {
    try { return JSON.parse(fs.readFileSync(REFUNDS_FILE, 'utf8')); }
    catch (e) { return {}; }
}
function saveRefundCounts(data) {
    fs.writeFileSync(REFUNDS_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function todayKey() { return new Date().toISOString().slice(0, 10); }
function getRefundCountToday(userId) {
    const data = loadRefundCounts();
    const rec = data[userId];
    if (!rec || rec.date !== todayKey()) return 0;
    return rec.count;
}
function incRefundCount(userId) {
    const data = loadRefundCounts();
    const key = todayKey();
    if (!data[userId] || data[userId].date !== key) { data[userId] = { date: key, count: 1 }; }
    else { data[userId].count += 1; }
    saveRefundCounts(data);
}

// ====== ПРОВЕРКА TELEGRAM WEBAPP initData ======
// Официальный алгоритм Telegram: секретный ключ = HMAC-SHA256("WebAppData", BOT_TOKEN),
// затем сверяем HMAC-SHA256(секрет, data_check_string) с присланным hash.
// Это единственный надёжный способ узнать РЕАЛЬНОГО пользователя из Mini App —
// без этой проверки любой мог бы прислать чужой user_id и запросить чужой возврат.
function validateInitData(initData) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return null;
        params.delete('hash');
        const pairs = [];
        for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
        pairs.sort();
        const dataCheckString = pairs.join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (computedHash !== hash) return null;
        const userJson = params.get('user');
        if (!userJson) return null;
        const user = JSON.parse(userJson);
        if (user && user.id) rememberUser(user);
        return user && user.id ? user : null; // возвращаем весь объект user (нужны id + имя для лидерборда)
    } catch (e) {
        return null;
    }
}

// ====== ЛИДЕРБОРД / ОЧКИ ======
// Очки живут только здесь (на сервере) — иначе рейтинг между игроками
// невозможен по определению, зиксы при этом остаются клиентскими, как и раньше.
// Раз в CYCLE_MS сервер сам подводит итоги: топ-3 получают премиум + зиксы,
// остальные — свои очки конвертированные в зиксы. Зиксы начисляются не сразу,
// а "откладываются" в pendingCrowns и забираются клиентом через /api/claim-reward
// при следующем открытии приложения (зиксы ведь не хранятся на сервере вообще).
const POINTS_FILE = path.join(__dirname, 'points.json');
const ADMIN_TELEGRAM_ID = '6811074441';
const CRYPTO_FILE = path.join(__dirname, 'crypto_game.json');
const CRYPTO_START_PRICE = 1000;
const CRYPTO_TICK_MS = 2000;           // курс двигается каждые 2 секунды
const CANDLE_TICKS = 15;               // одна свеча = 15 тиков = 30 секунд
const MAX_CANDLES = 80;
const CRYPTO_DAILY_GROWTH = 0.02;      // «якорь» курса растёт на ~2% в сутки
const CRYPTO_DRIFT_PER_TICK = Math.log(1 + CRYPTO_DAILY_GROWTH) / (DAY_MS / CRYPTO_TICK_MS);
const CRYPTO_IMPACT_PER_50M = 0.02;    // +2% к курсу за каждые 50 млн зиксов в сделке
const CRYPTO_IMPACT_STEP = 50000000;
const CRYPTO_MAX_IMPACT = 5;           // потолок за одну сделку: +500% (курс ×6); продажа — симметрично (÷6)
const CRYPTO_REVERT = 0.012;           // сила притяжения курса к растущему якорю
let cryptoCache = null;

function freshCrypto() {
    const p = CRYPTO_START_PRICE;
    return { price: p, ath: p, atl: p, direction: 'up', lastTick: Date.now(), trend: 0, candleTicks: 0,
             anchorBase: p, anchorStart: Date.now(), candles: [{ o: p, h: p, l: p, c: p }] };
}
function loadCryptoGame() {
    if (cryptoCache) return cryptoCache;
    let c;
    try { c = JSON.parse(fs.readFileSync(CRYPTO_FILE, 'utf8')); } catch (e) { c = freshCrypto(); }
    // миграция со старых форматов
    if (!Array.isArray(c.candles) || !c.candles.length) { const p = c.price || CRYPTO_START_PRICE; c.candles = [{ o: p, h: p, l: p, c: p }]; c.candleTicks = 0; }
    if (typeof c.ath !== 'number') c.ath = Math.max(c.price, ...(c.history || [c.price]));
    if (typeof c.atl !== 'number') c.atl = Math.min(c.price, ...(c.history || [c.price]));
    if (typeof c.trend !== 'number') c.trend = 0;
    if (typeof c.candleTicks !== 'number') c.candleTicks = 0;
    if (typeof c.anchorBase !== 'number' || typeof c.anchorStart !== 'number') { c.anchorBase = c.price; c.anchorStart = Date.now(); }
    delete c.history;
    cryptoCache = c;
    return c;
}
function saveCryptoGame(c) {
    cryptoCache = c;
    fs.writeFile(CRYPTO_FILE, JSON.stringify(c), (e) => { if (e) console.error('crypto save error:', e.message); });
}
// «Справедливая» цена: растёт ~2% в сутки. Курс колеблется вокруг неё, поэтому за день итог — плюс пару процентов.
function cryptoAnchor(c, t) {
    return c.anchorBase * Math.exp(Math.log(1 + CRYPTO_DAILY_GROWTH) * ((t - c.anchorStart) / DAY_MS));
}
function rebaseCryptoAnchor(c) { c.anchorBase = c.price; c.anchorStart = Date.now(); c.trend = 0; }

// Единая точка изменения цены: обновляет курс, пик/минимум и текущую свечу
function applyCryptoPrice(c, p) {
    p = Math.max(1, Math.round(p * 100) / 100);
    if (p === c.price) p = Math.round((p + (Math.random() < 0.5 ? -0.01 : 0.01)) * 100) / 100; // курс никогда не «стоит»
    c.direction = p >= c.price ? 'up' : 'down';
    c.price = p;
    if (p > c.ath) c.ath = p;
    if (p < c.atl) c.atl = p;
    const k = c.candles[c.candles.length - 1];
    k.c = p;
    if (p > k.h) k.h = p;
    if (p < k.l) k.l = p;
}
function stepCrypto(c, t) {
    const dev = Math.log(c.price / cryptoAnchor(c, t));      // насколько курс ушёл от «справедливой» цены
    c.trend = c.trend * 0.85 + (Math.random() * 2 - 1) * 0.0004; // короткая инерция — серии роста/падения
    let ch = -CRYPTO_REVERT * dev + c.trend + (Math.random() * 2 - 1) * 0.0004 + CRYPTO_DRIFT_PER_TICK;
    if (Math.random() < 0.02) ch += (Math.random() * 2 - 1) * 0.004; // редкие резкие движения
    ch = Math.max(-0.01, Math.min(0.01, ch));
    applyCryptoPrice(c, c.price * Math.exp(ch));
    c.candleTicks += 1;
    if (c.candleTicks >= CANDLE_TICKS) {
        c.candleTicks = 0;
        c.candles.push({ o: c.price, h: c.price, l: c.price, c: c.price });
        while (c.candles.length > MAX_CANDLES) c.candles.shift();
    }
}
function tickCryptoGameIfDue() {
    const c = loadCryptoGame();
    const now = Date.now();
    const due = Math.floor((now - c.lastTick) / CRYPTO_TICK_MS);
    if (due <= 0) return c;
    const n = Math.min(due, 3000); // догоняем пропущенные тики (если сервис «спал»)
    for (let i = 0; i < n; i++) stepCrypto(c, c.lastTick + (i + 1) * CRYPTO_TICK_MS);
    c.lastTick = due > 3000 ? now : c.lastTick + due * CRYPTO_TICK_MS;
    saveCryptoGame(c);
    return c;
}
const ROCKET_HISTORY_FILE = path.join(__dirname, 'rocket_history.json');
function loadRocketHistory() {
    try { return JSON.parse(fs.readFileSync(ROCKET_HISTORY_FILE, 'utf8')); }
    catch (e) { return []; }
}
function saveRocketHistory(list) {
    fs.writeFileSync(ROCKET_HISTORY_FILE, JSON.stringify(list, null, 2), 'utf8');
}
const LB_STATE_FILE = path.join(__dirname, 'leaderboard_state.json');
const CYCLE_MS = 3 * DAY_MS;
const TOP_PRIZES = [
    { days: 15, crowns: 50000 },
    { days: 7, crowns: 30000 },
    { days: 7, crowns: 10000 },
];

function loadPoints() {
    try { return JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8')); }
    catch (e) { return {}; }
}
function savePoints(data) {
    fs.writeFileSync(POINTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function loadLbState() {
    try { return JSON.parse(fs.readFileSync(LB_STATE_FILE, 'utf8')); }
    catch (e) { return { cycleStart: Date.now() }; }
}
function saveLbState(data) {
    fs.writeFileSync(LB_STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function displayNameFor(user) {
    if (user.username) return '@' + user.username;
    return [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Игрок';
}

function runLeaderboardCycleIfDue() {
    const lb = loadLbState();
    if (Date.now() - lb.cycleStart < CYCLE_MS) return;

    const points = loadPoints();
    const ranked = Object.entries(points).sort((a, b) => (b[1].points || 0) - (a[1].points || 0));

    ranked.forEach(([uid, rec], idx) => {
        if (idx < 3) {
            grantPremiumDays(uid, TOP_PRIZES[idx].days);
            rec.pendingCrowns = (rec.pendingCrowns || 0) + TOP_PRIZES[idx].crowns;
        } else {
            rec.pendingCrowns = (rec.pendingCrowns || 0) + (rec.points || 0);
        }
        rec.points = 0;
    });

    savePoints(points);
    saveLbState({ cycleStart: Date.now() });
    console.log('🏆 Цикл лидерборда завершён — призы начислены, очки сброшены');
}

// ====== БОТ / СЕРВЕР ======
const bot = new TelegramBot(BOT_TOKEN, { webHook: false });
console.log('🚀 Crown Casino бот запущен (webhook)');

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// ====== /start — выбор языка (если ещё не выбран) затем открыть Mini App ======
const OPEN_APP_TEXT = { ru: 'Открыть Crown Casino', ro: 'Deschide Crown Casino', en: 'Open Crown Casino' };
const WELCOME_TEXT = {
    ru: '👑 Добро пожаловать в Crown Casino! Нажмите кнопку, чтобы начать игру.',
    ro: '👑 Bun venit la Crown Casino! Apasă butonul ca să începi jocul.',
    en: '👑 Welcome to Crown Casino! Tap the button to start playing.',
};
function openAppKeyboard(lang) {
    return { inline_keyboard: [[{ text: OPEN_APP_TEXT[lang] || OPEN_APP_TEXT.ru, web_app: { url: `${EXTERNAL_URL}/app/${lang}` } }]] };
}
bot.onText(/\/start/, async (msg) => {
    rememberUser(msg.from);
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const saved = getUserLanguage(userId);
    if (saved) {
        try {
            await bot.sendMessage(chatId, WELCOME_TEXT[saved] || WELCOME_TEXT.ru, { reply_markup: openAppKeyboard(saved) });
        } catch (e) { console.error('start error:', e.message); }
        return;
    }
    try {
        await bot.sendMessage(chatId, 'Выберите язык · Alegeți limba · Choose language', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🇷🇺 Русский', callback_data: 'setlang_ru' },
                    { text: '🇷🇴 Română', callback_data: 'setlang_ro' },
                    { text: '🇬🇧 English', callback_data: 'setlang_en' },
                ]],
            },
        });
    } catch (e) { console.error('start lang-picker error:', e.message); }
});

// ====== Выбор языка кнопкой под /start (сохраняется и дальше открывает Mini App) ======
bot.on('callback_query', async (cb) => {
    try {
        const data = cb.data || '';
        const m = data.match(/^setlang_(ru|ro|en)$/);
        if (!m) return;
        const lang = m[1];
        setUserLanguage(cb.from.id, lang);
        await bot.answerCallbackQuery(cb.id, { text: ({ ru: 'Язык: Русский', ro: 'Limbă: Română', en: 'Language: English' })[lang] });
        await bot.editMessageText(WELCOME_TEXT[lang], {
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            reply_markup: openAppKeyboard(lang),
        });
    } catch (e) { console.error('callback_query (setlang) error:', e.message); }
});

// ====== Инлайн-режим: "send 500" / "receive 500" (переводы зиксов) ======
// Форматы запроса: "send 500", "receive 500", необязательно с указанием
// получателя впереди — "@username send 500" (используется только как
// дополнительная проверка при подтверждении, см. /api/transfer-confirm).
const INLINE_CMD_RE = /^(?:@(\w+)\s+)?(send|receive)\s+(\d+(?:[.,]\d+)?)\s*([kmbtкмбт]?)\s*(?:@(\w+))?\s*$/i;
const INLINE_RESULT_TEXT = {
    send: {
        ru: (name, amt) => `🎁 ${name} дарит тебе ${amt}\nЖми кнопку, чтобы забрать 👇`,
        ro: (name, amt) => `🎁 ${name} îți dăruiește ${amt}\nApasă butonul ca să îi iei 👇`,
        en: (name, amt) => `🎁 ${name} is gifting you ${amt}\nTap the button to grab them 👇`,
        btn: { ru: 'Забрать 🎁', ro: 'Ia-i 🎁', en: 'Claim 🎁' },
        title: { ru: (a) => `Отправить ${a}`, ro: (a) => `Trimite ${a}`, en: (a) => `Send ${a}` },
        hint: { ru: 'Нажми, чтобы отправить в чат', ro: 'Apasă ca să trimiți în chat', en: 'Tap to send to the chat' },
    },
    receive: {
        ru: (name, amt) => `🙏 ${name} просит ${amt}\nЕсли хочешь помочь — жми кнопку 👇`,
        ro: (name, amt) => `🙏 ${name} îți cere ${amt}\nDacă vrei să ajuți, apasă butonul 👇`,
        en: (name, amt) => `🙏 ${name} is asking for ${amt}\nTap the button if you want to chip in 👇`,
        btn: { ru: 'Отправить 💸', ro: 'Trimite 💸', en: 'Send 💸' },
        title: { ru: (a) => `Попросить ${a}`, ro: (a) => `Cere ${a}`, en: (a) => `Ask for ${a}` },
        hint: { ru: 'Нажми, чтобы отправить запрос в чат', ro: 'Apasă ca să trimiți cererea în chat', en: 'Tap to send the request to the chat' },
    },
};
const INLINE_ERRORS = {
    not_enough: {
        ru: (have, need) => `У тебя ${have}, а нужно ${need}`,
        ro: (have, need) => `Ai ${have}, iar ai nevoie de ${need}`,
        en: (have, need) => `You have ${have}, but need ${need}`,
        title: { ru: '❌ Не хватает зиксов', ro: '❌ Nu ai destule zix', en: '❌ Not enough zix' },
    },
    unknown: {
        title: { ru: '⚠️ Сначала открой игру', ro: '⚠️ Deschide mai întâi jocul', en: '⚠️ Open the game first' },
        desc: { ru: 'Открой Crown Casino один раз, потом переводы заработают', ro: 'Deschide Crown Casino o dată, apoi transferurile vor funcționa', en: 'Open Crown Casino once, then transfers will work' },
    },
};
bot.on('inline_query', async (q) => {
    try {
        rememberUser(q.from);
        const text = (q.query || '').trim();
        const m = text.match(INLINE_CMD_RE);
        if (!m || !MINI_APP_SHORT_NAME || !BOT_USERNAME) {
            await bot.answerInlineQuery(q.id, [], { cache_time: 0, is_personal: true });
            return;
        }
        const targetUsername = (m[1] || m[5]) ? (m[1] || m[5]).toLowerCase() : null;
        const type = m[2].toLowerCase(); // 'send' | 'receive'
        const amount = parseAmount(m[3], m[4]);
        if (!amount || amount <= 0 || amount > MAX_TRANSFER) {
            await bot.answerInlineQuery(q.id, [], { cache_time: 0, is_personal: true });
            return;
        }
        const fromId = String(q.from.id);
        const fromName = q.from.first_name || (q.from.username ? '@' + q.from.username : 'Игрок');
        const fromLang = getUserLanguage(fromId) || 'ru';
        const admin = isAdminId(fromId);

        // Для send проверяем баланс отправителя (админу можно всё).
        // Для receive баланс проверится у плательщика при подтверждении.
        if (type === 'send' && !admin) {
            const bal = getEffectiveBalance(fromId);
            if (bal === null) {
                await bot.answerInlineQuery(q.id, [{
                    type: 'article', id: 'unknown',
                    title: INLINE_ERRORS.unknown.title[fromLang],
                    description: INLINE_ERRORS.unknown.desc[fromLang],
                    input_message_content: { message_text: INLINE_ERRORS.unknown.title[fromLang] },
                }], { cache_time: 0, is_personal: true });
                return;
            }
            if (bal < amount) {
                await bot.answerInlineQuery(q.id, [{
                    type: 'article', id: 'nofunds',
                    title: INLINE_ERRORS.not_enough.title[fromLang],
                    description: INLINE_ERRORS.not_enough[fromLang](fmtZix(Math.max(0, bal), fromLang), fmtZix(amount, fromLang)),
                    input_message_content: { message_text: INLINE_ERRORS.not_enough.title[fromLang] },
                }], { cache_time: 0, is_personal: true });
                return;
            }
        }

        const id = generateTransferId();
        const transfers = loadTransfers();
        transfers[id] = { id, type, amount, fromId, fromName, targetUsername, status: 'pending', createdAt: Date.now() };
        saveTransfers(transfers);

        const deepLink = transferDeepLink(id);
        const cfg = INLINE_RESULT_TEXT[type];
        // Сообщение (чек) и кнопка — на языке получателя, если он указан (@ник);
        // неизвестный получатель / не выбирал язык -> английский.
        // Если получатель не указан — Telegram не сообщает боту, кто в чате, берём язык отправителя.
        const msgLang = targetUsername ? recipientLang(targetUsername) : fromLang;
        await bot.answerInlineQuery(q.id, [{
            type: 'article',
            id,
            title: cfg.title[fromLang](fmtZix(amount, fromLang)),
            description: cfg.hint[fromLang],
            input_message_content: { message_text: cfg[msgLang](fromName, fmtZix(amount, msgLang)) },
            reply_markup: { inline_keyboard: [[{ text: cfg.btn[msgLang], url: deepLink }]] },
        }], { cache_time: 0, is_personal: true });
    } catch (e) {
        console.error('inline_query error:', e.message);
    }
});

// ====== Обязательное подтверждение платежа перед списанием ======
bot.on('pre_checkout_query', async (query) => {
    try {
        await bot.answerPreCheckoutQuery(query.id, true);
    } catch (e) {
        console.error('pre_checkout_query error:', e.message);
    }
});

// ====== Платёж прошёл — начисляем премиум ======
// from.id здесь — это ID реального плательщика, подтверждённый Telegram.
bot.on('message', async (msg) => {
    if (!msg.successful_payment) return;
    const userId = String(msg.from.id);
    const until = grantPremiumDays(userId, PREMIUM_DAYS);

    // Запоминаем платёж, чтобы его можно было вернуть по запросу пользователя
    const chargeId = msg.successful_payment.telegram_payment_charge_id;
    const payments = loadPayments();
    payments[chargeId] = { userId, grantedMs: PREMIUM_DAYS * DAY_MS, refunded: false, timestamp: Date.now() };
    savePayments(payments);

    console.log(`✅ Премиум начислен пользователю ${userId} до ${new Date(until).toISOString()}`);
    try {
        await bot.sendMessage(
            msg.chat.id,
            `Оплата получена! Премиум-статус Crown Casino активирован на ${PREMIUM_DAYS} дней. Откройте приложение через /start, чтобы увидеть изменения.`
        );
    } catch (e) {
        console.error('payment confirm message error:', e.message);
    }
});

const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024; // 2 МБ с запасом — апдейты Telegram весят килобайты
const MAX_API_BODY_BYTES = 64 * 1024;

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes, cb) {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
        if (tooBig) return;
        body += c;
        if (body.length > maxBytes) {
            tooBig = true;
            cb(new Error('too_big'), null);
            req.destroy();
        }
    });
    req.on('end', () => {
        if (tooBig) return;
        cb(null, body);
    });
}

const server = http.createServer((req, res) => {
    // Telegram добавляет ?tgWebAppStartParam=... — отрезаем query, чтобы маршруты совпадали
    req.url = req.url.split('?')[0];
    // ---- Вебхук Telegram ----
    if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
        if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
            console.warn('⚠️ Webhook: неверный или отсутствующий secret token — запрос отклонён');
            sendJson(res, 401, { ok: false });
            req.destroy();
            return;
        }
        readBody(req, MAX_WEBHOOK_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            try { bot.processUpdate(JSON.parse(body)); } catch (e) { console.error('parse error:', e); }
            sendJson(res, 200, { ok: true });
        });
        return;
    }

    // ---- Создание счёта на оплату Stars (вызывается фронтендом Mini App) ----
    // Ничего не начисляем здесь — только выдаём ссылку на оплату. Премиум
    // зачисляется исключительно в обработчике successful_payment выше.
    if (req.method === 'POST' && req.url === '/api/create-invoice') {
        readBody(req, MAX_API_BODY_BYTES, async (err) => {
            if (err) { sendJson(res, 413, { error: 'too_big' }); return; }
            try {
                const invoiceLink = await bot._request('createInvoiceLink', {
                    form: {
                        title: 'Премиум-статус Crown Casino',
                        description: `Премиум на ${PREMIUM_DAYS} дней: блэкджек, лимит ставок 500, бонус x2, золотая рамка профиля`,
                        payload: JSON.stringify({ type: 'premium' }),
                        provider_token: '', // для Telegram Stars всегда пусто
                        currency: 'XTR',
                        prices: JSON.stringify([{ label: 'Премиум-статус', amount: PREMIUM_PRICE_STARS }]),
                    },
                });
                sendJson(res, 200, { url: invoiceLink });
            } catch (e) {
                console.error('createInvoiceLink error:', e.message);
                sendJson(res, 500, { error: 'invoice_failed' });
            }
        });
        return;
    }

    // ---- Проверка премиум-статуса пользователя на сервере ----
    if (req.method === 'GET' && req.url.startsWith('/api/premium-status/')) {
        const userId = decodeURIComponent(req.url.split('/api/premium-status/')[1] || '');
        const until = getPremiumUntil(userId);
        sendJson(res, 200, { premium: until > Date.now(), premiumUntil: until });
        return;
    }

    // ---- Запрос на возврат средств за премиум ----
    // Требует initData от Telegram Mini App для проверки реального пользователя
    // (иначе кто угодно мог бы запросить возврат чужого платежа). Не более
    // 2 возвратов в сутки на пользователя — простая защита от злоупотреблений.
    if (req.method === 'POST' && req.url === '/api/request-refund') {
        readBody(req, MAX_API_BODY_BYTES, async (err, body) => {
            if (err) { sendJson(res, 413, { ok: false, error: 'too_big' }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* оставляем payload пустым */ }

            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) {
                sendJson(res, 401, { ok: false, message: 'Не удалось подтвердить пользователя Telegram.' });
                return;
            }
            const userId = String(tgUser.id);

            if (getRefundCountToday(userId) >= 2) {
                sendJson(res, 200, { ok: false, message: 'Возврат доступен не более 2 раз в день.' });
                return;
            }

            const payments = loadPayments();
            const entry = Object.entries(payments).find(([, p]) => p.userId === userId && !p.refunded);
            if (!entry) {
                sendJson(res, 200, { ok: false, message: 'Нет доступных платежей для возврата.' });
                return;
            }
            const [chargeId, p] = entry;

            try {
                await bot._request('refundStarPayment', {
                    form: { user_id: userId, telegram_payment_charge_id: chargeId },
                });
            } catch (e) {
                console.error('refundStarPayment error:', e.message);
                sendJson(res, 200, { ok: false, message: 'Не удалось выполнить возврат. Попробуйте позже.' });
                return;
            }

            // Откатываем ровно ту длительность премиума, что была выдана этим платежом
            const premiumData = loadPremiumData();
            const rec = premiumData[userId];
            if (rec) {
                rec.premiumUntil = Math.max(Date.now(), rec.premiumUntil - p.grantedMs);
                savePremiumData(premiumData);
            }

            p.refunded = true;
            savePayments(payments);
            incRefundCount(userId);

            // refundStarPayment уже возвращает пользователю полную уплаченную сумму —
            // отдельно отправлять подарок сверху бессмысленно (двойная компенсация).
            sendJson(res, 200, { ok: true, message: 'Возврат средств выполнен успешно.' });
        });
        return;
    }

    // ---- Начисление очков лидерборда за выигрыш в игре ----
    if (req.method === 'POST' && req.url === '/api/add-points') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false }); return; }
            const userId = String(tgUser.id);
            const pts = Math.max(0, Math.min(1000000, Math.floor(Number(payload.points) || 0)));

            runLeaderboardCycleIfDue();
            const all = loadPoints();
            const rec = all[userId] || { points: 0, pendingCrowns: 0 };
            rec.points = (rec.points || 0) + pts;
            rec.name = displayNameFor(tgUser);
            rec.photoUrl = tgUser.photo_url || '';
            all[userId] = rec;
            savePoints(all);
            sendJson(res, 200, { ok: true, points: rec.points });
        });
        return;
    }

    // ---- Таблица лидеров: топ игроков + место текущего пользователя ----
    if (req.method === 'POST' && req.url === '/api/leaderboard') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false }); return; }
            const userId = String(tgUser.id);

            runLeaderboardCycleIfDue();
            const all = loadPoints();
            const ranked = Object.entries(all).sort((a, b) => (b[1].points || 0) - (a[1].points || 0));
            const top = ranked.slice(0, 10).map(([uid, rec], i) => ({
                rank: i + 1, name: rec.name || 'Игрок', points: rec.points || 0, photoUrl: rec.photoUrl || '',
            }));
            const myIndex = ranked.findIndex(([uid]) => uid === userId);
            const myRank = myIndex >= 0 ? myIndex + 1 : null;
            const myPoints = myIndex >= 0 ? (ranked[myIndex][1].points || 0) : 0;
            const lb = loadLbState();
            const nextResetMs = Math.max(0, CYCLE_MS - (Date.now() - lb.cycleStart));

            sendJson(res, 200, { ok: true, top, myRank, myPoints, nextResetMs });
        });
        return;
    }

    // ---- Получение отложенной награды (приз за топ или конвертация очков) ----
    if (req.method === 'POST' && req.url === '/api/claim-reward') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false }); return; }
            const userId = String(tgUser.id);

            runLeaderboardCycleIfDue();
            const all = loadPoints();
            const rec = all[userId];
            const crowns = rec ? (rec.pendingCrowns || 0) : 0;
            if (rec) { rec.pendingCrowns = 0; savePoints(all); }

            // Заодно забираем отложенные переводы (send/receive) — и зачисления, и списания
            const wallet = flushWalletPending(userId);
            const knownRec = loadBalances()[userId];
            if (knownRec) { knownRec.coins = Math.max(0, knownRec.coins + wallet.credit - wallet.debit); saveBalancesSoon(); }
            sendJson(res, 200, { ok: true, crowns, walletCredit: wallet.credit, walletDebit: wallet.debit });
        });
        return;
    }

    // ---- Клиент сообщает свой текущий баланс (для проверок при переводах) ----
    if (req.method === 'POST' && req.url === '/api/report-balance') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false }); return; }
            const coins = Number(payload.coins);
            if (!isFinite(coins) || coins < 0) { sendJson(res, 400, { ok: false }); return; }
            setKnownBalance(tgUser.id, coins);
            sendJson(res, 200, { ok: true });
        });
        return;
    }

    // ---- Информация о чеке перевода (для экрана подтверждения) ----
    if (req.method === 'POST' && req.url === '/api/transfer-info') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false }); return; }
            const id = String(payload.id || '');
            const transfers = loadTransfers();
            const tr = transfers[id];
            if (!tr) { sendJson(res, 404, { ok: false, reason: 'not_found' }); return; }
            sendJson(res, 200, {
                ok: true,
                type: tr.type,
                amount: tr.amount,
                fromName: tr.fromName,
                status: tr.status,
                isOwn: String(tr.fromId) === String(tgUser.id),
            });
        });
        return;
    }

    // ---- Подтверждение чека перевода: кто открыл первым — тот платит/получает,
    //      дальше чек становится недействительным (одноразовый) ----
    if (req.method === 'POST' && req.url === '/api/transfer-confirm') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false }); return; }
            const id = String(payload.id || '');
            const transfers = loadTransfers();
            const tr = transfers[id];
            if (!tr) { sendJson(res, 404, { ok: false, reason: 'not_found' }); return; }
            if (tr.status !== 'pending') { sendJson(res, 409, { ok: false, reason: 'invalid' }); return; }
            if (String(tr.fromId) === String(tgUser.id)) { sendJson(res, 400, { ok: false, reason: 'self' }); return; }
            if (tr.targetUsername) {
                const uname = (tgUser.username || '').toLowerCase();
                if (uname !== tr.targetUsername) { sendJson(res, 403, { ok: false, reason: 'wrong_user' }); return; }
            }

            // Кто платит: при send — автор чека, при receive — тот, кто подтверждает
            const payerId = tr.type === 'send' ? String(tr.fromId) : String(tgUser.id);
            const payerIsAdmin = isAdminId(payerId);
            if (!payerIsAdmin) {
                const bal = getEffectiveBalance(payerId);
                if (bal === null || bal < tr.amount) {
                    sendJson(res, 200, { ok: false, reason: 'insufficient', have: Math.max(0, bal || 0) });
                    return;
                }
            }

            // Отмечаем чек использованным СРАЗУ — защищает от повторного/параллельного подтверждения
            tr.status = 'confirmed';
            tr.confirmedBy = String(tgUser.id);
            tr.confirmedAt = Date.now();
            saveTransfers(transfers);

            // Админ платит бесплатно: ему ничего не списывается
            if (tr.type === 'send') {
                // fromId отправил -> confirmedBy получает
                queueWallet(tr.confirmedBy, { credit: tr.amount });
                if (!payerIsAdmin) queueWallet(tr.fromId, { debit: tr.amount });
            } else {
                // receive: fromId запросил -> confirmedBy платит, fromId получает
                queueWallet(tr.fromId, { credit: tr.amount });
                if (!payerIsAdmin) queueWallet(tr.confirmedBy, { debit: tr.amount });
            }

            // Уведомляем автора чека
            const notifyLang = getUserLanguage(tr.fromId) || 'ru';
            const byName = tgUser.first_name || (tgUser.username ? '@' + tgUser.username : 'Игрок');
            const amtN = fmtZix(tr.amount, notifyLang);
            const notifyText = tr.type === 'send'
                ? ({ ru: `✅ ${byName} забрал твои ${amtN}`, ro: `✅ ${byName} a luat ${amtN} de la tine`, en: `✅ ${byName} claimed your ${amtN}` })[notifyLang]
                : ({ ru: `✅ ${byName} отправил тебе ${amtN}`, ro: `✅ ${byName} ți-a trimis ${amtN}`, en: `✅ ${byName} sent you ${amtN}` })[notifyLang];
            bot.sendMessage(tr.fromId, notifyText).catch(() => {});

            sendJson(res, 200, { ok: true, type: tr.type, amount: tr.amount, free: payerIsAdmin });
        });
        return;
    }

    // ---- История последних крашей "Апекса" (честная, общая для всех игроков) ----
    if (req.method === 'POST' && req.url === '/api/rocket-crash') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            let cp = Number(payload.crashPoint);
            if (!isFinite(cp) || cp < 1 || cp > 100) { sendJson(res, 400, { ok: false }); return; }
            cp = Math.round(cp * 100) / 100;
            const history = loadRocketHistory();
            history.push(cp);
            while (history.length > 20) history.shift();
            saveRocketHistory(history);
            sendJson(res, 200, { ok: true });
        });
        return;
    }
    if (req.method === 'GET' && req.url === '/api/rocket-history') {
        const history = loadRocketHistory();
        sendJson(res, 200, { ok: true, history: history.slice(-4) });
        return;
    }

    // ---- Крипто-игра: текущий курс + свечи + пик/минимум ----
    if (req.method === 'GET' && req.url === '/api/crypto-status') {
        const c = tickCryptoGameIfDue();
        sendJson(res, 200, {
            ok: true, price: c.price, direction: c.direction, ath: c.ath, atl: c.atl,
            candles: c.candles, candleTicks: c.candleTicks, tickMs: CRYPTO_TICK_MS,
            nextTickMs: Math.max(0, CRYPTO_TICK_MS - (Date.now() - c.lastTick)),
        });
        return;
    }
    // ---- Покупка двигает курс вверх, продажа — вниз (рыночное давление) ----
    if (req.method === 'POST' && req.url === '/api/crypto-buy-pressure') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const units = Math.max(0, Number(payload.amountUnits) || 0);
            const sign = payload.side === 'sell' ? -1 : 1;
            const c = tickCryptoGameIfDue();
            const value = units * c.price; // сумма сделки в зиксах
            if (isFinite(value) && value > 0) {
                // +2% за каждые 50 млн зиксов, не больше +500% за одну сделку
                const up = Math.min(CRYPTO_MAX_IMPACT, CRYPTO_IMPACT_PER_50M * value / CRYPTO_IMPACT_STEP);
                const factor = sign > 0 ? 1 + up : 1 / (1 + up);
                // «Справедливая» цена сдвигается вместе с курсом — иначе курс откатывается на прежний уровень
                c.anchorBase *= factor;
                applyCryptoPrice(c, c.price * factor);
                saveCryptoGame(c);
            }
            sendJson(res, 200, { ok: true, price: c.price });
        });
        return;
    }
    // ---- Админ вручную устанавливает курс (по своему Telegram ID) ----
    if (req.method === 'POST' && req.url === '/api/crypto-set-rate') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false, message: 'Не удалось подтвердить пользователя.' }); return; }
            if (String(tgUser.id) !== ADMIN_TELEGRAM_ID) { sendJson(res, 403, { ok: false, message: 'Только администратор может менять курс.' }); return; }
            const rate = Number(payload.rate);
            if (!isFinite(rate) || rate <= 0) { sendJson(res, 400, { ok: false, message: 'Некорректный курс.' }); return; }
            const c = tickCryptoGameIfDue();
            applyCryptoPrice(c, rate);
            rebaseCryptoAnchor(c); // новый курс становится опорной точкой, чтобы его не «откатило» назад
            saveCryptoGame(c);
            sendJson(res, 200, { ok: true, price: c.price });
        });
        return;
    }

    // ---- Язык игрока: получить сохранённый выбор ----
    if (req.method === 'POST' && req.url === '/api/get-language') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false }); return; }
            const lang = getUserLanguage(tgUser.id);
            sendJson(res, 200, { ok: true, lang });
        });
        return;
    }
    // ---- Язык игрока: сохранить выбор (экран loader.html) ----
    if (req.method === 'POST' && req.url === '/api/set-language') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false }); return; }
            const lang = String(payload.lang || '');
            if (!SUPPORTED_LANGS.includes(lang)) { sendJson(res, 400, { ok: false, message: 'Unsupported language' }); return; }
            setUserLanguage(tgUser.id, lang);
            sendJson(res, 200, { ok: true });
        });
        return;
    }

    // ---- Health-check (также используется анти-слип пингом ниже) ----
    if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { status: 'ok', bot: 'running', uptime: process.uptime() });
        return;
    }

    // ---- Экран выбора языка (показывается при первом входе, дальше решает
    //      сам по сохранённому языку и сразу уводит в /app/<lang>) ----
    if (req.method === 'GET' && (req.url === '/' || req.url === '/casino.html' || req.url === '/index.html')) {
        fs.readFile(LOADER_FILE, (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Loader file not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    }

    // ---- Раздача Mini App, уже переведённого под конкретный язык ----
    if (req.method === 'GET' && /^\/app\/(ru|ro|en)\/?$/.test(req.url)) {
        const lang = req.url.match(/^\/app\/(ru|ro|en)\/?$/)[1];
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderAppForLang(lang));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

server.listen(PORT, async () => {
    console.log(`✅ Сервер на порту ${PORT}`);
    try {
        await bot.setWebHook(`${EXTERNAL_URL}${WEBHOOK_PATH}`, { secret_token: WEBHOOK_SECRET });
        console.log('✅ Webhook установлен');
    } catch (e) { console.error('❌ Webhook error:', e); }
    try {
        const me = await bot.getMe();
        BOT_USERNAME = me.username;
        console.log(`✅ Бот: @${BOT_USERNAME}`);
    } catch (e) { console.error('❌ getMe error:', e.message); }
    if (!MINI_APP_SHORT_NAME) {
        console.warn('⚠️ MINI_APP_SHORT_NAME не задан — инлайн-переводы (send/receive) работать не будут. Задайте short name в @BotFather и переменную окружения.');
    }
    runLeaderboardCycleIfDue(); // на случай, если сервер долго не запускался
    setInterval(runLeaderboardCycleIfDue, 60 * 60 * 1000); // проверка раз в час
    tickCryptoGameIfDue();
    setInterval(tickCryptoGameIfDue, 1000); // проверка раз в секунду (тик курса — раз в 2 секунды)
    keepAliveLoop();
    heartbeatLoop();
});

// ====== АНТИ-СЛИП ======
// Метод 1: периодический self-ping через fetch на собственный /health.
// Именно входящий HTTP-запрос "будит"/удерживает бесплатный инстанс на Render.
async function keepAliveLoop() {
    const url = `${EXTERNAL_URL}/health`;
    await new Promise((r) => setTimeout(r, 10000));
    while (true) {
        let success = false;
        for (let attempt = 1; attempt <= 3 && !success; attempt++) {
            try {
                const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
                console.log(`🔄 Keep-alive пинг: ${res.status}`);
                success = true;
            } catch (e) {
                console.warn(`⚠️ Keep-alive пинг не удался (попытка ${attempt}/3): ${e.message}`);
                await new Promise((r) => setTimeout(r, 5000));
            }
        }
        if (!success) console.error('❌ Keep-alive: все попытки пинга провалились в этом цикле');
        await new Promise((r) => setTimeout(r, 150000)); // раз в 2.5 минуты
    }
}

// Метод 2: независимый "нативный" пинг через модуль http/https напрямую
// (без fetch) — резервный канал: если keepAliveLoop зависнет/упадёт, этот
// таймер всё равно продолжит будить сервис.
function heartbeatLoop() {
    setInterval(() => {
        try {
            const mod = EXTERNAL_URL.startsWith('https') ? https : http;
            const req = mod.get(`${EXTERNAL_URL}/health`, { timeout: 10000 }, (res) => {
                console.log(`💓 Heartbeat пинг: ${res.statusCode}`);
                res.resume();
            });
            req.on('timeout', () => req.destroy());
            req.on('error', (e) => console.warn(`⚠️ Heartbeat пинг не удался: ${e.message}`));
        } catch (e) {
            console.warn(`⚠️ Heartbeat ошибка: ${e.message}`);
        }
    }, 240000); // раз в 4 минуты
}
