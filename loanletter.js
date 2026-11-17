// loanletter.js — серверный рендер «письма из банка» (выдача кредита / напоминание за сутки) в PNG (Buffer).
// Нужен @napi-rs/canvas (уже в package.json). Шрифты и монета берутся из корня проекта.
'use strict';
const path = require('path');
const draw = require('./loanletter_draw');

let lib, loadErr = null, assetsPromise = null;
function getLib() {
    if (lib !== undefined) return lib;
    try { lib = require('@napi-rs/canvas'); } catch (e) { lib = null; loadErr = e; }
    return lib;
}
function isAvailable() { return !!getLib(); }
function lastError() { return loadErr; }

function loadAssets() {
    if (assetsPromise) return assetsPromise;
    const L = getLib();
    if (!L) return Promise.reject(loadErr || new Error('@napi-rs/canvas is not installed'));
    try {
        L.GlobalFonts.registerFromPath(path.join(__dirname, 'Inter-Bold.otf'), 'CrownBold');
        L.GlobalFonts.registerFromPath(path.join(__dirname, 'Inter-Medium.otf'), 'CrownMed');
    } catch (e) { console.error('loanletter: шрифты не зарегистрированы:', e.message); }
    assetsPromise = L.loadImage(path.join(__dirname, 'pepe_coin.png')).then((coin) => ({ coin }));
    assetsPromise.catch(() => { assetsPromise = null; });
    return assetsPromise;
}

// data: { kind: 'issued'|'reminder', lang, name, uid, principal, owed, rate, takenAt, dueAt, now }
async function renderLoanLetter(data) {
    const L = getLib();
    if (!L) throw loadErr || new Error('@napi-rs/canvas is not installed');
    const imgs = await loadAssets();
    const cv = L.createCanvas(draw.W, draw.H);
    draw.draw(cv.getContext('2d'), data, imgs);
    return typeof cv.encode === 'function' ? await cv.encode('png') : cv.toBuffer('image/png');
}

module.exports = { renderLoanLetter, isAvailable, lastError };
