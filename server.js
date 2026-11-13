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
    if (!rec) return { credit: 0, debit: 0, zero: false };
    delete data[key];
    saveWalletPending(data);
    return { credit: rec.credit || 0, debit: rec.debit || 0, zero: !!rec.zero };
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
    if (w.zero) return 0;
    return rec.coins + (w.credit || 0) - (w.debit || 0);
}
function isAdminId(userId) { return String(userId) === ADMIN_TELEGRAM_ID; }

// ---- Суммы: 500, 5k, 2.5m, 1b, 67b, 1t (также к/м/б/т) ----
const AMOUNT_MULT = { '': 1, k: 1e3, 'к': 1e3, m: 1e6, 'м': 1e6, b: 1e9, 'б': 1e9, t: 1e12, 'т': 1e12 };
const MAX_TRANSFER = 1e30;
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
function validateInitDataRaw(initData) {
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
        if (user && user.id) { rememberUser(user); touchUser(user); }
        return user && user.id ? user : null; // возвращаем весь объект user (нужны id + имя для лидерборда)
    } catch (e) {
        return null;
    }
}
// Обычная проверка: для замороженного аккаунта возвращает null — любой эндпоинт
// отвечает ему как неавторизованному, то есть ничего не делает.
function validateInitData(initData) {
    const u = validateInitDataRaw(initData);
    if (!u) return null;
    if (!isAdminId(u.id) && isAccountFrozen(u.id)) return null;
    return u;
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
// ---- Экономика крипторынка (всё считается ТОЛЬКО на сервере) ----
// Модель: цена двигается по закону d(ln P) = d(V) / LIQUIDITY, где V — сумма сделки в зиксах (без комиссии).
// Сделка исполняется по СРЕДНЕЙ цене вдоль всего пути движения курса (интеграл), а не по цене «до».
// Такая модель путе-независима: покупка + мгновенная продажа возвращают курс ровно в исходную точку
// и ровно ту же сумму ДО комиссий — значит, любой круг «купил-продал» после комиссий строго в минус.
const CRYPTO_LIQUIDITY = 2.5e9;        // «глубина рынка» в зиксах: 50 млн зиксов двигают курс на ~2%
const CRYPTO_BUY_FEE = 0.01;           // комиссия покупки 1% (сгорает, на курс не влияет)
const CRYPTO_SELL_FEE = 0.03;          // комиссия продажи 3% (сгорает, на курс не влияет)
const CRYPTO_MAX_MOVE = 1.25;          // одна сделка двигает курс максимум на ±25% (крупнее — частичное исполнение)
const CRYPTO_MAX_MOVE_LN = Math.log(CRYPTO_MAX_MOVE);
const CRYPTO_PRICE_MIN = 10;           // жёсткие границы курса — никакого Infinity/NaN/нуля
const CRYPTO_PRICE_MAX = 1e9;
const CRYPTO_MIN_TRADE_ZIX = 10;
const CRYPTO_MAX_UNITS = 1e38;         // потолок количества VEX у одного игрока
const CRYPTO_TRADE_COOLDOWN_MS = 700;  // не чаще одной сделки за 0.7 сек на игрока
const COIN_CAP = 1e40;                 // всё, что больше, считаем некорректным значением баланса
const CRYPTO_REVERT = 0.012;           // сила притяжения курса к растущему якорю
// Глубина рынка растёт вместе с самыми богатыми игроками (кроме админа), чтобы крупные
// сделки исполнялись целиком, а не обрезались по лимиту. Для обычных балансов остаётся базовой.
let liqCache = { v: 2.5e9, ts: 0 };
function currentLiquidity() {
    if (Date.now() - liqCache.ts < 30000) return liqCache.v;
    let max = 0;
    const b = loadBalances();
    for (const [id, r] of Object.entries(b)) if (!isAdminId(id) && r && r.coins > max) max = r.coins;
    liqCache = { v: Math.max(CRYPTO_LIQUIDITY, Math.min(1e38, max * 25)), ts: Date.now() };
    return liqCache.v;
}
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
    // Санитайзер: курс, раздутый старым дюпом (Infinity/NaN/1e32...), возвращаем в рабочий диапазон.
    // Балансы игроков НЕ трогаем — только цену рынка.
    const okPrice = (x) => typeof x === 'number' && isFinite(x) && x >= CRYPTO_PRICE_MIN && x <= CRYPTO_PRICE_MAX;
    if (!okPrice(c.price) || !okPrice(c.anchorBase)) {
        console.warn('⚠️ Курс VEX был некорректным (' + c.price + ') — сброшен к ' + CRYPTO_START_PRICE);
        const f = freshCrypto(); f.lastTick = Date.now();
        c = f;
    }
    if (!okPrice(c.ath)) c.ath = c.price;
    if (!okPrice(c.atl)) c.atl = c.price;
    c.candles = c.candles.filter(k => k && okPrice(k.o) && okPrice(k.h) && okPrice(k.l) && okPrice(k.c));
    if (!c.candles.length) { c.candles = [{ o: c.price, h: c.price, l: c.price, c: c.price }]; c.candleTicks = 0; }
    if (!isFinite(c.trend)) c.trend = 0;
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
    if (!isFinite(p)) return; // NaN/Infinity никогда не попадают в курс
    p = Math.min(CRYPTO_PRICE_MAX, Math.max(CRYPTO_PRICE_MIN, Math.round(p * 100) / 100));
    if (p === c.price && p > CRYPTO_PRICE_MIN && p < CRYPTO_PRICE_MAX) p = Math.round((p + (Math.random() < 0.5 ? -0.01 : 0.01)) * 100) / 100; // курс никогда не «стоит»
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
// Чистая функция исполнения сделки: меняет c (курс) и rec (позиция) и возвращает результат. Ничего не пишет на диск.
function cryptoExecuteTrade(c, rec, side, payload) {
    const P0 = c.price;
    if (!isFinite(P0) || P0 < CRYPTO_PRICE_MIN) return { ok: false, code: 'market_error' };
    const LIQ = currentLiquidity();
    // сколько ln-движения ещё можно сделать до границы курса
    const roomUp = Math.max(0, Math.min(CRYPTO_MAX_MOVE_LN, Math.log(CRYPTO_PRICE_MAX / P0)));
    const roomDown = Math.max(0, Math.min(CRYPTO_MAX_MOVE_LN, Math.log(P0 / CRYPTO_PRICE_MIN)));
    if (side === 'buy') {
        let amount = Math.floor(Number(payload.amountZix));
        if (!isFinite(amount) || amount < CRYPTO_MIN_TRADE_ZIX || amount > COIN_CAP) return { ok: false, code: 'bad_amount' };
        let fee = Math.ceil(amount * CRYPTO_BUY_FEE);
        let net = amount - fee;                              // сумма, которая реально идёт в рынок
        const netCap = Math.floor(LIQ * roomUp);
        let partial = false;
        if (net > netCap) {                                  // слишком крупная сделка — исполняем часть
            net = netCap; partial = true;
            fee = Math.ceil(net * CRYPTO_BUY_FEE / (1 - CRYPTO_BUY_FEE));
            amount = net + fee;
        }
        if (net < 1) return { ok: false, code: 'bad_amount' };
        const x = net / LIQ;
        const units = LIQ * (-Math.expm1(-x)) / P0;          // ∫ dV / P вдоль пути
        const P1 = P0 * Math.exp(x);
        if (!isFinite(units) || units <= 0 || !isFinite(P1)) return { ok: false, code: 'market_error' };
        if (rec.units + units > CRYPTO_MAX_UNITS) return { ok: false, code: 'holdings_cap' };
        rec.units += units;
        applyCryptoPrice(c, P1);
        return { ok: true, side, spentZix: amount, netZix: net, feeZix: fee, units, execPrice: net / units, price0: P0, price1: c.price, holdings: rec.units, partial };
    }
    let units = payload.all ? rec.units : Number(payload.units);
    if (!isFinite(units) || units <= 0) return { ok: false, code: 'bad_amount' };
    if (units > rec.units * (1 + 1e-9) + 1e-12) return { ok: false, code: 'not_enough' };
    units = Math.min(units, rec.units);
    const unitsCap = (LIQ / P0) * Math.expm1(roomDown);      // макс. объём продажи при допустимом падении курса
    let partial = false;
    if (units > unitsCap) { units = unitsCap; partial = true; }
    const y = P0 * units / LIQ;
    const grossExact = LIQ * Math.log1p(y);                  // ∫ P dU вдоль пути (сумма до комиссии)
    const P1 = P0 / (1 + y);
    const gross = Math.floor(grossExact);
    if (!isFinite(gross) || gross < CRYPTO_MIN_TRADE_ZIX || !isFinite(P1)) return { ok: false, code: 'bad_amount' };
    const fee = Math.ceil(gross * CRYPTO_SELL_FEE);
    const payout = gross - fee;
    if (payout < 1) return { ok: false, code: 'bad_amount' };
    rec.units = (units >= rec.units * (1 - 1e-12)) ? 0 : Math.max(0, rec.units - units);
    applyCryptoPrice(c, P1);
    return { ok: true, side, units, grossZix: gross, feeZix: fee, payoutZix: payout, execPrice: gross / units, price0: P0, price1: c.price, holdings: rec.units, partial };
}

// ---- Позиции игроков по VEX (серверный источник правды по количеству монет) ----
const CRYPTO_POS_FILE = path.join(__dirname, 'crypto_positions.json');
let cryptoPosCache = null;
let cryptoPosTimer = null;
const cryptoLastTradeAt = new Map();   // userId -> время последней сделки
function loadCryptoPositions() {
    if (cryptoPosCache) return cryptoPosCache;
    try { cryptoPosCache = JSON.parse(fs.readFileSync(CRYPTO_POS_FILE, 'utf8')); } catch (e) { cryptoPosCache = {}; }
    return cryptoPosCache;
}
function saveCryptoPositions() {
    if (cryptoPosTimer) return;
    cryptoPosTimer = setTimeout(() => {
        cryptoPosTimer = null;
        const tmp = CRYPTO_POS_FILE + '.tmp';
        try { fs.writeFileSync(tmp, JSON.stringify(cryptoPosCache || {}), 'utf8'); fs.renameSync(tmp, CRYPTO_POS_FILE); }
        catch (e) { console.error('crypto positions save error:', e.message); }
    }, 300);
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


// ====== РЕЕСТР ИГРОКОВ (для админ-списка) ======
const USERS_FILE = path.join(__dirname, 'users.json');
let usersCache = null;
let usersSaveTimer = null;
function loadUsers() {
    if (usersCache) return usersCache;
    try { usersCache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { usersCache = {}; }
    return usersCache;
}
function touchUser(u) {
    try {
        const all = loadUsers();
        const k = String(u.id);
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : 'Игрок');
        const prev = all[k];
        all[k] = { name, username: u.username || '', seen: Date.now() };
        if (!prev || prev.name !== name || prev.username !== (u.username || '') || Date.now() - (prev.seen || 0) > 60000) {
            if (!usersSaveTimer) usersSaveTimer = setTimeout(() => {
                usersSaveTimer = null;
                try { fs.writeFileSync(USERS_FILE, JSON.stringify(usersCache || {}), 'utf8'); } catch (e) { /* пусто */ }
            }, 3000);
        }
    } catch (e) { /* пусто */ }
}

// ====== БАНК: вклады и кредиты ======
// Всё состояние банка живёт на сервере (bank.json). Зиксы по-прежнему лежат у клиента,
// поэтому каждая операция возвращает coinsDelta — на сколько клиент должен изменить баланс.
// Сервер при этом сразу корректирует «известный» баланс игрока.
const BANK_FILE = path.join(__dirname, 'bank.json');
const BANK_CFG = {
    depositDailyRate: 0.02,        // 2% в сутки на вклад
    depositLockMs: 2 * DAY_MS,     // снять можно не раньше чем через 2 суток
    depositMaxDays: 30,            // проценты копятся максимум 30 суток
    maxDeposits: 10,               // не больше 10 вкладов одновременно
    loanRate: 0.067,               // 6.7% по кредиту
    loanTermMs: 30 * DAY_MS,       // срок кредита — месяц
    loanMaxShare: 1 / 3,           // кредит — не больше трети баланса
    minAmount: 10,
};
let bankCache = null;
function loadBank() {
    if (bankCache) return bankCache;
    try { bankCache = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')); } catch (e) { bankCache = {}; }
    return bankCache;
}
function saveBank() {
    try { fs.writeFileSync(BANK_FILE, JSON.stringify(bankCache || {}), 'utf8'); } catch (e) { console.error('bank save error:', e.message); }
}
function bankRec(uid) {
    const b = loadBank();
    const k = String(uid);
    if (!b[k]) b[k] = { deposits: [], loan: null, creditBan: false, frozenFunds: false, frozenAccount: false, hidden: false };
    const r = b[k];
    // просрочка: кредит не возвращён за месяц -> средства замораживаются, брать кредиты больше нельзя
    if (r.loan && !r.loan.overdue && Date.now() > r.loan.dueAt) { r.loan.overdue = true; r.creditBan = true; saveBank(); }
    return r;
}
function isAccountFrozen(uid) { const r = loadBank()[String(uid)]; return !!(r && r.frozenAccount); }
function isHidden(uid) { const r = loadBank()[String(uid)]; return !!(r && r.hidden); }
function frozenInfo(uid) {
    const r = bankRec(uid);
    return { frozenAll: !!r.frozenFunds, frozenAmount: (r.loan && r.loan.overdue) ? r.loan.owed : 0 };
}
// Сколько игрок может ТРАТИТЬ (с учётом замороженных средств)
function spendableBalance(uid) {
    const bal = getEffectiveBalance(uid);
    if (bal === null) return null;
    const f = frozenInfo(uid);
    if (f.frozenAll) return 0;
    return Math.max(0, bal - f.frozenAmount);
}
function adjustKnownBalance(uid, delta) {
    const b = loadBalances();
    const k = String(uid);
    const rec = b[k] || { coins: 0, ts: Date.now() };
    rec.coins = Math.max(0, Math.floor(rec.coins + delta));
    rec.ts = Date.now();
    b[k] = rec;
    saveBalancesSoon();
}
function depositEarned(d, now) {
    const days = Math.min(BANK_CFG.depositMaxDays, Math.max(0, (now - d.ts) / DAY_MS));
    return Math.floor(d.amount * BANK_CFG.depositDailyRate * days);
}
function bankSnapshot(uid, isAdmin) {
    const r = bankRec(uid);
    const now = Date.now();
    const bal = getEffectiveBalance(uid);
    const f = frozenInfo(uid);
    return {
        ok: true,
        cfg: BANK_CFG,
        isAdmin: !!isAdmin,
        balance: bal === null ? null : Math.max(0, bal),
        frozenAll: f.frozenAll, frozenAmount: f.frozenAmount,
        deposits: r.deposits.map((d) => ({
            id: d.id, amount: d.amount, ts: d.ts,
            earned: depositEarned(d, now),
            unlockAt: d.ts + BANK_CFG.depositLockMs,
            canWithdraw: now >= d.ts + BANK_CFG.depositLockMs,
        })),
        loan: r.loan ? { principal: r.loan.principal, owed: r.loan.owed, takenAt: r.loan.takenAt, dueAt: r.loan.dueAt, overdue: !!r.loan.overdue } : null,
        creditBan: !!r.creditBan,
        maxLoan: (bal === null || r.creditBan || r.loan || f.frozenAll) ? 0 : Math.floor(Math.max(0, bal) * BANK_CFG.loanMaxShare),
    };
}
// Общая обёртка: читает тело, проверяет игрока, отдаёт (tgUser, payload)
function apiUser(req, res, handler, raw) {
    readBody(req, MAX_API_BODY_BYTES, (err, body) => {
        if (err) { sendJson(res, 413, { ok: false }); return; }
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
        const tgUser = (raw ? validateInitDataRaw : validateInitData)(payload.initData || '');
        if (!tgUser) {
            const u = validateInitDataRaw(payload.initData || '');
            sendJson(res, u ? 403 : 401, { ok: false, frozen: !!u });
            return;
        }
        try { handler(tgUser, payload); }
        catch (e) { console.error('api error:', e); sendJson(res, 500, { ok: false }); }
    });
}
function handleBankRoutes(req, res) {
    const url = req.url;
    if (req.method !== 'POST') return false;

    if (url === '/api/me') {
        apiUser(req, res, (u) => {
            sendJson(res, 200, { ok: true, isAdmin: isAdminId(u.id), frozenAccount: isAccountFrozen(u.id) && !isAdminId(u.id) });
        }, true);
        return true;
    }
    if (url === '/api/bank/state') {
        apiUser(req, res, (u) => {
            if (!isAdminId(u.id) && isAccountFrozen(u.id)) { sendJson(res, 200, { ok: false, frozen: true }); return; }
            sendJson(res, 200, bankSnapshot(u.id, isAdminId(u.id)));
        }, true);
        return true;
    }
    if (url === '/api/bank/deposit') {
        apiUser(req, res, (u, p) => {
            const uid = String(u.id), r = bankRec(uid);
            const amount = Math.floor(Number(p.amount));
            if (!isFinite(amount) || amount < BANK_CFG.minAmount) { sendJson(res, 200, { ok: false, reason: 'min', min: BANK_CFG.minAmount }); return; }
            if (r.deposits.length >= BANK_CFG.maxDeposits) { sendJson(res, 200, { ok: false, reason: 'too_many' }); return; }
            const spendable = isAdminId(uid) ? getEffectiveBalance(uid) : spendableBalance(uid);
            if (spendable === null) { sendJson(res, 200, { ok: false, reason: 'unknown_balance' }); return; }
            if (frozenInfo(uid).frozenAll && !isAdminId(uid)) { sendJson(res, 200, { ok: false, reason: 'frozen' }); return; }
            if (spendable < amount) { sendJson(res, 200, { ok: false, reason: 'insufficient' }); return; }
            r.deposits.push({ id: crypto.randomBytes(4).toString('hex'), amount, ts: Date.now() });
            saveBank();
            adjustKnownBalance(uid, -amount);
            sendJson(res, 200, Object.assign(bankSnapshot(uid, isAdminId(uid)), { coinsDelta: -amount }));
        });
        return true;
    }
    if (url === '/api/bank/withdraw') {
        apiUser(req, res, (u, p) => {
            const uid = String(u.id), r = bankRec(uid);
            const idx = r.deposits.findIndex((d) => d.id === String(p.id));
            if (idx < 0) { sendJson(res, 200, { ok: false, reason: 'not_found' }); return; }
            const d = r.deposits[idx];
            const now = Date.now();
            if (now < d.ts + BANK_CFG.depositLockMs) { sendJson(res, 200, { ok: false, reason: 'locked', unlockAt: d.ts + BANK_CFG.depositLockMs }); return; }
            if (frozenInfo(uid).frozenAll && !isAdminId(uid)) { sendJson(res, 200, { ok: false, reason: 'frozen' }); return; }
            const payout = d.amount + depositEarned(d, now);
            r.deposits.splice(idx, 1);
            saveBank();
            adjustKnownBalance(uid, payout);
            sendJson(res, 200, Object.assign(bankSnapshot(uid, isAdminId(uid)), { coinsDelta: payout, earned: payout - d.amount }));
        });
        return true;
    }
    if (url === '/api/bank/loan-take') {
        apiUser(req, res, (u, p) => {
            const uid = String(u.id), r = bankRec(uid);
            const amount = Math.floor(Number(p.amount));
            if (r.creditBan) { sendJson(res, 200, { ok: false, reason: 'banned' }); return; }
            if (r.loan) { sendJson(res, 200, { ok: false, reason: 'has_loan' }); return; }
            if (frozenInfo(uid).frozenAll) { sendJson(res, 200, { ok: false, reason: 'frozen' }); return; }
            const bal = getEffectiveBalance(uid);
            if (bal === null) { sendJson(res, 200, { ok: false, reason: 'unknown_balance' }); return; }
            const max = Math.floor(Math.max(0, bal) * BANK_CFG.loanMaxShare);
            if (!isFinite(amount) || amount < BANK_CFG.minAmount) { sendJson(res, 200, { ok: false, reason: 'min', min: BANK_CFG.minAmount }); return; }
            if (amount > max) { sendJson(res, 200, { ok: false, reason: 'limit', max }); return; }
            const now = Date.now();
            r.loan = { principal: amount, owed: Math.ceil(amount * (1 + BANK_CFG.loanRate)), takenAt: now, dueAt: now + BANK_CFG.loanTermMs, overdue: false };
            saveBank();
            adjustKnownBalance(uid, amount);
            sendJson(res, 200, Object.assign(bankSnapshot(uid, isAdminId(uid)), { coinsDelta: amount }));
        });
        return true;
    }
    if (url === '/api/bank/loan-repay') {
        apiUser(req, res, (u, p) => {
            const uid = String(u.id), r = bankRec(uid);
            if (!r.loan) { sendJson(res, 200, { ok: false, reason: 'no_loan' }); return; }
            const bal = getEffectiveBalance(uid);
            if (bal === null) { sendJson(res, 200, { ok: false, reason: 'unknown_balance' }); return; }
            let pay = Math.floor(Number(p.amount));
            if (!isFinite(pay) || pay <= 0) { sendJson(res, 200, { ok: false, reason: 'min', min: 1 }); return; }
            pay = Math.min(pay, r.loan.owed);
            if (bal < pay) { sendJson(res, 200, { ok: false, reason: 'insufficient' }); return; }
            r.loan.owed -= pay;
            if (r.loan.owed <= 0) r.loan = null;
            saveBank();
            adjustKnownBalance(uid, -pay);
            sendJson(res, 200, Object.assign(bankSnapshot(uid, isAdminId(uid)), { coinsDelta: -pay }));
        });
        return true;
    }

    // ---- Админ: список всех игроков ----
    if (url === '/api/admin/users') {
        apiUser(req, res, (u) => {
            if (!isAdminId(u.id)) { sendJson(res, 403, { ok: false }); return; }
            const users = loadUsers(), balances = loadBalances(), bank = loadBank(), pts = loadPoints();
            const ids = new Set([...Object.keys(users), ...Object.keys(balances), ...Object.keys(bank), ...Object.keys(pts)]);
            const list = [];
            ids.forEach((id) => {
                const r = bankRec(id), us = users[id] || {};
                const bal = getEffectiveBalance(id);
                list.push({
                    id, name: us.name || (pts[id] && pts[id].name) || 'Игрок', username: us.username || '',
                    seen: us.seen || 0,
                    balance: bal === null ? null : Math.max(0, bal),
                    deposits: r.deposits.reduce((a, d) => a + d.amount, 0),
                    loan: r.loan ? r.loan.owed : 0, overdue: !!(r.loan && r.loan.overdue),
                    creditBan: !!r.creditBan, frozenFunds: !!r.frozenFunds, frozenAccount: !!r.frozenAccount, hidden: !!r.hidden,
                });
            });
            list.sort((a, b) => (b.seen || 0) - (a.seen || 0));
            sendJson(res, 200, { ok: true, users: list.slice(0, 1000), total: list.length });
        });
        return true;
    }
    // ---- Админ: действие над игроком ----
    if (url === '/api/admin/action') {
        apiUser(req, res, (u, p) => {
            if (!isAdminId(u.id)) { sendJson(res, 403, { ok: false }); return; }
            const target = String(p.targetId || '');
            if (!/^\d{3,20}$/.test(target)) { sendJson(res, 400, { ok: false, reason: 'bad_id' }); return; }
            const r = bankRec(target);
            switch (String(p.action)) {
                case 'zero_balance': {
                    const w = loadWalletPending();
                    w[target] = { credit: 0, debit: 0, zero: true };
                    saveWalletPending(w);
                    setKnownBalance(target, 0);
                    break;
                }
                case 'funds_freeze': r.frozenFunds = true; break;
                case 'funds_unfreeze': r.frozenFunds = false; break;
                case 'account_freeze': if (isAdminId(target)) { sendJson(res, 400, { ok: false, reason: 'self' }); return; } r.frozenAccount = true; break;
                case 'account_unfreeze': r.frozenAccount = false; break;
                case 'hide': r.hidden = true; break;
                case 'unhide': r.hidden = false; break;
                case 'reset_bank': r.deposits = []; r.loan = null; r.creditBan = false; break;
                case 'unban_credit': r.creditBan = false; break;
                default: sendJson(res, 400, { ok: false, reason: 'bad_action' }); return;
            }
            saveBank();
            sendJson(res, 200, { ok: true });
        });
        return true;
    }
    return false;
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
    if (msg.from && !isAdminId(msg.from.id) && isAccountFrozen(msg.from.id)) return;
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
        if (cb.from && !isAdminId(cb.from.id) && isAccountFrozen(cb.from.id)) return;
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

// ====== Игры в групповых чатах (ставка 100 / /bet 100 / вб / игры / рейк) ======
// Кнопки работают только у того, кто написал команду. Баланс общий с Mini App
// (списания и выигрыши идут через queueWallet). Настройки — в groupgames.js (CFG).
require('./groupgames')({ bot, spendableBalance, queueWallet, isAccountFrozen, isAdminId, parseAmount, rememberUser, escapeHtml });

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
        if (q.from && !isAdminId(q.from.id) && isAccountFrozen(q.from.id)) return; // полностью игнорируем
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
            const bal = spendableBalance(fromId);
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

const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024; // 2 МБ с запасом — апдейты Telegram весят килобайты
const MAX_API_BODY_BYTES = 64 * 1024;
const pointsWindow = new Map();
const POINTS_HOURLY_BUDGET = 20000000; // максимум очков лидерборда в час на игрока

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

    if (handleBankRoutes(req, res)) return;

    // ---- Начисление очков лидерборда за выигрыш в игре ----
    if (req.method === 'POST' && req.url === '/api/add-points') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false }); return; }
            const userId = String(tgUser.id);
            let pts = Math.max(0, Math.min(1000000, Math.floor(Number(payload.points) || 0)));
            // Очки при смене цикла превращаются в короны (1:1) — поэтому лимитируем накрутку:
            // не чаще 30 вызовов в минуту и не более POINTS_HOURLY_BUDGET очков в час на игрока.
            {
                const now = Date.now();
                const w = pointsWindow.get(userId) || { minStart: now, minCnt: 0, hourStart: now, hourPts: 0 };
                if (now - w.minStart > 60000) { w.minStart = now; w.minCnt = 0; }
                if (now - w.hourStart > 3600000) { w.hourStart = now; w.hourPts = 0; }
                w.minCnt += 1;
                if (w.minCnt > 30) pts = 0;
                pts = Math.min(pts, Math.max(0, POINTS_HOURLY_BUDGET - w.hourPts));
                w.hourPts += pts;
                pointsWindow.set(userId, w);
            }

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
            const ranked = Object.entries(all)
                .filter(([uid]) => uid === userId || !isHidden(uid)) // скрытые админом видны только самим себе
                .sort((a, b) => (b[1].points || 0) - (a[1].points || 0));
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
            if (knownRec) { knownRec.coins = wallet.zero ? 0 : Math.max(0, knownRec.coins + wallet.credit - wallet.debit); saveBalancesSoon(); }
            sendJson(res, 200, { ok: true, crowns, walletCredit: wallet.zero ? 0 : wallet.credit, walletDebit: wallet.zero ? 0 : wallet.debit, walletZero: !!wallet.zero });
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
            if (!isFinite(coins) || coins < 0 || coins > COIN_CAP) { sendJson(res, 400, { ok: false }); return; }
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
                const bal = spendableBalance(payerId);
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
            if (!isAccountFrozen(tr.fromId)) bot.sendMessage(tr.fromId, notifyText).catch(() => {});

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
            buyFee: CRYPTO_BUY_FEE, sellFee: CRYPTO_SELL_FEE, liquidity: currentLiquidity(), maxMove: CRYPTO_MAX_MOVE,
            nextTickMs: Math.max(0, CRYPTO_TICK_MS - (Date.now() - c.lastTick)),
        });
        return;
    }
    // ---- Старый эндпоинт «давления» отключён: именно он давал дюп (цена двигалась ПОСЛЕ исполнения сделки) ----
    if (req.method === 'POST' && req.url === '/api/crypto-buy-pressure') {
        sendJson(res, 410, { ok: false, message: 'Устарело. Обновите приложение.' });
        return;
    }
    // ---- Сделка с VEX: цена, комиссия, влияние на курс и позиция игрока считаются здесь, атомарно ----
    if (req.method === 'POST' && req.url === '/api/crypto-trade') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false, code: 'auth' }); return; }
            const userId = String(tgUser.id);
            const side = payload.side === 'sell' ? 'sell' : (payload.side === 'buy' ? 'buy' : null);
            const tradeId = String(payload.tradeId || '');
            if (!side || !/^[A-Za-z0-9_-]{8,64}$/.test(tradeId)) { sendJson(res, 400, { ok: false, code: 'bad_request' }); return; }

            // Повторная отправка того же запроса (ретрай/двойной тап/перезапуск сервера) — возвращаем прежний результат,
            // ничего не исполняем заново. Журнал хранится вместе с позицией игрока на диске.
            const posAll = loadCryptoPositions();
            const prevRec = posAll[userId];
            const prev = prevRec && Array.isArray(prevRec.recent) ? prevRec.recent.find(r => r.id === tradeId) : null;
            if (prev) { sendJson(res, 200, Object.assign({}, prev.res, { replayed: true })); return; }

            // Антиспам: быстрые последовательные сделки отсекаем
            const nowMs = Date.now();
            if (nowMs - (cryptoLastTradeAt.get(userId) || 0) < CRYPTO_TRADE_COOLDOWN_MS) { sendJson(res, 429, { ok: false, code: 'too_fast' }); return; }

            const finish = (obj) => {
                if (obj.ok) {
                    cryptoLastTradeAt.set(userId, Date.now());
                    const r = loadCryptoPositions()[userId];
                    if (r) { r.recent = (r.recent || []).concat([{ id: tradeId, res: obj }]).slice(-30); }
                }
                sendJson(res, obj.ok ? 200 : 400, obj);
            };

            // Позиция игрока хранится на сервере. Первый раз берём стартовое значение из клиента (миграция старых игроков).
            const pos = loadCryptoPositions();
            if (!pos[userId]) {
                const seed = Number(payload.clientHoldings);
                pos[userId] = { units: (isFinite(seed) && seed > 0) ? Math.min(seed, CRYPTO_MAX_UNITS) : 0 };
            }
            const rec = pos[userId];
            if (!isFinite(rec.units) || rec.units < 0) rec.units = 0;

            const c = tickCryptoGameIfDue();
            const P0 = c.price;
            const result = cryptoExecuteTrade(c, rec, side, payload);
            if (!result.ok) { finish(result); return; }
            // «Справедливая» цена сдвигается вместе с курсом, чтобы цена не откатывалась и не давала арбитраж
            if (isFinite(c.price / P0) && c.price !== P0) c.anchorBase = Math.min(CRYPTO_PRICE_MAX, Math.max(CRYPTO_PRICE_MIN, c.anchorBase * (c.price / P0)));
            saveCryptoGame(c);
            finish(result);
            saveCryptoPositions();
        });
        return;
    }
    // ---- Позиция игрока (для отображения при входе / после обновления страницы) ----
    if (req.method === 'POST' && req.url === '/api/crypto-position') {
        readBody(req, MAX_API_BODY_BYTES, (err, body) => {
            if (err) { sendJson(res, 413, { ok: false }); return; }
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { /* пусто */ }
            const tgUser = validateInitData(payload.initData || '');
            if (!tgUser) { sendJson(res, 401, { ok: false }); return; }
            const rec = loadCryptoPositions()[String(tgUser.id)];
            sendJson(res, 200, { ok: true, known: !!rec, holdings: rec ? rec.units : 0,
                buyFee: CRYPTO_BUY_FEE, sellFee: CRYPTO_SELL_FEE, liquidity: currentLiquidity(), maxMove: CRYPTO_MAX_MOVE });
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
            if (!isFinite(rate) || rate < CRYPTO_PRICE_MIN || rate > CRYPTO_PRICE_MAX) { sendJson(res, 400, { ok: false, message: 'Курс должен быть от ' + CRYPTO_PRICE_MIN + ' до ' + CRYPTO_PRICE_MAX + '.' }); return; }
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
