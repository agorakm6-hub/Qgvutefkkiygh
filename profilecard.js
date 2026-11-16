// profilecard.js — серверный рендер карточки профиля в PNG (Buffer).
// Использует @napi-rs/canvas (готовые бинарники, ничего ставить в систему не нужно):  npm i @napi-rs/canvas
// Если библиотеки нет — isAvailable() вернёт false, а бот ответит текстовой карточкой (ничего не ломается).
'use strict';
const path = require('path');
const draw = require('./profilecard_draw');

let lib, loadErr = null, imgsPromise = null;
const cache = new Map();           // ключ данных -> готовый PNG (LRU на 150 штук)

function getLib() {
    if (lib !== undefined) return lib;
    try { lib = require('@napi-rs/canvas'); } catch (e) { lib = null; loadErr = e; }
    return lib;
}
function isAvailable() { return !!getLib(); }
function lastError() { return loadErr; }

function loadAssets() {
    if (imgsPromise) return imgsPromise;
    const L = getLib();
    if (!L) return Promise.reject(loadErr || new Error('@napi-rs/canvas is not installed'));
    const A = __dirname; // плоская структура: шрифты и картинки лежат рядом с profilecard.js
    try {
        L.GlobalFonts.registerFromPath(path.join(A, 'Inter-Bold.otf'), 'CrownBold');
        L.GlobalFonts.registerFromPath(path.join(A, 'Inter-Medium.otf'), 'CrownMed');
    } catch (e) { console.error('profilecard: шрифты не зарегистрированы:', e.message); }
    imgsPromise = Promise.all([
        L.loadImage(path.join(A, 'pepe_coin.png')),
        L.loadImage(path.join(A, 'pepe_happy.png')),
        L.loadImage(path.join(A, 'pepe_sad.png')),
    ]).then(([coin, pepeHappy, pepeSad]) => ({ coin, pepeHappy, pepeSad }))
      .catch((e) => { imgsPromise = null; throw e; });
    return imgsPromise;
}

async function renderProfileCard(data) {
    const key = JSON.stringify(data);
    if (cache.has(key)) { const b = cache.get(key); cache.delete(key); cache.set(key, b); return b; }
    const L = getLib();
    if (!L) throw loadErr || new Error('@napi-rs/canvas is not installed');
    const imgs = await loadAssets();
    const cv = L.createCanvas(draw.W, draw.H);
    draw.drawCard(cv.getContext('2d'), data, imgs);
    const buf = typeof cv.encode === 'function' ? await cv.encode('png') : cv.toBuffer('image/png');
    cache.set(key, buf);
    if (cache.size > 150) cache.delete(cache.keys().next().value);
    return buf;
}

module.exports = { renderProfileCard, isAvailable, lastError, W: draw.W, H: draw.H };
