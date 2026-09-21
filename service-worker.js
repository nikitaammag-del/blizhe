/* =====================================================================
   service-worker.js — офлайн-режим «Ближе к людям»
   Стратегии:
   • Оболочка приложения (html/js/css/иконки): кэш сначала, обновление в фоне.
   • Внешние API (Википедия, rss2json): сеть с таймаутом, при сбое — последний кэш.
   • Снимки по датам за 7 дней хранит само приложение (localStorage).
   ===================================================================== */
const VERSION = 'gd-v2';
const SHELL = `${VERSION}-shell`, API = `${VERSION}-api`;
const FILES = ['./', './index.html', './app.js', './data.js', './manifest.json',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
const API_HOSTS = ['ru.wikipedia.org', 'api.rss2json.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (API_HOSTS.includes(url.hostname)) { e.respondWith(apiStrategy(req)); return; }
  if (url.origin === location.origin && url.pathname.endsWith('/daily.json')) { e.respondWith(dailyStrategy(req)); return; }
  if (url.origin === location.origin) { e.respondWith(shellStrategy(req)); }
});

/* Оболочка: отдаём из кэша, параллельно обновляем */
async function shellStrategy(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then(r => { if (r && r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
  if (hit) return hit;
  const r = await net;
  return r || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error());
}
/* Ежедневная подборка: всегда пробуем свежую с сервера, при отсутствии сети — последняя сохранённая */
async function dailyStrategy(req) {
  const cache = await caches.open(API);
  try { const r = await fetch(req, { cache: 'no-cache', signal: AbortSignal.timeout(8000) }); if (r && r.ok) cache.put('./daily.json', r.clone()); return r; }
  catch (err) { return (await cache.match('./daily.json')) || new Response('{}', { status: 504, headers: { 'Content-Type': 'application/json' } }); }
}
/* API: сеть до 8 сек, затем кэш */
async function apiStrategy(req) {
  const cache = await caches.open(API);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(req, { signal: ctl.signal }); clearTimeout(t);
    if (r && r.ok) { cache.put(req, r.clone()); trim(cache); }
    return r;
  } catch (err) {
    const hit = await cache.match(req);
    return hit || new Response('{}', { status: 504, headers: { 'Content-Type': 'application/json' } });
  }
}
/* Ограничиваем размер кэша API (примерно 7 дней запросов) */
async function trim(cache) { const ks = await cache.keys(); if (ks.length > 30) for (const k of ks.slice(0, ks.length - 30)) await cache.delete(k); }

/* Клик по уведомлению открывает приложение */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});
