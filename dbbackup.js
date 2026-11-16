// ============================================================
//  dbbackup.js — админ-команда /db: две кнопки «Получить БД» и «Загрузить БД».
//
//  Получить: бот присылает ОДИН файл crown_db_<дата>.json.gz со всеми данными:
//    игроки, балансы, банк, очки/рекорды, профили и монеты, курс крипты, позиции, историю Crash и т.д.
//  Загрузить: пришлите такой файл боту → бот покажет, что внутри → «Применить» заменяет данные
//    и сразу перечитывает их (перезапуск не нужен). Перед заменой бот сам делает страховочную копию
//    в папку backups/ (последние 5).
//
//  Подключение в server.js:
//    require('./dbbackup')({ bot, isAdminId, https, files: [...], resetCaches });
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FORMAT = 'crown-db-v1';
const MAX_DOWNLOAD = 19 * 1024 * 1024;           // Telegram разрешает боту скачивать файлы до 20 МБ
const PENDING_TTL = 10 * 60 * 1000;

module.exports = function initDbBackup(deps) {
    const { bot, isAdminId } = deps;
    const https = deps.https || require('https');
    const dir = deps.dir || __dirname;
    const FILES = deps.files;                       // допустимые имена файлов (белый список)
    const backupsDir = path.join(dir, 'backups');
    const awaiting = new Map();                     // adminId -> время, когда ждём файл
    const pending = new Map();                      // adminId -> { files, ts, summary }

    const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 13);
    const isSafeName = (n) => FILES.includes(n) && path.basename(n) === n;

    function collect() {
        const files = {};
        for (const name of FILES) {
            const p = path.join(dir, name);
            try { files[name] = fs.readFileSync(p, 'utf8'); } catch (e) { /* файла ещё нет */ }
        }
        return files;
    }
    function pack(files, extra) { return zlib.gzipSync(Buffer.from(JSON.stringify(Object.assign({ format: FORMAT, createdAt: Date.now(), files }, extra || {})), 'utf8'), { level: 9 }); }
    function summarize(files) {
        const cnt = (n) => { try { const o = JSON.parse(files[n]); return Array.isArray(o) ? o.length : Object.keys(o).length; } catch (e) { return null; } };
        const lines = [];
        const push = (label, n) => { if (files[n] !== undefined) lines.push(`• ${label}: ${cnt(n) == null ? '?' : cnt(n)}`); };
        push('игроки (users)', 'users.json'); push('балансы', 'balances.json'); push('банк', 'bank.json');
        push('очки лидерборда', 'points.json'); push('профили/рекорды', 'profiles.json'); push('позиции крипты', 'crypto_positions.json');
        push('история Crash', 'rocket_history.json'); push('групповые игры', 'groupgames.json');
        if (files['crypto_game.json'] !== undefined) { try { lines.push(`• курс крипты: ${Math.round(JSON.parse(files['crypto_game.json']).price)}`); } catch (e) { /* пусто */ } }
        return lines.join('\n') + `\n• файлов всего: ${Object.keys(files).length}`;
    }
    function download(url) {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); res.resume(); return; }
                const chunks = []; let size = 0;
                res.on('data', (c) => { size += c.length; if (size > MAX_DOWNLOAD) { reject(new Error('файл слишком большой')); res.destroy(); return; } chunks.push(c); });
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            }).on('error', reject);
        });
    }
    function parseBackup(buf) {
        if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
        const obj = JSON.parse(buf.toString('utf8'));
        if (!obj || obj.format !== FORMAT || !obj.files || typeof obj.files !== 'object') throw new Error('это не файл БД Crown Casino');
        const files = {};
        for (const [name, content] of Object.entries(obj.files)) {
            if (!isSafeName(name)) continue;                         // неизвестные имена игнорируем
            const text = typeof content === 'string' ? content : JSON.stringify(content);
            JSON.parse(text);                                        // каждый файл обязан быть корректным JSON
            files[name] = text;
        }
        if (!Object.keys(files).length) throw new Error('в файле нет ни одного известного файла данных');
        return files;
    }
    function writeAtomic(name, text) {
        const p = path.join(dir, name), tmp = p + '.restore.tmp';
        fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, p);
    }
    function safetyBackup() {
        try {
            fs.mkdirSync(backupsDir, { recursive: true });
            const file = path.join(backupsDir, `pre_restore_${stamp()}.json.gz`);
            fs.writeFileSync(file, pack(collect()));
            const old = fs.readdirSync(backupsDir).filter((n) => n.startsWith('pre_restore_')).sort();
            while (old.length > 5) fs.unlinkSync(path.join(backupsDir, old.shift()));
            return file;
        } catch (e) { console.error('safety backup:', e.message); return null; }
    }
    function apply(files) {
        const saved = safetyBackup();
        for (const [name, text] of Object.entries(files)) writeAtomic(name, text);
        if (deps.resetCaches) deps.resetCaches();
        return saved;
    }

    const menu = {
        inline_keyboard: [[{ text: '📥 Получить БД', callback_data: 'db|get' }, { text: '📤 Загрузить БД', callback_data: 'db|put' }]],
    };

    bot.on('message', async (msg) => {
        try {
            if (!msg || !msg.from) return;
            const uid = String(msg.from.id), chatId = msg.chat.id;
            if (typeof msg.text === 'string' && /^\/db(?:@\w+)?\s*$/i.test(msg.text.trim())) {
                if (!isAdminId(uid)) return;
                await bot.sendMessage(chatId, '🗄 <b>База данных Crown Casino</b>\n\n📥 <b>Получить БД</b> — пришлю один файл со всеми данными (игроки, балансы, банк, рекорды, профили, монеты, курс крипты).\n📤 <b>Загрузить БД</b> — вы присылаете такой файл, и данные восстанавливаются.', { parse_mode: 'HTML', reply_markup: menu });
                return;
            }
            if (msg.document && isAdminId(uid) && awaiting.has(uid)) {
                if (Date.now() - awaiting.get(uid) > PENDING_TTL) { awaiting.delete(uid); await bot.sendMessage(chatId, 'Время ожидания вышло. Нажмите /db ещё раз.'); return; }
                awaiting.delete(uid);
                try {
                    if (msg.document.file_size && msg.document.file_size > MAX_DOWNLOAD) throw new Error('файл больше 20 МБ — Telegram не даёт боту его скачать');
                    const link = await bot.getFileLink(msg.document.file_id);
                    const files = parseBackup(await download(link));
                    pending.set(uid, { files, ts: Date.now() });
                    await bot.sendMessage(chatId, `🔎 <b>Файл прочитан.</b> Внутри:\n${summarize(files)}\n\n⚠️ «Применить» заменит текущие данные этими. Страховочная копия текущих данных сохранится автоматически.`, {
                        parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Применить', callback_data: 'db|apply' }, { text: '✖ Отмена', callback_data: 'db|cancel' }]] },
                    });
                } catch (e) {
                    await bot.sendMessage(chatId, '❌ Не удалось прочитать файл: ' + (e && e.message ? e.message : e));
                }
            }
        } catch (e) { console.error('db message:', e && e.message); }
    });

    bot.on('callback_query', async (q) => {
        try {
            const data = q && q.data;
            if (typeof data !== 'string' || !data.startsWith('db|')) return;
            const uid = String(q.from.id);
            if (!isAdminId(uid)) { await bot.answerCallbackQuery(q.id, { text: 'Только для админа', show_alert: true }).catch(() => { }); return; }
            const chatId = q.message && q.message.chat.id;
            const act = data.split('|')[1];
            if (act === 'get') {
                await bot.answerCallbackQuery(q.id).catch(() => { });
                const files = collect(), buf = pack(files);
                await bot.sendDocument(chatId, buf, {
                    caption: `🗄 База данных, ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC\n${summarize(files)}\n\nЧтобы восстановить: /db → «Загрузить БД» → пришлите этот файл.`,
                }, { filename: `crown_db_${stamp()}.json.gz`, contentType: 'application/gzip' });
            } else if (act === 'put') {
                awaiting.set(uid, Date.now());
                await bot.answerCallbackQuery(q.id).catch(() => { });
                await bot.sendMessage(chatId, '📤 Пришлите файл БД (<code>crown_db_….json.gz</code>) следующим сообщением. Жду 10 минут.', { parse_mode: 'HTML' });
            } else if (act === 'apply') {
                const p = pending.get(uid);
                if (!p || Date.now() - p.ts > PENDING_TTL) { pending.delete(uid); await bot.answerCallbackQuery(q.id, { text: 'Файл устарел — загрузите заново', show_alert: true }).catch(() => { }); return; }
                pending.delete(uid);
                await bot.answerCallbackQuery(q.id).catch(() => { });
                const saved = apply(p.files);
                await bot.sendMessage(chatId, `✅ <b>База восстановлена.</b> Данные перечитаны, перезапуск не нужен.\n${summarize(p.files)}\n\n${saved ? '🛟 Страховочная копия прежних данных: <code>backups/' + path.basename(saved) + '</code>' : '⚠️ Страховочную копию создать не удалось.'}`, { parse_mode: 'HTML' });
            } else if (act === 'cancel') {
                pending.delete(uid); awaiting.delete(uid);
                await bot.answerCallbackQuery(q.id, { text: 'Отменено' }).catch(() => { });
            } else await bot.answerCallbackQuery(q.id).catch(() => { });
        } catch (e) { console.error('db callback:', e && e.message); }
    });

    return { collect, pack, parseBackup, apply, summarize };
};
module.exports.FORMAT = FORMAT;
