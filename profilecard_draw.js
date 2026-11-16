// profilecard_draw.js — рисование карточки профиля Crown Casino.
// Только стандартный Canvas 2D API, поэтому один и тот же код работает
//   • на сервере (@napi-rs/canvas) — для картинки в чате и инлайн-режиме,
//   • в браузере — для превью/тестов.
// Шрифты (регистрируются снаружи): 'CrownBold', 'CrownMed'. Эмодзи не используются —
// все значки нарисованы фигурами, поэтому не нужен emoji-шрифт.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CrownCard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const W = 1000, H = 600;
    const FB = 'CrownBold, Inter, "DejaVu Sans", Arial, sans-serif';
    const FM = 'CrownMed, Inter, "DejaVu Sans", Arial, sans-serif';

    const LABELS = {
        ru: { bets: 'СТАВОК', wins: 'ПОБЕД', rate: 'ВИНРЕЙТ', crash: 'ЛУЧШИЙ ИКС', flappy: 'РЕКОРД FLAPPY', win: 'КРУПНЕЙШИЙ ВЫИГРЫШ', lvl: 'УР.', nocoin: 'Монета Genesis: нет', coinOf: 'из' },
        ro: { bets: 'PARIURI', wins: 'VICTORII', rate: 'RATĂ', crash: 'CEL MAI MARE X', flappy: 'RECORD FLAPPY', win: 'CEL MAI MARE CÂȘTIG', lvl: 'NIV.', nocoin: 'Moneda Genesis: nu', coinOf: 'din' },
        en: { bets: 'BETS', wins: 'WINS', rate: 'WIN RATE', crash: 'BEST MULTIPLIER', flappy: 'FLAPPY RECORD', win: 'BIGGEST WIN', lvl: 'LV', nocoin: 'Genesis coin: none', coinOf: 'of' },
    };

    function fmtShort(n) {
        n = Math.max(0, Math.floor(Number(n) || 0));
        if (n < 1000) return String(n);
        const units = [['t', 1e12], ['b', 1e9], ['m', 1e6], ['k', 1e3]];
        for (const [s, v] of units) {
            if (n >= v) {
                const x = n / v;
                if (x >= 1e6) return x.toExponential(1).replace('+', '') + s;
                return (x >= 100 ? String(Math.floor(x)) : x >= 10 ? String(Math.floor(x * 10) / 10) : String(Math.floor(x * 100) / 100)) + s;
            }
        }
        return String(n);
    }
    function rng(seedStr) {            // детерминированный генератор (звёзды не «прыгают» между рендерами)
        let h = 1779033703 ^ String(seedStr).length;
        for (let i = 0; i < String(seedStr).length; i++) { h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
        let a = h >>> 0;
        return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }
    function rr(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        ctx.beginPath(); ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    function fitText(ctx, text, maxW) {
        if (ctx.measureText(text).width <= maxW) return text;
        let t = text;
        while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
        return t + '…';
    }
    function hueOf(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
    function star(ctx, cx, cy, R, r, pts) {
        ctx.beginPath();
        for (let i = 0; i < pts * 2; i++) {
            const ang = -Math.PI / 2 + i * Math.PI / pts, rad = i % 2 ? r : R;
            ctx[i ? 'lineTo' : 'moveTo'](cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
        }
        ctx.closePath();
    }
    function sparkle(ctx, x, y, s, a) {
        ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = '#fff6c9'; ctx.shadowColor = '#ffd35c'; ctx.shadowBlur = s * 1.5;
        ctx.beginPath(); ctx.moveTo(x, y - s); ctx.quadraticCurveTo(x, y, x + s, y); ctx.quadraticCurveTo(x, y, x, y + s);
        ctx.quadraticCurveTo(x, y, x - s, y); ctx.quadraticCurveTo(x, y, x, y - s); ctx.fill(); ctx.restore();
    }
    function drawImg(ctx, img, x, y, w, h) { if (img) ctx.drawImage(img, x, y, w, h); }
    function drawImgFit(ctx, img, cx, cy, maxW, maxH) {
        if (!img) return;
        const k = Math.min(maxW / img.width, maxH / img.height);
        ctx.drawImage(img, cx - img.width * k / 2, cy - img.height * k / 2, img.width * k, img.height * k);
    }

    // ---------------- ФОНЫ ----------------
    function drawBackground(ctx, id, imgs, seed) {
        const R = rng(seed + id);
        const lg = (x0, y0, x1, y1, stops) => { const g = ctx.createLinearGradient(x0, y0, x1, y1); stops.forEach(([o, c]) => g.addColorStop(o, c)); return g; };
        const glow = (x, y, r, c0, c1) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, c0); g.addColorStop(1, c1); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); };
        if (id === 'pepe') {
            ctx.fillStyle = lg(0, 0, W, H, [[0, '#14573a'], [1, '#07261a']]); ctx.fillRect(0, 0, W, H);
            glow(820, 140, 520, 'rgba(60,220,120,0.28)', 'rgba(60,220,120,0)');
            ctx.save(); ctx.globalAlpha = 0.20; drawImgFit(ctx, imgs.pepeHappy, 790, 330, 520, 560); ctx.restore();
            ctx.fillStyle = 'rgba(255,255,255,0.05)';
            for (let y = 20; y < H; y += 36) for (let x = (y / 36) % 2 ? 18 : 0; x < W; x += 36) { ctx.beginPath(); ctx.arc(x, y, 2, 0, 6.3); ctx.fill(); }
        } else if (id === 'space') {
            ctx.fillStyle = lg(0, 0, W, H, [[0, '#2a1d7a'], [0.6, '#12184f'], [1, '#080b24']]); ctx.fillRect(0, 0, W, H);
            glow(250, 100, 460, 'rgba(123,92,255,0.35)', 'rgba(123,92,255,0)');
            glow(880, 520, 420, 'rgba(58,168,255,0.22)', 'rgba(58,168,255,0)');
            for (let i = 0; i < 90; i++) { const a = 0.25 + R() * 0.7; ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(2) + ')'; ctx.beginPath(); ctx.arc(R() * W, R() * H, 0.6 + R() * 1.8, 0, 6.3); ctx.fill(); }
        } else if (id === 'sunset') {
            ctx.fillStyle = lg(0, 0, 0, H, [[0, '#ff8a5b'], [0.45, '#c2406e'], [1, '#2a1250']]); ctx.fillRect(0, 0, W, H);
            glow(500, 560, 520, 'rgba(255,210,120,0.55)', 'rgba(255,210,120,0)');
            ctx.fillStyle = 'rgba(0,0,0,0.12)'; for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(0, H); for (let x = 0; x <= W; x += 20) ctx.lineTo(x, H - 40 - i * 26 - Math.sin(x / 90 + i) * 16); ctx.lineTo(W, H); ctx.closePath(); ctx.fill(); }
        } else if (id === 'genesis') {
            ctx.fillStyle = lg(0, 0, W, H, [[0, '#0e5a34'], [0.5, '#073a22'], [1, '#03150c']]); ctx.fillRect(0, 0, W, H);
            glow(800, 300, 560, 'rgba(70,255,140,0.32)', 'rgba(70,255,140,0)');
            glow(120, 560, 420, 'rgba(255,211,92,0.14)', 'rgba(255,211,92,0)');
            ctx.save(); ctx.globalAlpha = 0.13; drawImgFit(ctx, imgs.pepeSad, 170, 420, 340, 380); ctx.restore();
            ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 2;
            for (let x = -H; x < W; x += 46) { ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x + H, 0); ctx.stroke(); }
            for (let i = 0; i < 16; i++) sparkle(ctx, 40 + R() * (W - 80), 30 + R() * (H - 60), 3 + R() * 6, 0.25 + R() * 0.6);
        } else {                                                            // classic
            ctx.fillStyle = lg(0, 0, W, H, [[0, '#1b2038'], [1, '#0b0e18']]); ctx.fillRect(0, 0, W, H);
            glow(160, 90, 460, 'rgba(123,92,255,0.22)', 'rgba(123,92,255,0)');
            glow(900, 560, 380, 'rgba(58,168,255,0.14)', 'rgba(58,168,255,0)');
            ctx.strokeStyle = 'rgba(255,255,255,0.035)'; ctx.lineWidth = 1;
            for (let x = 0; x <= W; x += 50) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
            for (let y = 0; y <= H; y += 50) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        }
    }

    // ---------------- РАМКИ ----------------
    function drawFrame(ctx, id) {
        ctx.save();
        const stroke = (w, style, blur, color) => { rr(ctx, w / 2 + 6, w / 2 + 6, W - w - 12, H - w - 12, 34); ctx.lineWidth = w; ctx.strokeStyle = style; ctx.shadowBlur = blur || 0; ctx.shadowColor = color || 'transparent'; ctx.stroke(); };
        const g = (stops) => { const gr = ctx.createLinearGradient(0, 0, W, H); stops.forEach(([o, c]) => gr.addColorStop(o, c)); return gr; };
        if (id === 'green') stroke(7, '#22e07a', 18, '#22e07a');
        else if (id === 'gold') stroke(9, g([[0, '#fff1a8'], [0.5, '#e3a008'], [1, '#fff1a8']]), 20, '#ffd35c');
        else if (id === 'neon') stroke(7, g([[0, '#7b5cff'], [0.5, '#3aa8ff'], [1, '#22e07a']]), 22, '#3aa8ff');
        else if (id === 'genesis') {
            stroke(10, g([[0, '#fff1a8'], [0.5, '#e3a008'], [1, '#fff1a8']]), 22, '#ffd35c');
            ctx.shadowBlur = 0; rr(ctx, 24, 24, W - 48, H - 48, 26); ctx.lineWidth = 3; ctx.strokeStyle = '#22e07a'; ctx.stroke();
            sparkle(ctx, 40, 40, 14, 0.95); sparkle(ctx, W - 40, 40, 14, 0.95); sparkle(ctx, 40, H - 40, 14, 0.95); sparkle(ctx, W - 40, H - 40, 14, 0.95);
        } else stroke(3, 'rgba(255,255,255,0.18)', 0);
        ctx.restore();
    }

    // ---------------- ГЛАВНАЯ ФУНКЦИЯ ----------------
    // data: { name, username, titleText, level, bg, frame, lang, coin:{serial,total}|null,
    //         stats:{bets,wins,crashBest,flappyBest,biggestWin} }
    function drawCard(ctx, data, imgs) {
        imgs = imgs || {};
        const L = LABELS[data.lang] || LABELS.ru;
        const bg = data.bg || 'classic', frame = data.frame || 'plain';
        const st = data.stats || {};
        ctx.save(); rr(ctx, 0, 0, W, H, 36); ctx.clip();
        drawBackground(ctx, bg, imgs, String(data.name || '') + String(data.username || ''));

        // монета Genesis справа
        const holder = !!data.coin;
        if (holder) {
            ctx.save(); ctx.shadowColor = 'rgba(70,255,140,0.65)'; ctx.shadowBlur = 50;
            drawImgFit(ctx, imgs.coin, 852, 112, 172, 172); ctx.restore();
        } else if (bg === 'pepe') { /* лицо Пепе уже на фоне */ }

        // аватар
        const hue = hueOf(String(data.name || '?')), ax = 135, ay = 140, ar = 74;
        ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 24; ctx.beginPath(); ctx.arc(ax, ay, ar + 8, 0, 6.3);
        ctx.fillStyle = frame === 'gold' || frame === 'genesis' ? '#ffd35c' : frame === 'green' ? '#22e07a' : frame === 'neon' ? '#3aa8ff' : 'rgba(255,255,255,0.25)'; ctx.fill(); ctx.restore();
        const ag = ctx.createLinearGradient(ax - ar, ay - ar, ax + ar, ay + ar);
        ag.addColorStop(0, 'hsl(' + hue + ',75%,58%)'); ag.addColorStop(1, 'hsl(' + ((hue + 50) % 360) + ',70%,36%)');
        ctx.beginPath(); ctx.arc(ax, ay, ar, 0, 6.3); ctx.fillStyle = ag; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '700 72px ' + FB; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(data.name || '?').trim().charAt(0).toUpperCase() || '?', ax, ay + 4);

        // имя / ник / титул
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 8;
        ctx.fillStyle = '#ffffff'; ctx.font = '700 56px ' + FB;
        ctx.fillText(fitText(ctx, String(data.name || 'Player'), holder ? 400 : 560), 240, 128);
        ctx.restore();
        if (data.username) { ctx.fillStyle = 'rgba(210,220,245,0.8)'; ctx.font = '500 26px ' + FM; ctx.fillText('@' + data.username, 242, 166); }
        // титул
        const tt = String(data.titleText || '');
        ctx.font = '700 24px ' + FB; const tw = Math.min(520, ctx.measureText(tt).width + 52);
        rr(ctx, 240, 186, tw, 44, 22); ctx.fillStyle = holder ? 'rgba(255,211,92,0.22)' : 'rgba(255,255,255,0.13)'; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = holder ? 'rgba(255,211,92,0.8)' : 'rgba(255,255,255,0.25)'; ctx.stroke();
        star(ctx, 262, 208, 9, 4, 5); ctx.fillStyle = holder ? '#ffd35c' : '#9fb4ff'; ctx.fill();
        ctx.fillStyle = holder ? '#ffe9a3' : '#e8eeff'; ctx.fillText(fitText(ctx, tt, 460), 282, 216);

        // уровень
        const lx = holder ? 690 : 905, ly = holder ? 98 : 78;
        ctx.save(); ctx.beginPath(); ctx.arc(lx, ly, 44, 0, 6.3); ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fill();
        ctx.lineWidth = 4; ctx.strokeStyle = holder ? '#ffd35c' : '#7b5cff'; ctx.stroke();
        ctx.textAlign = 'center'; ctx.fillStyle = '#c9d4ff'; ctx.font = '700 15px ' + FB; ctx.fillText(L.lvl, lx, ly - 10);
        ctx.fillStyle = '#fff'; ctx.font = '700 34px ' + FB; ctx.fillText(String(data.level || 1), lx, ly + 26); ctx.restore();

        // сетка статистики 3×2
        const bets = st.bets || 0, wins = st.wins || 0, rate = bets > 0 ? Math.min(100, Math.round(wins / bets * 100)) : 0;
        const cells = [
            [L.bets, fmtShort(bets)], [L.wins, fmtShort(wins)], [L.rate, rate + '%'],
            [L.crash, st.crashBest > 0 ? '×' + (Math.floor(st.crashBest * 100) / 100) : '—'],
            [L.flappy, st.flappyBest > 0 ? String(st.flappyBest) : '—'], [L.win, st.biggestWin > 0 ? fmtShort(st.biggestWin) : '—'],
        ];
        const gx = 60, gy = 292, cw = 282, ch = 112, gap = 18;
        cells.forEach((c, i) => {
            const x = gx + (i % 3) * (cw + gap), y = gy + Math.floor(i / 3) * (ch + gap);
            rr(ctx, x, y, cw, ch, 22); ctx.fillStyle = 'rgba(0,0,0,0.34)'; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.stroke();
            ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(190,205,240,0.85)'; ctx.font = '700 17px ' + FB; ctx.fillText(c[0], x + 22, y + 36);
            ctx.fillStyle = '#ffffff'; ctx.font = '700 44px ' + FB; ctx.fillText(fitText(ctx, c[1], cw - 40), x + 22, y + 86);
        });

        // подпись монеты / футер
        ctx.textAlign = 'left';
        if (holder) {
            ctx.textAlign = 'right';
            ctx.fillStyle = '#ffe9a3'; ctx.font = '700 19px ' + FB; ctx.fillText('GENESIS PEPE COIN', 952, 236);
            ctx.fillStyle = '#7dffb0'; ctx.font = '700 30px ' + FB; ctx.fillText('#' + data.coin.serial + ' ' + L.coinOf + ' ' + data.coin.total, 952, 270);
            ctx.textAlign = 'left';
        } else {
            ctx.fillStyle = 'rgba(190,205,240,0.5)'; ctx.font = '500 20px ' + FM; ctx.textAlign = 'right'; ctx.fillText(L.nocoin, W - 60, 566); ctx.textAlign = 'left';
        }
        ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '700 22px ' + FB; ctx.fillText('CROWN CASINO', 60, 566);
        star(ctx, 40, 558, 9, 4, 5); ctx.fillStyle = '#ffd35c'; ctx.fill();
        ctx.restore();
        drawFrame(ctx, frame);
    }

    return { W, H, LABELS, drawCard, fmtShort };
});
