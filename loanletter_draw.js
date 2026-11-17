// loanletter_draw.js — рисование «письма из банка» Crown Casino (выдача кредита и напоминание за сутки).
// Только стандартный Canvas 2D API: работает и на сервере (@napi-rs/canvas), и в браузере (для превью).
// Эмодзи не используются — все значки нарисованы фигурами. Шрифты: 'CrownBold', 'CrownMed'.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CrownLoanLetter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const W = 1000, H = 1480;
    const FB = 'CrownBold, Inter, "DejaVu Sans", Arial, sans-serif';
    const FM = 'CrownMed, Inter, "DejaVu Sans", Arial, sans-serif';

    const T = {
        ru: {
            site: 'CrownCasino.com',
            dept: 'КРЕДИТНЫЙ ОТДЕЛ',
            issuedTitle: 'КРЕДИТНЫЙ ДОГОВОР', issuedSub: 'Подтверждение выдачи кредита',
            remindTitle: 'СРОК ПОГАШЕНИЯ — ЗАВТРА', remindSub: 'Напоминание о задолженности',
            hello: (n) => `Здравствуйте, ${n}!`,
            issuedBody: 'CrownCasino.com рад сообщить: ваша заявка одобрена, кредит предоставлен. Сумма уже зачислена на ваш игровой баланс.',
            remindBody: 'Напоминаем: срок возврата вашего кредита истекает менее чем через сутки. Пожалуйста, погасите задолженность заранее.',
            contract: 'Договор №', date: 'Дата',
            principal: 'Сумма кредита', rate: 'Процентная ставка (единоразово)', owedIssued: 'Сумма к возврату', owedNow: 'Остаток к возврату',
            taken: 'Дата выдачи', term: 'Срок кредита', days: 'дней', due: 'Дата погашения', left: 'Осталось',
            hours: (h, m) => `${h} ч ${m} мин`,
            howTitle: 'КАК ВЕРНУТЬ КРЕДИТ',
            how: ['Откройте мини-приложение: Банк → Кредит.', 'Погасить можно в любой момент, в том числе частями.'],
            warnTitle: 'ЧТО БУДЕТ, ЕСЛИ НЕ ВЕРНУТЬ ВОВРЕМЯ',
            warn: ['Сумма долга на вашем балансе будет заморожена: тратить её станет нельзя.', 'Новые кредиты станут вам недоступны, пока администрация не снимет запрет.'],
            warnIssued: ['Если до даты погашения кредит не возвращён, сумма долга на вашем балансе замораживается.', 'Кроме того, новые кредиты станут недоступны, пока администрация не снимет запрет.'],
            sign: 'Кредитный отдел CrownCasino.com', stampOk: 'ОДОБРЕНО', stampWarn: 'СРОЧНО',
            foot: 'Зиксы — виртуальная валюта игры Crown Casino, не имеет денежной стоимости. Это автоматическое сообщение, отвечать на него не нужно.',
            zix: 'зиксов', utc: 'UTC',
        },
        en: {
            site: 'CrownCasino.com',
            dept: 'CREDIT DEPARTMENT',
            issuedTitle: 'LOAN AGREEMENT', issuedSub: 'Loan disbursement confirmation',
            remindTitle: 'DUE DATE IS TOMORROW', remindSub: 'Payment reminder',
            hello: (n) => `Hello, ${n}!`,
            issuedBody: 'CrownCasino.com is pleased to confirm that your application has been approved and the loan has been granted. The amount is already credited to your game balance.',
            remindBody: 'This is a reminder that your loan is due in less than 24 hours. Please repay the outstanding amount in advance.',
            contract: 'Agreement No.', date: 'Date',
            principal: 'Loan amount', rate: 'Interest rate (one-time)', owedIssued: 'Total to repay', owedNow: 'Outstanding balance',
            taken: 'Issue date', term: 'Loan term', days: 'days', due: 'Due date', left: 'Time left',
            hours: (h, m) => `${h} h ${m} min`,
            howTitle: 'HOW TO REPAY',
            how: ['Open the mini app: Bank → Loan.', 'You can repay at any time, including in parts.'],
            warnTitle: 'WHAT HAPPENS IF YOU MISS THE DUE DATE',
            warn: ['The amount you owe will be frozen on your balance and cannot be spent.', 'New loans will be unavailable until the administration lifts the restriction.'],
            warnIssued: ['If the loan is not repaid by the due date, the amount you owe is frozen on your balance.', 'New loans will also be unavailable until the administration lifts the restriction.'],
            sign: 'CrownCasino.com Credit Department', stampOk: 'APPROVED', stampWarn: 'URGENT',
            foot: 'Zix is the virtual currency of the Crown Casino game and has no monetary value. This is an automated message, no reply is needed.',
            zix: 'zix', utc: 'UTC',
        },
        ro: {
            site: 'CrownCasino.com',
            dept: 'DEPARTAMENTUL DE CREDITE',
            issuedTitle: 'CONTRACT DE CREDIT', issuedSub: 'Confirmare acordare credit',
            remindTitle: 'SCADENȚA ESTE MÂINE', remindSub: 'Memento de plată',
            hello: (n) => `Bună, ${n}!`,
            issuedBody: 'CrownCasino.com confirmă: cererea ta a fost aprobată, iar creditul a fost acordat. Suma este deja în soldul tău de joc.',
            remindBody: 'Te informăm că creditul tău ajunge la scadență în mai puțin de 24 de ore. Te rugăm să achiți datoria din timp.',
            contract: 'Contract nr.', date: 'Data',
            principal: 'Suma creditului', rate: 'Dobânda (o singură dată)', owedIssued: 'Total de returnat', owedNow: 'Rest de plată',
            taken: 'Data acordării', term: 'Durata creditului', days: 'zile', due: 'Data scadenței', left: 'Timp rămas',
            hours: (h, m) => `${h} h ${m} min`,
            howTitle: 'CUM ACHIȚI CREDITUL',
            how: ['Deschide mini-aplicația: Bancă → Credit.', 'Poți achita oricând, inclusiv în rate.'],
            warnTitle: 'CE SE ÎNTÂMPLĂ DACĂ NU ACHIȚI LA TIMP',
            warn: ['Suma datorată va fi înghețată în soldul tău și nu va putea fi cheltuită.', 'Creditele noi vor fi indisponibile până când administrația ridică restricția.'],
            warnIssued: ['Dacă creditul nu este returnat până la scadență, suma datorată se îngheață în soldul tău.', 'De asemenea, creditele noi vor fi indisponibile până când administrația ridică restricția.'],
            sign: 'Departamentul de credite CrownCasino.com', stampOk: 'APROBAT', stampWarn: 'URGENT',
            foot: 'Zix este moneda virtuală a jocului Crown Casino și nu are valoare bănească. Mesaj automat, nu este nevoie de răspuns.',
            zix: 'zix', utc: 'UTC',
        },
    };

    function group(n, lang) {
        const sep = lang === 'en' ? ',' : lang === 'ro' ? '.' : ' ';
        return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    }
    // Суммы бывают огромные (баланс вида 9.46e32): обычные — с разделителями, гигантские — в экспоненте
    function fmtAmount(n, lang) {
        n = Math.max(0, Number(n) || 0);
        if (n < 1e15) return group(n, lang);
        return n.toExponential(2).replace('e+', 'e');
    }
    function pad(x) { return String(x).padStart(2, '0'); }
    function fmtDate(ts, t) {
        const d = new Date(ts);
        return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}  ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} ${t.utc}`;
    }
    function contractNo(data) {
        const a = (Number(data.takenAt) || 0).toString(36).toUpperCase().slice(-5);
        const b = (Number(data.uid) || 0).toString(36).toUpperCase().slice(-3);
        return `CC-${a}${b}`;
    }
    function rr(c, x, y, w, h, r) {
        c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
    }
    function wrap(c, text, x, y, maxW, lh) {
        const words = String(text).split(' ');
        let line = '', yy = y;
        for (const w of words) {
            const test = line ? line + ' ' + w : w;
            if (c.measureText(test).width > maxW && line) { c.fillText(line, x, yy); line = w; yy += lh; }
            else line = test;
        }
        if (line) { c.fillText(line, x, yy); yy += lh; }
        return yy;
    }
    function crown(c, cx, cy, s, color) {
        c.save(); c.translate(cx, cy); c.scale(s, s);
        c.fillStyle = color; c.beginPath();
        c.moveTo(-22, 12); c.lineTo(-26, -12); c.lineTo(-11, 0); c.lineTo(0, -18); c.lineTo(11, 0); c.lineTo(26, -12); c.lineTo(22, 12); c.closePath(); c.fill();
        rr(c, -22, 14, 44, 6, 2); c.fill();
        c.restore();
    }
    function stamp(c, cx, cy, text, color) {
        c.save(); c.translate(cx, cy); c.rotate(-0.22);
        c.strokeStyle = color; c.fillStyle = color; c.globalAlpha = 0.85;
        c.lineWidth = 6; c.beginPath(); c.arc(0, 0, 84, 0, Math.PI * 2); c.stroke();
        c.lineWidth = 2; c.beginPath(); c.arc(0, 0, 72, 0, Math.PI * 2); c.stroke();
        c.font = '800 24px ' + FB; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(text, 0, 2);
        crown(c, 0, -40, 0.7, color);
        c.font = '600 13px ' + FM; c.fillText('CROWNCASINO.COM', 0, 40);
        c.restore();
    }

    function draw(c, data, imgs) {
        const lang = T[data.lang] ? data.lang : 'en';
        const t = T[lang];
        const remind = data.kind === 'reminder';
        const accent = remind ? '#d63a2f' : '#12a150';
        const now = Number(data.now) || Date.now();

        // фон-бумага
        c.fillStyle = '#e9ecef'; c.fillRect(0, 0, W, H);
        c.save(); c.shadowColor = 'rgba(0,0,0,0.18)'; c.shadowBlur = 24; c.shadowOffsetY = 6;
        c.fillStyle = '#fffdf8'; rr(c, 30, 30, W - 60, H - 60, 22); c.fill(); c.restore();
        c.save(); rr(c, 30, 30, W - 60, H - 60, 22); c.clip();

        // шапка
        const g = c.createLinearGradient(0, 30, W, 230);
        g.addColorStop(0, '#0b3d2a'); g.addColorStop(1, '#0f6b45');
        c.fillStyle = g; c.fillRect(30, 30, W - 60, 200);
        c.fillStyle = remind ? '#d63a2f' : '#f5c542'; c.fillRect(30, 230, W - 60, 8);
        if (imgs && imgs.coin) { c.drawImage(imgs.coin, 66, 62, 108, 108); }
        crown(c, 120, 52, 0.9, '#f5c542');
        c.textAlign = 'left'; c.textBaseline = 'alphabetic';
        c.fillStyle = '#ffffff'; c.font = '800 46px ' + FB; c.fillText('CROWN CASINO', 198, 112);
        c.fillStyle = '#f5c542'; c.font = '600 24px ' + FM; c.fillText(t.site, 200, 150);
        c.fillStyle = 'rgba(255,255,255,0.75)'; c.font = '600 18px ' + FM; c.fillText(t.dept, 200, 186);
        c.textAlign = 'right'; c.fillStyle = 'rgba(255,255,255,0.85)'; c.font = '600 20px ' + FM;
        c.fillText(`${t.contract} ${contractNo(data)}`, W - 66, 100);
        c.fillText(`${t.date}: ${fmtDate(now, t)}`, W - 66, 134);

        // заголовок
        c.textAlign = 'left';
        c.fillStyle = remind ? '#b3261e' : '#0b3d2a'; c.font = '800 40px ' + FB;
        c.fillText(remind ? t.remindTitle : t.issuedTitle, 66, 306);
        c.fillStyle = '#6b7280'; c.font = '600 22px ' + FM;
        c.fillText(remind ? t.remindSub : t.issuedSub, 66, 340);

        // приветствие
        c.fillStyle = '#1f2937'; c.font = '800 26px ' + FB;
        c.fillText(t.hello(data.name || 'Player'), 66, 396);
        c.fillStyle = '#374151'; c.font = '500 22px ' + FM;
        let y = wrap(c, remind ? t.remindBody : t.issuedBody, 66, 434, W - 132 - 200, 32);

        // печать
        stamp(c, W - 150, 400, remind ? t.stampWarn : t.stampOk, accent);

        // таблица
        y = Math.max(y, 500) + 6;
        const rows = [];
        const owed = Number(data.owed) || 0, principal = Number(data.principal) || 0;
        if (remind) {
            const left = Math.max(0, (Number(data.dueAt) || 0) - now);
            const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
            rows.push([t.owedNow, `${fmtAmount(owed, lang)} ${t.zix}`, true]);
            rows.push([t.due, fmtDate(data.dueAt, t)]);
            rows.push([t.left, t.hours(h, m), true]);
            rows.push([t.principal, `${fmtAmount(principal, lang)} ${t.zix}`]);
        } else {
            rows.push([t.principal, `${fmtAmount(principal, lang)} ${t.zix}`]);
            rows.push([t.rate, `${(Number(data.rate) * 100).toFixed(1)}%`]);
            rows.push([t.owedIssued, `${fmtAmount(owed, lang)} ${t.zix}`, true]);
            rows.push([t.taken, fmtDate(data.takenAt, t)]);
            const days = Math.round(((Number(data.dueAt) || 0) - (Number(data.takenAt) || 0)) / 86400000);
            rows.push([t.term, `${days} ${t.days}`]);
            rows.push([t.due, fmtDate(data.dueAt, t), true]);
        }
        const rowH = 62, tx = 66, tw = W - 132;
        c.fillStyle = '#f3f4f6'; rr(c, tx, y, tw, rows.length * rowH, 14); c.fill();
        c.strokeStyle = '#e5e7eb'; c.lineWidth = 2; rr(c, tx, y, tw, rows.length * rowH, 14); c.stroke();
        rows.forEach((r, i) => {
            const ry = y + i * rowH;
            if (i) { c.strokeStyle = '#e5e7eb'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(tx + 20, ry); c.lineTo(tx + tw - 20, ry); c.stroke(); }
            c.textAlign = 'left'; c.fillStyle = '#6b7280'; c.font = '600 21px ' + FM; c.fillText(r[0], tx + 24, ry + 39);
            c.textAlign = 'right'; c.fillStyle = r[2] ? accent : '#111827'; c.font = (r[2] ? '800 25px ' : '700 23px ') + FB;
            c.fillText(r[1], tx + tw - 24, ry + 40);
        });
        y += rows.length * rowH + 40;

        // блок «как вернуть»
        c.textAlign = 'left';
        c.fillStyle = '#0b3d2a'; c.font = '800 20px ' + FB; c.fillText(t.howTitle, 66, y);
        y += 14;
        c.fillStyle = '#374151'; c.font = '500 21px ' + FM;
        t.how.forEach((s) => { const ty = y + 26; c.fillStyle = '#12a150'; c.beginPath(); c.arc(74, ty - 8, 5, 0, Math.PI * 2); c.fill(); c.fillStyle = '#374151'; y = wrap(c, s, 92, ty, W - 160, 30) - 20; });
        y += 20;
        y += 22;

        // блок предупреждения
        const warn = remind ? t.warn : t.warnIssued;
        c.font = '500 21px ' + FM;
        let need = 84;
        warn.forEach((s) => {
            let lines = 1, line = '';
            s.split(' ').forEach((w) => { const test = line ? line + ' ' + w : w; if (c.measureText(test).width > W - 190 && line) { lines++; line = w; } else line = test; });
            need += lines * 30 + 8;
        });
        c.fillStyle = remind ? '#fdecea' : '#fff7e0';
        rr(c, 66, y, W - 132, need, 14); c.fill();
        c.strokeStyle = remind ? '#d63a2f' : '#e0a800'; c.lineWidth = 3; rr(c, 66, y, W - 132, need, 14); c.stroke();
        // знак «!»
        c.fillStyle = remind ? '#d63a2f' : '#e0a800'; c.beginPath(); c.arc(100, y + 36, 18, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#fff'; c.font = '800 24px ' + FB; c.textAlign = 'center'; c.fillText('!', 100, y + 45);
        c.textAlign = 'left'; c.fillStyle = remind ? '#b3261e' : '#8a6500'; c.font = '800 19px ' + FB; c.fillText(t.warnTitle, 132, y + 43);
        let wy = y + 66;
        c.font = '500 21px ' + FM;
        warn.forEach((s) => { c.fillStyle = remind ? '#d63a2f' : '#e0a800'; c.beginPath(); c.arc(92, wy + 14, 4.5, 0, Math.PI * 2); c.fill(); c.fillStyle = '#374151'; wy = wrap(c, s, 112, wy + 20, W - 190, 30) + 8 - 10; });

        // подпись и футер
        const fy = H - 150;
        c.textAlign = 'left'; c.fillStyle = '#6b7280'; c.font = '600 18px ' + FM; c.fillText(t.sign, 66, fy);
        c.strokeStyle = '#9ca3af'; c.lineWidth = 2; c.beginPath(); c.moveTo(66, fy + 36);
        c.bezierCurveTo(110, fy + 4, 130, fy + 62, 176, fy + 26); c.bezierCurveTo(210, fy + 2, 230, fy + 50, 290, fy + 22); c.stroke();
        c.fillStyle = '#9ca3af'; c.font = '500 15px ' + FM;
        wrap(c, t.foot, 66, H - 86, W - 132, 21);
        c.restore();
    }

    return { W, H, draw, contractNo, fmtAmount, T };
});
