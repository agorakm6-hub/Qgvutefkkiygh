// loanmail.js — письма от «CrownCasino.com» в личку бота: выдача кредита и напоминание за сутки до срока.
// Подключение (server.js): const loanMail = require('./loanmail')({ bot, isAdminId, loadBank, saveBank, loadUsers, getUserLanguage, cfg, dayMs });
//   loanMail.sendIssued(uid)      — вызвать сразу после выдачи кредита
//   loanMail.start()              — запустить проверку напоминаний (раз в 10 минут)
//   админ-команда /loanletter     — пришлёт админу оба письма для проверки (с тестовыми цифрами)
'use strict';
const letter = require('./loanletter');

module.exports = function init(deps) {
    const { bot, isAdminId, loadBank, saveBank, loadUsers, getUserLanguage, cfg, dayMs } = deps;
    const render = deps.render || letter.renderLoanLetter;     // подменяется в тестах
    const CHECK_MS = 10 * 60 * 1000;
    const MAX_TRIES = 3;

    const CAPTION = {
        ru: { issued: '🏦 CrownCasino.com: кредит выдан', reminder: '⏰ CrownCasino.com: срок погашения кредита — завтра' },
        en: { issued: '🏦 CrownCasino.com: your loan has been issued', reminder: '⏰ CrownCasino.com: your loan is due tomorrow' },
        ro: { issued: '🏦 CrownCasino.com: creditul a fost acordat', reminder: '⏰ CrownCasino.com: creditul ajunge la scadență mâine' },
    };

    function buildData(uid, kind, loan, nowTs) {
        const us = (loadUsers() || {})[String(uid)] || {};
        const lang = getUserLanguage(uid) || 'ru';
        return {
            kind, lang, uid: Number(uid) || 0, name: us.name || 'Player',
            principal: loan.principal, owed: loan.owed, rate: cfg.loanRate,
            takenAt: loan.takenAt, dueAt: loan.dueAt, now: nowTs || Date.now(),
        };
    }
    async function deliver(uid, data) {
        const cap = (CAPTION[data.lang] || CAPTION.ru)[data.kind];
        let png;
        try { png = await render(data); }
        catch (e) {
            // нет canvas — шлём короткий текст, чтобы напоминание не потерялось
            console.error('loanmail: картинка не отрисована:', e.message);
            await bot.sendMessage(uid, cap);
            return true;
        }
        await bot.sendPhoto(uid, png, { caption: cap }, { filename: 'crowncasino-loan.png', contentType: 'image/png' });
        return true;
    }
    async function sendLetter(uid, kind) {
        const rec = (loadBank() || {})[String(uid)];
        if (!rec || !rec.loan) return false;
        try { return await deliver(uid, buildData(uid, kind, rec.loan)); }
        catch (e) { console.warn(`loanmail: не удалось отправить ${kind} игроку ${uid}: ${e.message}`); return false; }
    }
    const sendIssued = (uid) => sendLetter(uid, 'issued');

    async function reminderTick() {
        const bank = loadBank() || {};
        const now = Date.now();
        for (const uid of Object.keys(bank)) {
            const loan = bank[uid] && bank[uid].loan;
            if (!loan || loan.overdue || loan.reminded) continue;
            const left = loan.dueAt - now;
            if (left <= 0 || left > dayMs) continue;
            loan.reminded = true; saveBank();                      // сначала помечаем: повторов не будет, даже если сервер упадёт
            const ok = await sendLetter(uid, 'reminder');
            if (!ok) {                                            // например, игрок заблокировал бота: пробуем ещё пару раз
                loan.remindTries = (loan.remindTries || 0) + 1;
                if (loan.remindTries < MAX_TRIES) loan.reminded = false;
                saveBank();
            }
        }
    }
    function start() {
        setTimeout(() => reminderTick().catch((e) => console.error('loanmail tick:', e.message)), 30 * 1000);
        setInterval(() => reminderTick().catch((e) => console.error('loanmail tick:', e.message)), CHECK_MS);
    }

    // /loanletter — только админ: оба письма с тестовыми цифрами, чтобы увидеть, как это выглядит в Telegram
    bot.on('message', async (msg) => {
        try {
            if (!msg || typeof msg.text !== 'string' || msg.chat.type !== 'private') return;
            if (!/^\/loanletter(?:@\w+)?\s*$/i.test(msg.text.trim())) return;
            if (!isAdminId(msg.from.id)) return;
            const now = Date.now();
            const loan = { principal: 100000, owed: Math.ceil(100000 * (1 + cfg.loanRate)), takenAt: now, dueAt: now + cfg.loanTermMs };
            await deliver(msg.chat.id, buildData(msg.from.id, 'issued', loan, now));
            const soon = { ...loan, takenAt: now - cfg.loanTermMs + dayMs - 5 * 3600 * 1000, dueAt: now + 19 * 3600 * 1000 };
            await deliver(msg.chat.id, buildData(msg.from.id, 'reminder', soon, now));
        } catch (e) { console.error('/loanletter error:', e.message); }
    });

    return { sendIssued, reminderTick, start, sendLetter };
};
