/* =====================================================================
   tools/make-preview.mjs — страница предпросмотра черновика: …/blizhe/preview/
   Копия сайта, которая показывает выпуск из preview/daily.json (ещё не опубликованный).

   • Сверху — плашка «ЧЕРНОВИК на <дата> — ещё не опубликован».
   • Закрыта от поисковиков (noindex), без счётчика просмотров.
   • Не трогает ваш настоящий прогресс: в предпросмотре приложение работает с временной памятью
     вместо хранилища браузера (отметки, баллы и серия на основном сайте не меняются).
   • Без service worker: предпросмотр всегда берётся с сервера свежим.
   ===================================================================== */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = path.join(ROOT, 'preview');
const FILES = ['app.js', 'data.js', 'blocklist.js', 'illustrations.js', 'manifest.json', 'privacy.html'];

const d = JSON.parse(await fs.readFile(path.join(P, 'daily.json'), 'utf8'));
const human = new Date(d.date + 'T12:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: 'UTC' });

await fs.mkdir(path.join(P, 'tools'), { recursive: true });
for (const f of FILES) { try { await fs.copyFile(path.join(ROOT, f), path.join(P, f)); } catch (e) { /* необязательный файл */ } }
await fs.copyFile(path.join(ROOT, 'tools', 'curriculum.mjs'), path.join(P, 'tools', 'curriculum.mjs'));
await fs.cp(path.join(ROOT, 'icons'), path.join(P, 'icons'), { recursive: true });

// Временная память вместо localStorage: настройки (тема, «знакомство пройдено») берутся из вашего настоящего профиля, но ничего не записывается обратно
const SHIM = `<script>(function(){var m={};try{var r=window.localStorage.getItem('gd:v1');if(r)m['gd:v1']=r;}catch(e){}
var s={getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}};
try{Object.defineProperty(window,'localStorage',{value:s,configurable:true});}catch(e){}
try{if(navigator.serviceWorker){Object.defineProperty(navigator.serviceWorker,'register',{value:function(){return Promise.reject(new Error('предпросмотр без service worker'))},configurable:true});}}catch(e){}})();</script>`;
const BANNER = `<div role="note" style="position:sticky;top:0;z-index:999;background:#B00020;color:#fff;font:600 15px/1.4 system-ui,sans-serif;padding:10px 14px;padding-top:calc(10px + env(safe-area-inset-top,0px));text-align:center">ЧЕРНОВИК на ${human} — ещё не опубликован. Проверь и одобри до 22:00.</div>`;

let html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
html = html
  .replace(/<head>/i, `<head>\n<meta name="robots" content="noindex, nofollow">\n${SHIM}`)
  .replace(/<title>[^<]*<\/title>/i, `<title>ЧЕРНОВИК ${d.date} — Ближе к людям</title>`)
  .replace(/<!--\s*Cloudflare Web Analytics\s*-->[\s\S]*?<!--\s*End Cloudflare Web Analytics\s*-->/i, '')
  .replace(/<script[^>]*cloudflareinsights[^>]*><\/script>/gi, '')
  .replace(/<body([^>]*)>/i, `<body$1>\n${BANNER}`);
await fs.writeFile(path.join(P, 'index.html'), html);
await fs.writeFile(path.join(P, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log(`Предпросмотр готов: preview/ (выпуск на ${d.date})`);
