/* =====================================================================
   app.js — логика «Ближе к людям» (этап 1: ядро + большинство разделов)
   Без сборщиков, без зависимостей. Данные пользователя — только в localStorage.
   ===================================================================== */
'use strict';
(() => {
const D = window.DATA;

/* ---------- Настройки, которые вы заполняете сами ---------- */
const CFG = {
  MAX_BOT_URL: '',                                   // ссылка на MAX-бота (когда он будет создан)
  DONATE: { yoomoney: '', boosty: '', patreon: '' }, // ссылки на донаты
  AFF: { litres: '', ozon: '' },                     // партнёрские ID (пусто = обычные поисковые ссылки)
  API_TIMEOUT: 8000,                                 // таймаут запросов к API, мс
  KEEP_DAYS: 7                                       // сколько дней хранить снимки для офлайна
};

/* ---------- Мелкие помощники ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const hid = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'i' + (h >>> 0).toString(36); };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
/* «Сегодня» = локальная дата пользователя (не UTC) */
const dstr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dayNum = s => { const d = parseD(s); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5); };
/* Детерминированный выбор по дате: у всех один и тот же «день» */
const pick = (arr, n = 1, salt = 0) => { const out = []; const b = dayNum(viewDate) * n + salt; for (let i = 0; i < n && i < arr.length; i++) out.push(arr[(b + i) % arr.length]); return out; };

/* ---------- Хранилище ---------- */
const KEY = 'gd:v1';
const defaults = () => ({ v: 1, uid: uuid(), onboarded: false, name: '', time: '09:00', theme: 'dark', font: 100, lang: 'ru',
  notify: false, days: {}, fav: [], myPrompts: [], snap: {}, ach: {}, stats: { sessions: 0, totalSec: 0 }, friend: null });
let S = (() => { try { const r = JSON.parse(localStorage.getItem(KEY)); if (r && r.v === 1) return Object.assign(defaults(), r); } catch (e) {} return defaults(); })();
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Не удалось сохранить: память браузера заполнена. Сделайте экспорт данных.'); } }

/* ---------- Состояние экрана ---------- */
let viewDate = dstr();
let searchQ = '';
const REG = {}; // реестр карточек для избранного/копирования: id → {id,type,text,meta}
const mk = (type, text, meta = '') => { const id = hid(type + text); REG[id] = { id, type, text, meta }; return REG[id]; };
const isFav = id => S.fav.some(f => f.id === id);
const dayRec = d => (S.days[d] ||= { done: {}, notes: {}, task: '' });

/* ---------- Ежедневная подборка: daily.json собирает сервер (GitHub Actions), см. tools/build-daily.mjs ---------- */
let DAILY = (() => { try { return JSON.parse(localStorage.getItem('gd:daily')) || null; } catch (e) { return null; } })();
/* Подборка годится для «сегодня» с допуском ±1 день (разные часовые пояса) */
const dailyOk = () => !!(DAILY && DAILY.date && Math.abs(dayNum(DAILY.date) - dayNum(viewDate)) <= 1);
/* Сначала свежие материалы из подборки, недостающее добираем из локальной базы */
const mix = (key, arr, n, salt = 0) => { const d = dailyOk() && Array.isArray(DAILY[key]) ? DAILY[key].slice(0, n) : []; return d.length >= n ? d : [...d, ...pick(arr, n - d.length, salt)]; };
async function fetchDaily() {
  try {
    const j = await fetchJSON('daily.json?d=' + dstr(), 6000); if (!j || j.v !== 1 || !j.date) return;
    const changed = !DAILY || DAILY.date !== j.date || DAILY.generated !== j.generated;
    DAILY = j; try { localStorage.setItem('gd:daily', JSON.stringify(j)); } catch (e) {}
    /* Перерисовываем, только если пользователь сейчас ничего не вводит */
    if (changed && currentRoute() === 'today' && !/^(TEXTAREA|INPUT)$/.test((document.activeElement || {}).tagName)) render();
  } catch (e) { /* подборки нет или сеть недоступна — работаем на локальной базе */ }
}

/* ---------- Разделы дня ---------- */
const SECTIONS = [
  { id: 'greet', t: 'Настрой на день', m: 1 }, { id: 'comm', t: 'Секреты коммуникации', m: 5 },
  { id: 'events', t: 'Великие события дня', m: 4 }, { id: 'quotes', t: 'Мудрость дня', m: 4 },
  { id: 'humor', t: 'Юмор дня', m: 3 }, { id: 'news', t: 'Новости и факты', m: 4 },
  { id: 'prompt', t: 'Промпт-инжиниринг дня', m: 6 }, { id: 'word', t: 'Слово дня', m: 1 },
  { id: 'reflect', t: 'Вопросы для саморефлексии', m: 2 }, { id: 'habit', t: 'Микро-привычка дня', m: 1 },
  { id: 'book', t: 'Книга дня', m: 1 }, { id: 'film', t: 'Фильм дня', m: 1 },
  { id: 'track', t: 'Трек дня', m: 1 }, { id: 'summary', t: 'Итог дня', m: 1 }
];
const ROUTES = [['today', 'Сегодня', '📖'], ['library', 'Библиотека', '🧰'], ['fav', 'Избранное', '⭐'], ['progress', 'Прогресс', '🏆'], ['settings', 'Настройки', '⚙️']];

/* ---------- Геймификация ---------- */
const LEVELS = [['Новичок', 0], ['Читатель', 100], ['Эрудит', 400], ['Мудрец', 1000], ['Гений', 2500]];
function streakInfo() {
  const has = s => S.days[s] && Object.keys(S.days[s].done).length > 0;
  const keys = Object.keys(S.days).filter(has).sort();
  let best = 0, run = 0, prev = null;
  keys.forEach(k => { run = prev && dayNum(k) - dayNum(prev) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = k; });
  let cur = 0; const d = new Date(); if (!has(dstr(d))) d.setDate(d.getDate() - 1);
  while (has(dstr(d))) { cur++; d.setDate(d.getDate() - 1); }
  return { cur, best };
}
function points() {
  let p = 0;
  Object.values(S.days).forEach(r => { p += Object.keys(r.done).length * 10; p += Object.values(r.notes || {}).filter(x => x && x.trim()).length * 5; });
  return p + streakInfo().cur * 5 + S.myPrompts.length * 3;
}
const levelOf = p => { let l = 0; LEVELS.forEach((x, i) => { if (p >= x[1]) l = i; }); return l; };
function achievements() {
  const st = streakInfo(); const commDays = Object.values(S.days).filter(r => r.done.comm).length;
  return [
    { id: 'first', t: 'Первый день', d: 'Отметь хотя бы один раздел', ok: Object.keys(S.days).some(k => Object.keys(S.days[k].done).length) },
    { id: 's7', t: '7 дней подряд', d: 'Серия из 7 дней', ok: st.best >= 7 },
    { id: 's30', t: '30 дней подряд', d: 'Серия из 30 дней', ok: st.best >= 30 },
    { id: 'q50', t: '50 сохранённых цитат', d: 'Добавь 50 цитат в избранное', ok: S.fav.filter(f => f.type === 'quote').length >= 50 },
    { id: 'c10', t: '10 советов по коммуникации', d: 'Прочитай раздел коммуникации 10 раз', ok: commDays >= 10 },
    { id: 'p5', t: 'Коллекция промптов', d: 'Сохрани 5 своих промптов', ok: S.myPrompts.length >= 5 }
  ];
}
function checkAch() { achievements().forEach(a => { if (a.ok && !S.ach[a.id]) { S.ach[a.id] = 1; toast('🏆 Достижение: ' + a.t); } }); save(); }

/* ---------- Уведомления интерфейса ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }
async function copyText(txt) {
  try { await navigator.clipboard.writeText(txt); }
  catch (e) { const a = document.createElement('textarea'); a.value = txt; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); } catch (_) {} a.remove(); }
  toast('Скопировано');
}
function openDlg(html) { const d = $('#dlg'); d.innerHTML = html + '<div class="row" style="margin-top:14px"><button class="btn ghost" data-act="closeDlg">Закрыть</button></div>'; if (!d.open) d.showModal(); }

/* ---------- Сеть: запрос с таймаутом 8 сек ---------- */
async function fetchJSON(url, ms = CFG.API_TIMEOUT) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
/* Снимки для офлайна: храним только последние 7 дней */
function snapSet(date, key, val) { (S.snap[date] ||= {})[key] = val; Object.keys(S.snap).sort().slice(0, -CFG.KEEP_DAYS).forEach(k => delete S.snap[k]); save(); }
const snapGet = (date, key) => S.snap[date] && S.snap[date][key];
const stripHtml = h => { const t = document.createElement('div'); t.innerHTML = h || ''; return (t.textContent || '').replace(/\s+/g, ' ').trim(); };
const clip = (s, n) => s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…';
const kindLab = k => k === 'orig' ? 'Оригинал от «Ближе к людям»' : k === 'ai' ? 'Шутка нейросети' : k === 'anekdot' ? 'Анекдоты из России' : 'Проверенный анекдот';
/* Приоритетные темы для событий дня: Россия, наука, открытия, радио, ИИ */
const TOPIC = /росси|архимед|ньютон|открыт|радио|попов|искусственн|нейросет|(^|[^а-яё])ии([^а-яё]|$)/i;
const passes = t => !D.stopWords.some(w => t.toLowerCase().includes(w)); // фильтр внешних материалов

/* =====================================================================
   ОТРИСОВКА ЭКРАНОВ
   ===================================================================== */
const actions = it => `<button class="iconbtn" data-act="fav" data-id="${it.id}" aria-pressed="${isFav(it.id)}" aria-label="Добавить в избранное">${isFav(it.id) ? '★' : '☆'}</button><button class="iconbtn" data-act="copy" data-id="${it.id}" aria-label="Копировать">⧉</button>`;
const empty = (ic, txt, btn = '') => `<div class="empty"><span class="ic" aria-hidden="true">${ic}</span><p>${txt}</p>${btn}</div>`;

function greeting() {
  const h = new Date().getHours();
  const g = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  return S.name ? `${g}, ${esc(S.name)}` : g;
}

/* ----- Тело каждого раздела ----- */
const BODY = {
  greet() {
    const phr = pick(D.phrases, 1)[0];
    const date = parseD(viewDate).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
    const st = streakInfo();
    return `<p class="muted">${esc(date)}</p><p class="quote">${esc(phr)}</p><p class="muted"><small>Настрой дня — авторская формулировка приложения, не цитата.</small></p>
      ${st.cur ? `<p>🔥 Серия: <b>${st.cur}</b> ${plural(st.cur, 'день', 'дня', 'дней')} подряд</p>` : '<p>Начни серию: отметь первый раздел.</p>'}`;
  },
  comm() {
    const ex = D.comm[dayNum(viewDate) % D.comm.length];
    const qs = pick(D.questions, 3);
    return `<h3>${esc(ex.title)}</h3>
      <p><span class="tag">${esc(ex.mood)}</span>${ex.own ? '<span class="tag amber">Авторский пример</span>' : ''}</p>
      <p class="quote" style="font-weight:450">${esc(ex.dialog)}</p>
      <h3>Разбор</h3><ul class="clean">${ex.secrets.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      <h3>3 открытых вопроса дня</h3><ul class="clean">${qs.map(q => `<li>${esc(q)}</li>`).join('')}</ul>
      <p><b>Мини-задание:</b> ${esc(pick(D.miniTasks, 1)[0])}</p>
      <details><summary>На что обращать внимание при встрече</summary>${D.observe.map(o => `<p><b>${esc(o.h)}.</b> ${esc(o.t)}</p>`).join('')}</details>
      <p class="muted"><small>${esc(D.lifehack)}</small></p>`;
  },
  events() { return `<div id="ev-body">${skel()}</div>`; },
  quotes() {
    const md = viewDate.slice(5);
    const matched = D.quotes.filter(q => q.bd === md || q.dd === md).slice(0, 1);
    const list = [...matched, ...mix('quotes', D.quotes, 2).filter(q => !matched.includes(q))].slice(0, matched.length ? 3 : 2);
    return list.map(q => {
      const it = mk('quote', `«${q.t}» — ${q.a}${q.dis ? ' (приписывается)' : ''}`, q.src);
      const anniv = q.bd === md ? `Сегодня день рождения: ${q.a}.` : q.dd === md ? `Сегодня день памяти: ${q.a}.` : '';
      return `<div class="item"><p class="quote">«${esc(q.t)}»</p>
        <p class="quote-by">${esc(q.a)}${q.dis ? ' <span class="tag amber">приписывается</span>' : ''}</p>
        <p class="meta muted"><small>Источник: ${esc(q.src)}${q.url ? ` · <a href="${esc(q.url)}" target="_blank" rel="noopener">страница автора</a>` : ''}</small></p>
        ${anniv ? `<p><span class="tag amber">${esc(anniv)}</span></p>` : ''}
        ${q.note ? `<p>${esc(q.note)}</p>` : ''}
        <div class="row">${actions(it)}<button class="iconbtn" data-act="share" data-id="${it.id}" aria-label="Поделиться карточкой">🖼</button></div></div>`;
    }).join('');
  },
  humor() {
    const js = mix('jokes', D.jokes.filter(j => passes(j.t)), 2);
    const st = mix('stories', D.stories.filter(j => passes(j.t)), 1)[0];
    const lab = k => kindLab(k);
    let h = js.map(j => { const it = mk('joke', j.t, lab(j.kind)); return `<div class="item"><p style="white-space:pre-line">${esc(j.t)}</p><div class="row"><span class="tag ${j.kind === 'orig' ? 'amber' : ''}">${lab(j.kind)}</span>${j.url ? `<a class="btn ghost sm" href="${esc(j.url)}" target="_blank" rel="noopener">Источник: anekdot.ru</a>` : ''}${actions(it)}</div></div>`; }).join('');
    if (st) { const it = mk('joke', st.t, 'Смешная история дня'); h += `<div class="item"><h3>Смешная история дня</h3><p style="white-space:pre-line">${esc(st.t)}</p><div class="row"><span class="tag amber">${lab(st.kind)}</span>${actions(it)}</div></div>`; }
    return h + '<p class="muted"><small>Анекдоты берутся из официальных лент «Анекдоты из России» (anekdot.ru), права на тексты принадлежат их владельцам. Фильтр убирает мат, оскорбления и политику; вкусы у людей разные.</small></p>';
  },
  news() { return `<div id="news-body">${skel()}</div>`; },
  prompt() {
    const te = pick(D.techniques, 1)[0], dp = pick(D.dailyPrompts, 1)[0], tips = pick(D.tips, 4, 3), ms = pick(D.mistakes, 1)[0];
    const it = mk('prompt', dp.text, dp.title);
    const rec = dayRec(viewDate);
    const dpf = dailyOk() && DAILY.prompts && DAILY.prompts[0]; let dailyFind = '';
    if (dpf) { const it2 = mk('prompt', dpf.text, dpf.title + ' · ' + (dpf.src || ''));
      dailyFind = `<h3>Находка из каталога: ${esc(dpf.title)} ${dpf.lang === 'en' ? '<span class="tag">EN</span>' : ''}</h3><pre class="prompt">${esc(dpf.text)}</pre><div class="row">${actions(it2)}</div><p class="muted"><small>${esc(dpf.src || '')}. Отобран автоматически по рейтингу структуры промпта (роль, длина, ограничения).</small></p>`; }
    return `<h3>Техника дня: ${esc(te.n)}</h3><p>${esc(te.d)}</p><p><b>Когда применять:</b> ${esc(te.w)}</p>
      <h3>Промпт дня: ${esc(dp.title)}</h3><p class="muted">Задача: ${esc(dp.task)}</p>
      <pre class="prompt" id="dailyPromptText">${esc(dp.text)}</pre>
      <div class="row">${actions(it)}<button class="btn sm" data-act="copy" data-id="${it.id}">Скопировать промпт дня</button></div>
      <p><b>Использованные приёмы:</b> ${dp.methods.map(m => `<span class="tag">${esc(m)}</span>`).join('')}</p>
      <p><b>Что улучшить:</b> ${esc(dp.improve)}</p>
      ${dailyFind}<h3>Хитрости и приёмы</h3><ul class="clean">${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <h3>Ошибка дня</h3><p>❌ ${esc(ms.m)}</p><p>✅ ${esc(ms.f)}</p>
      <h3>Задание дня</h3><p>Перепиши свой вчерашний промпт, добавив роль, аудиторию и формат.</p>
      <label class="f" for="taskText">Твой улучшенный промпт</label>
      <textarea id="taskText" placeholder="Напиши промпт здесь — он сохранится автоматически">${esc(rec.task)}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="savePrompt">Сохранить в мою коллекцию</button><a class="btn ghost sm" href="#/library" style="text-decoration:none">Библиотека промптов</a></div>`;
  },
  word() {
    const w = mix('words', D.words, 1)[0]; const it = mk('word', `${w.w} — ${w.m}`, w.src);
    return `<p class="quote" style="font-size:1.5rem">${esc(w.w)}</p><p><b>Значение:</b> ${esc(w.m)}</p>${w.e ? `<p><b>Происхождение:</b> ${esc(w.e)}</p>` : ''}
      ${w.ex ? `<p><b>Пример:</b> <i>${esc(w.ex)}</i></p>` : ''}<p class="muted"><small>Источник: ${esc(w.src)}${w.url ? ` · <a href="${esc(w.url)}" target="_blank" rel="noopener">статья</a>` : ''}. Точные формулировки сверяйте со словарями.</small></p><div class="row">${actions(it)}</div>`;
  },
  reflect() {
    const rec = dayRec(viewDate);
    return D.reflect.map((q, i) => `<label class="f" for="note${i}">${esc(q)}</label>
      <textarea id="note${i}" data-note="${i}" placeholder="Напиши хотя бы одну мысль — она сохранится здесь">${esc(rec.notes[i] || '')}</textarea>`).join('');
  },
  habit() { return `<p class="quote">${esc(pick(D.habits, 1)[0])}</p><p class="muted">Отметь «Сделано!», когда выполнишь.</p>`; },
  book() {
    const b = mix('books', D.books, 1)[0]; const q = encodeURIComponent(b.t + ' ' + b.a);
    const aff = CFG.AFF.litres ? `&lfrom=${encodeURIComponent(CFG.AFF.litres)}` : '';
    return `<h3>${esc(b.t)}</h3><p class="muted">${esc(b.a)}${b.y ? ', ' + esc(b.y) : ''}</p>${b.orig ? `<p class="muted"><small>Оригинал: ${esc(b.orig)}</small></p>` : ''}${b.why ? `<p>${esc(b.why)}</p>` : ''}${b.rating ? `<p>Рейтинг Open Library: <b>${esc(b.rating)}</b> из 5 (${esc(b.count)} оценок)</p>` : ''}
      <div class="row"><a class="btn ghost sm" target="_blank" rel="noopener sponsored" href="https://www.litres.ru/search/?q=${q}${aff}">Найти в ЛитРес</a>
      <a class="btn ghost sm" target="_blank" rel="noopener sponsored" href="https://www.ozon.ru/search/?text=${q}">Найти на Ozon</a></div>
      <p class="muted"><small>${CFG.AFF.litres ? 'Партнёрский материал: ссылка может содержать партнёрский идентификатор.' : 'Это обычные ссылки-поиск, без партнёрских идентификаторов.'}</small></p>`;
  },
  film() {
    const f = mix('films', D.films, 1)[0]; const q = encodeURIComponent(f.t + ' ' + f.y);
    return `<h3>${esc(f.t)} <span class="muted">(${f.y})</span></h3>${f.g ? `<p><span class="tag">${esc(f.g)}</span></p>` : ''}<p>${esc(f.why)}</p>
      ${f.rating ? `<p>Рейтинг TMDB: <b>${esc(f.rating)}</b> (${esc(f.count)} голосов)</p>` : '<p class="muted"><small>Рейтинг смотрите на Кинопоиске или IMDb: мы не показываем цифры, которые не можем проверить.</small></p>'}
      <a class="btn ghost sm" target="_blank" rel="noopener" href="https://www.kinopoisk.ru/index.php?kp_query=${q}">Найти на Кинопоиске</a>`;
  },
  track() {
    const t = pick(D.tracks, 1)[0]; const q = encodeURIComponent(t.a + ' ' + t.t);
    return `<h3>${esc(t.t)}</h3><p class="muted">${esc(t.a)}</p><p>Настроение: ${esc(t.mood)}</p>
      <div class="row"><a class="btn ghost sm" target="_blank" rel="noopener" href="https://music.yandex.ru/search?text=${q}">Яндекс Музыка</a>
      <a class="btn ghost sm" target="_blank" rel="noopener" href="https://open.spotify.com/search/${q}">Spotify</a>
      <a class="btn ghost sm" target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=${q}">YouTube</a></div>`;
  },
  summary() {
    const rec = dayRec(viewDate); const n = Object.keys(rec.done).length; const st = streakInfo();
    return `<p>Сегодня отмечено разделов: <b>${n}</b> из ${SECTIONS.length}. Серия: <b>${st.cur}</b> ${plural(st.cur, 'день', 'дня', 'дней')}. Баллы: <b>${points()}</b>.</p>
      <div class="row"><button class="btn" data-act="shareDay">Поделиться днём (PNG)</button>
      <button class="btn ghost" data-act="challenge">Вызов другу</button>
      <button class="btn ghost" data-act="print">Сохранить в PDF</button></div>
      <p class="muted"><small>Сохранение в PDF: в окне печати выберите «Сохранить как PDF».</small></p>`;
  }
};
const skel = () => '<div class="skeleton"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div>';
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k >= 2 && k <= 4 ? b : c; };

/* ----- Экран «Сегодня» ----- */
function viewToday() {
  const rec = dayRec(viewDate); const done = Object.keys(rec.done).length; const pct = Math.round(done / SECTIONS.length * 100);
  const total = SECTIONS.reduce((s, x) => s + x.m, 0);
  let h = `<div class="hero"><h1>${greeting()}!</h1><p class="muted" style="margin:2px 0 0">Ближе к людям · Говори. Узнавай. Расти.</p>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Прогресс программы дня"><i id="barfill" style="width:${pct}%"></i></div>
    <p class="muted" id="barText">Программа дня: 25–35 мин · пройдено ${done} из ${SECTIONS.length}</p></div>`;
  if (S.friend) h += `<div class="banner">🤝 Тебя позвал друг. Проходи программу каждый день и сравнивайте серии. <small>(Сравнение работает вручную: пока без сервера.)</small></div>`;
  if (viewDate !== dstr()) h += `<div class="banner">Показан день ${esc(viewDate)}. <a href="#/today" data-act="today">Вернуться к сегодняшнему</a></div>`;
  SECTIONS.forEach((s, i) => {
    const isDone = !!rec.done[s.id];
    h += `<section class="card ${isDone ? 'done' : ''}" id="s-${s.id}" aria-labelledby="h-${s.id}">
      <header><span class="n" aria-hidden="true">${i + 1}</span><h2 id="h-${s.id}">${s.t}</h2><span class="mins">${s.m} мин</span></header>
      <div class="body">${BODY[s.id]()}</div>
      <footer><label class="chk"><input type="checkbox" data-sec="${s.id}" ${isDone ? 'checked' : ''}> ${s.id === 'habit' ? 'Сделано!' : 'Прочитано'}</label></footer></section>`;
  });
  $('#view').innerHTML = h;
  loadEvents(viewDate); loadNews(viewDate);
}
function updateProgress() {
  const rec = dayRec(viewDate); const done = Object.keys(rec.done).length; const pct = Math.round(done / SECTIONS.length * 100);
  const f = $('#barfill'); if (f) { f.style.width = pct + '%'; f.parentElement.setAttribute('aria-valuenow', pct); }
  const t = $('#barText'); if (t) t.textContent = `Программа дня: 25–35 мин · пройдено ${done} из ${SECTIONS.length}`;
}

/* ----- События дня: Wikipedia REST → снимок → архив ----- */
async function loadEvents(date) {
  const box = () => $('#ev-body'); const [, m, d] = date.split('-'); let list = null, mode = 'live';
  try {
    const j = await fetchJSON(`https://ru.wikipedia.org/api/rest_v1/feed/onthisday/events/${m}/${d}`);
    list = (j.events || []).filter(e => e.text && e.year).map(e => { const p = (e.pages || [])[0] || {};
      return { y: e.year, e: e.text, ex: p.extract || '', url: p.content_urls && p.content_urls.desktop && p.content_urls.desktop.page, w: (e.pages || []).length }; });
    const sc = x => x.w + (TOPIC.test(x.e) ? 3 : 0); // приоритетные темы выше в списке
    list = list.sort((a, b) => sc(b) - sc(a)).slice(0, 3).sort((a, b) => a.y - b.y);
    if (!list.length) throw new Error('empty');
    snapSet(date, 'events', list);
  } catch (e) {
    list = snapGet(date, 'events'); mode = 'snap';
    if (!list) { mode = 'archive'; const md = date.slice(5); let a = D.history.filter(x => x.d === md);
      if (!a.length) a = pick(D.history, 3, 5); list = a.map(x => ({ y: x.y, e: x.e, why: x.why, impact: x.impact, ad: x.d })); }
  }
  if (!box()) return;
  const note = mode === 'archive' ? `<div class="banner">📚 Не удалось загрузить. Показываем из архива. ${navigator.onLine ? '' : 'Нет соединения. Включи интернет — приложение загрузит программу дня.'} <button class="btn sm ghost" data-act="reloadEvents">Обновить</button></div>`
    : mode === 'snap' ? '<div class="banner">Показана сохранённая копия («Архив»).</div>' : '';
  box().innerHTML = note + list.map(x => { const it = mk('event', `${x.y}: ${x.e}`, 'Wikipedia');
    return `<div class="item"><p><span class="tag amber">${esc(x.y)}</span>${x.ad ? `<span class="tag">${esc(x.ad.split('-').reverse().join('.'))}</span>` : ''} ${esc(x.e)}</p>
      ${x.why ? `<p><b>Почему важно:</b> ${esc(x.why)}</p><p><b>Влияние на мир:</b> ${esc(x.impact)}</p>` : ''}
      ${x.ex ? `<p class="muted"><small>${esc(clip(x.ex, 240))}</small></p>` : ''}
      <div class="row">${actions(it)}${x.url ? `<a class="btn ghost sm" href="${esc(x.url)}" target="_blank" rel="noopener">Читать в Википедии</a>` : ''}</div></div>`; }).join('')
    + (mode !== 'archive' ? '<p class="muted"><small>Источник: Википедия («В этот день»). Объяснения «почему важно» здесь не сочиняются: читайте статью по ссылке.</small></p>' : '');
}

/* ----- Новости: RSS через rss2json → снимок ----- */
const FEEDS = [{ n: 'N+1', u: 'https://nplus1.ru/rss', take: 3 }, { n: 'Naked Science', u: 'https://naked-science.ru/feed', take: 2 }];
async function loadNews(date) {
  const box = () => $('#news-body'); let items = [], mode = 'live';
  if (dailyOk() && Array.isArray(DAILY.news) && DAILY.news.length) {
    if (!box()) return;
    box().innerHTML = DAILY.news.map(x => `<div class="item"><h3><a href="${esc(x.l)}" target="_blank" rel="noopener">${esc(x.t)}</a></h3><p>${esc(x.s)}</p>
      ${x.orig ? `<p class="meta muted"><small>Оригинал: ${esc(x.orig)}</small></p>` : ''}<p class="meta"><span class="tag">${esc(x.src)}</span><span class="tag">${esc(x.cat)}</span>${(x.tags || []).map(t => `<span class="tag amber">${esc(t)}</span>`).join('')}${x.tr ? `<span class="tag">перевод: ${esc(x.tr)}</span>` : ''}${x.lang === 'en' ? '<span class="tag">EN</span>' : ''}<small class="muted">рейтинг подборки: ${esc(x.score)}</small></p></div>`).join('')
      + '<p class="muted"><small>Подборка собрана автоматически из изданий и агентств и отранжирована по свежести, авторитету источника и совпадению тем в разных изданиях. Приоритет у новостей о России и об открытиях. Заголовок и анонс — из ленты издания; по политическим событиям сверяйтесь с несколькими источниками.</small></p>';
    return;
  }
  const res = await Promise.allSettled(FEEDS.map(f => fetchJSON('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(f.u))));
  res.forEach((r, i) => { if (r.status === 'fulfilled' && r.value.items) r.value.items.slice(0, FEEDS[i].take + 2).filter(x => passes(x.title || '')).slice(0, FEEDS[i].take).forEach(x =>
    items.push({ src: FEEDS[i].n, t: stripHtml(x.title), s: clip(stripHtml(x.description || x.content), 260), l: x.link, d: x.pubDate })); });
  if (items.length) snapSet(date, 'news', items);
  else { items = snapGet(date, 'news') || []; mode = items.length ? 'snap' : 'none'; }
  if (!box()) return;
  if (mode === 'none') { box().innerHTML = empty('📡', navigator.onLine ? 'Сегодня нет свежих данных. Не удалось загрузить новости.' : 'Нет соединения. Включи интернет — приложение загрузит программу дня.', '<button class="btn sm" data-act="reloadNews">Обновить</button>'); return; }
  box().innerHTML = (mode === 'snap' ? '<div class="banner">Показана сохранённая копия («Архив»). <button class="btn sm ghost" data-act="reloadNews">Обновить</button></div>' : '')
    + items.map(x => `<div class="item"><h3><a href="${esc(x.l)}" target="_blank" rel="noopener">${esc(x.t)}</a></h3>
      <p>${esc(x.s)}</p><p class="meta"><span class="tag">${esc(x.src)}</span>${x.d ? `<small class="muted">${esc(String(x.d).slice(0, 10))}</small>` : ''}</p></div>`).join('')
    + '<p class="muted"><small>Заголовок и суть — из анонса издания, без наших добавлений. «Почему важно» смотрите в оригинале.</small></p>';
}

/* ----- Библиотека промптов ----- */
let libCat = 'все';
function viewLibrary() {
  const cats = ['все', ...new Set(D.library.map(p => p.cat)), 'мои'];
  let h = `<h1>Библиотека промптов</h1><p class="muted">Готовые промпты: подставь свои данные вместо [в скобках]. Сейчас ${D.library.length} шт.; расширение до 50+ — в этапе 2.</p>
    <div class="chips" role="group" aria-label="Категории">${cats.map(c => `<button class="chip" data-act="cat" data-cat="${esc(c)}" aria-pressed="${c === libCat}">${esc(c)}</button>`).join('')}</div>`;
  if (libCat === 'мои') {
    h += S.myPrompts.length ? S.myPrompts.map((p, i) => { const it = mk('prompt', p.text, 'Мой промпт'); return `<div class="card"><p class="meta muted">${esc(p.date)}</p><pre class="prompt">${esc(p.text)}</pre><div class="row">${actions(it)}<button class="btn ghost sm" data-act="delMy" data-i="${i}">Удалить</button></div></div>`; }).join('')
      : `<div class="card">${empty('📝', 'Сохрани первый промпт — он появится здесь.', '<a class="btn sm" href="#/today" style="text-decoration:none" data-jump="prompt">К заданию дня</a>')}</div>`;
  } else {
    h += D.library.filter(p => libCat === 'все' || p.cat === libCat).map(p => { const it = mk('prompt', p.text, p.title);
      return `<div class="card"><h3>${esc(p.title)} <span class="tag">${esc(p.cat)}</span></h3><pre class="prompt">${esc(p.text)}</pre><div class="row">${actions(it)}<button class="btn sm" data-act="copy" data-id="${it.id}">Копировать</button></div></div>`; }).join('');
  }
  $('#view').innerHTML = h;
}

/* ----- Избранное ----- */
let favType = 'все';
const TYPES = { quote: 'Цитаты', joke: 'Юмор', event: 'События', prompt: 'Промпты', word: 'Слова', book: 'Книги', tip: 'Хитрости' };
function viewFav() {
  const list = S.fav.filter(f => favType === 'все' || f.type === favType);
  $('#view').innerHTML = `<h1>Избранное</h1><div class="chips" role="group" aria-label="Тип">${['все', ...Object.keys(TYPES)].map(t => `<button class="chip" data-act="favType" data-t="${t}" aria-pressed="${t === favType}">${t === 'все' ? 'Все' : TYPES[t]}</button>`).join('')}</div>`
    + (list.length ? list.map(f => { REG[f.id] = REG[f.id] || f; return `<div class="card"><span class="tag">${esc(TYPES[f.type] || f.type)}</span><p style="white-space:pre-wrap">${esc(f.text)}</p>${f.meta ? `<p class="meta muted"><small>${esc(f.meta)}</small></p>` : ''}<div class="row">${actions(f)}</div></div>`; }).join('')
      : `<div class="card">${empty('⭐', 'Пока пусто. Нажимай ☆ у цитат, шуток, событий и промптов — они появятся здесь.')}</div>`);
}

/* ----- Прогресс ----- */
function viewProgress() {
  const p = points(), li = levelOf(p), st = streakInfo(), next = LEVELS[li + 1];
  const daysCount = Object.keys(S.days).filter(k => Object.keys(S.days[k].done).length).length;
  const cnt = {}; Object.values(S.days).forEach(r => Object.keys(r.done).forEach(k => cnt[k] = (cnt[k] || 0) + 1));
  const fav = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${(SECTIONS.find(s => s.id === k) || {}).t} (${v})`).join(', ') || 'пока нет данных';
  const avg = S.stats.sessions ? Math.round(S.stats.totalSec / S.stats.sessions / 60 * 10) / 10 : 0;
  const week = []; for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const k = dstr(d); week.push({ k, n: S.days[k] ? Object.keys(S.days[k].done).length : 0, l: d.toLocaleDateString('ru-RU', { weekday: 'short' }) }); }
  $('#view').innerHTML = `<h1>Прогресс</h1>
    <div class="card"><h2>Уровень: ${LEVELS[li][0]}</h2><p class="muted">${next ? `До уровня «${next[0]}» осталось ${next[1] - p} б.` : 'Максимальный уровень достигнут.'}</p>
      <div class="stats"><div class="stat"><b>${p}</b>баллов</div><div class="stat"><b>${st.cur}</b>серия, дней</div><div class="stat"><b>${st.best}</b>лучшая серия</div><div class="stat"><b>${daysCount}</b>дней в программе</div></div></div>
    <div class="card"><h2>Последние 7 дней</h2><div class="week" role="img" aria-label="Разделов по дням">${week.map(w => `<div title="${w.k}: ${w.n}"><i style="height:${Math.round(w.n / SECTIONS.length * 100)}%"></i></div>`).join('')}</div>
      <div class="row" style="justify-content:space-between">${week.map(w => `<small class="muted">${w.l}</small>`).join('')}</div></div>
    <div class="card"><h2>Аналитика</h2><p>Любимые разделы: ${esc(fav)}</p><p>Средняя сессия: ${avg} мин.</p><p class="muted"><small>Аналитика хранится только на этом устройстве.</small></p></div>
    <div class="card"><h2>Достижения</h2>${achievements().map(a => `<div class="badge ${a.ok ? 'on' : ''}"><span aria-hidden="true">${a.ok ? '🏆' : '🔒'}</span><div><b>${a.t}</b><br><small class="muted">${a.d}</small></div></div>`).join('')}</div>`;
}

/* ----- Настройки ----- */
let deferredInstall = null;
function viewSettings() {
  const link = location.origin + location.pathname + '?ref=' + S.uid;
  $('#view').innerHTML = `<h1>Настройки</h1>
    <div class="card"><h2>Профиль</h2><label class="f" for="setName">Имя (необязательно)</label><input class="input" id="setName" value="${esc(S.name)}" autocomplete="given-name">
      <label class="f" for="setTime">Время напоминания</label><input class="input" type="time" id="setTime" value="${esc(S.time)}">
      <label class="f" for="setFont">Размер шрифта: <span id="fontVal">${S.font}</span>%</label><input type="range" id="setFont" min="85" max="140" step="5" value="${S.font}" style="width:100%">
      <label class="f" for="setTheme">Тема</label><select class="input" id="setTheme"><option value="dark" ${S.theme === 'dark' ? 'selected' : ''}>Тёмная</option><option value="light" ${S.theme === 'light' ? 'selected' : ''}>Светлая</option></select>
      <label class="f" for="setLang">Язык</label><select class="input" id="setLang" disabled><option>Русский</option><option>English (скоро, этап 3)</option></select></div>
    <div class="card"><h2>Уведомления</h2><p>${S.notify ? '✅ Разрешены.' : 'Не включены.'} Напоминание «Твоя программа дня готова» показывается, когда приложение открыто. Для напоминаний при закрытом приложении нужен сервер (Firebase или MAX-бот) — он не входит в этап 1.</p>
      <div class="row"><button class="btn sm" data-act="enableNotif">Включить уведомления</button><button class="btn ghost sm" data-act="testNotif">Проверить</button></div></div>
    <div class="card"><h2>Установка на телефон</h2><p>Android/Chrome: меню ⋮ → «Установить приложение». iPhone/Safari: «Поделиться» → «На экран “Домой”».</p>
      <button class="btn sm" data-act="install" ${deferredInstall ? '' : 'hidden'}>Установить приложение</button></div>
    <div class="card"><h2>Друзья и бот</h2><p>Твоя ссылка-вызов (случайный код, без личных данных):</p><pre class="prompt">${esc(link)}</pre>
      <div class="row"><button class="btn sm" data-act="challenge">Скопировать ссылку</button><button class="btn ghost sm" data-act="maxbot">Подключить MAX-бота</button></div></div>
    <div class="card"><h2>Данные</h2><p>Резервная копия хранится в файле. Ничего не отправляется на сервер.</p>
      <div class="row"><button class="btn sm" data-act="export">Экспорт данных</button><button class="btn ghost sm" data-act="import">Импорт</button><button class="btn ghost sm" data-act="reset">Стереть всё</button></div></div>
    <div class="card"><h2>Поддержать проект</h2><p class="muted">Ссылки появятся, когда вы укажете их в CFG (app.js).</p><div class="row">${Object.entries(CFG.DONATE).filter(([, v]) => v).map(([k, v]) => `<a class="btn ghost sm" href="${esc(v)}" target="_blank" rel="noopener">${esc(k)}</a>`).join('') || '<small class="muted">Пока не настроено.</small>'}</div>
      <p class="muted"><small>Премиум-функции (PDF без рекламы, 500+ промптов) заложены архитектурно, но требуют сервера — в этапе 1 не активны.</small></p></div>
    <div class="card"><h2>Источники данных</h2><ul class="clean"><li>События: Википедия (ru), REST API «On this day»</li><li>Новости: RSS N+1 и Naked Science через rss2json.com</li><li>Ежедневная подборка (daily.json): ${DAILY && DAILY.date ? esc(DAILY.date) + ', источников без ошибок: ' + Object.values(DAILY.sources || {}).filter(v => v === 'ok').length + ' из ' + Object.keys(DAILY.sources || {}).length : 'ещё не создана'}</li><li>Запасная база в data.js (если подборки нет)</li></ul>
      <p class="muted"><small>Если внешний источник не отвечает 8 секунд, показывается сохранённая копия или архив.</small></p></div>`;
}

/* ----- Поиск по всему локальному контенту ----- */
function viewSearch() {
  const q = searchQ.trim().toLowerCase(); const out = [];
  const add = (type, text, meta) => { if (text.toLowerCase().includes(q)) out.push(mk(type, text, meta)); };
  D.quotes.forEach(x => add('quote', `«${x.t}» — ${x.a}${x.dis ? ' (приписывается)' : ''}`, x.src));
  D.jokes.concat(D.stories).forEach(x => add('joke', x.t, kindLab(x.kind)));
  D.library.forEach(x => add('prompt', x.text, x.title)); S.myPrompts.forEach(x => add('prompt', x.text, 'Мой промпт'));
  D.words.forEach(x => add('word', `${x.w} — ${x.m}`, x.src)); D.history.forEach(x => add('event', `${x.y}: ${x.e}`, 'Архив'));
  D.tips.forEach(x => add('tip', x, 'Хитрость')); D.books.forEach(x => add('book', `${x.t} — ${x.a}`, 'Книга'));
  $('#view').innerHTML = `<h1>Поиск: «${esc(searchQ)}»</h1>` + (out.length ? out.slice(0, 40).map(f => `<div class="card"><span class="tag">${esc(TYPES[f.type] || f.type)}</span><p style="white-space:pre-wrap">${esc(f.text)}</p><p class="meta muted"><small>${esc(f.meta)}</small></p><div class="row">${actions(f)}</div></div>`).join('') : `<div class="card">${empty('🔍', 'Ничего не найдено. Попробуй другое слово.')}</div>`);
}

/* =====================================================================
   МАРШРУТИЗАЦИЯ И НАВИГАЦИЯ
   ===================================================================== */
function currentRoute() { const r = (location.hash || '#/today').replace(/^#\//, '').split('?')[0]; return ROUTES.some(x => x[0] === r) || r === 'search' ? r : 'today'; }
function renderNav(r) {
  const tab = ROUTES.map(([id, t, ic]) => `<a href="#/${id}" ${r === id ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${t}</a>`).join('');
  $('#tabbar').innerHTML = tab;
  $('#side').innerHTML = `<div class="brand-side">Ближе к людям<div class="muted" style="font-size:.72rem;font-weight:400;line-height:1.3;margin-top:2px">Говори. Узнавай. Расти.</div></div>${tab.replace(/<span class="ic"/g, '<span class="ic"')}
    <div class="grp">Разделы дня</div>${SECTIONS.map((s, i) => `<a href="#/today" data-jump="${s.id}"><span class="ic" aria-hidden="true" style="width:1.4em;text-align:center;font-size:.8rem">${i + 1}</span>${s.t}</a>`).join('')}`;
}
function render() {
  const r = currentRoute(); renderNav(r);
  ({ today: viewToday, library: viewLibrary, fav: viewFav, progress: viewProgress, settings: viewSettings, search: viewSearch }[r])();
  scrollTo(0, 0);
}
function jump(id) {
  const go = () => { const el = $('#s-' + id); if (el) { el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); const h = el.querySelector('h2'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } } };
  if (currentRoute() !== 'today') { location.hash = '#/today'; setTimeout(go, 60); } else go();
}

/* =====================================================================
   СОБЫТИЯ
   ===================================================================== */
document.addEventListener('click', async e => {
  const jumpEl = e.target.closest('[data-jump]'); if (jumpEl) { e.preventDefault(); jump(jumpEl.dataset.jump); return; }
  const b = e.target.closest('[data-act]'); if (!b) return; const a = b.dataset.act, id = b.dataset.id;
  switch (a) {
    case 'fav': { const it = REG[id] || S.fav.find(f => f.id === id); if (!it) break;
      if (isFav(id)) S.fav = S.fav.filter(f => f.id !== id); else S.fav.unshift({ id: it.id, type: it.type, text: it.text, meta: it.meta, ts: Date.now() });
      save(); $$(`[data-act="fav"][data-id="${id}"]`).forEach(x => { x.setAttribute('aria-pressed', isFav(id)); x.textContent = isFav(id) ? '★' : '☆'; });
      if (currentRoute() === 'fav') viewFav(); checkAch(); break; }
    case 'copy': { const it = REG[id]; if (it) copyText(it.text); break; }
    case 'share': { const it = REG[id]; if (it) shareCard(it.text, 'Ближе к людям'); break; }
    case 'shareDay': { const q = pick(D.quotes, 1)[0]; shareCard(`«${q.t}»${q.dis ? ' (приписывается)' : ''}`, q.a); break; }
    case 'challenge': copyText(location.origin + location.pathname + '?ref=' + S.uid + '&day=' + dstr()); break;
    case 'print': window.print(); break;
    case 'savePrompt': { const v = ($('#taskText') || {}).value || ''; if (!v.trim()) { toast('Напиши промпт — тогда его можно сохранить'); break; }
      S.myPrompts.unshift({ text: v.trim(), date: dstr() }); save(); toast('Сохранено в коллекцию'); checkAch(); break; }
    case 'delMy': S.myPrompts.splice(+b.dataset.i, 1); save(); viewLibrary(); break;
    case 'cat': libCat = b.dataset.cat; viewLibrary(); break;
    case 'favType': favType = b.dataset.t; viewFav(); break;
    case 'reloadEvents': $('#ev-body').innerHTML = skel(); loadEvents(viewDate); break;
    case 'reloadNews': $('#news-body').innerHTML = skel(); loadNews(viewDate); break;
    case 'today': e.preventDefault(); viewDate = dstr(); history.replaceState(null, '', location.pathname + '#/today'); render(); break;
    case 'closeDlg': $('#dlg').close(); break;
    case 'enableNotif': if (await enableNotif()) { toast('Уведомления включены'); viewSettings(); } break;
    case 'testNotif': showNotif('Ближе к людям', 'Твоя программа дня готова'); break;
    case 'install': if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; b.hidden = true; } break;
    case 'maxbot': CFG.MAX_BOT_URL ? window.open(CFG.MAX_BOT_URL, '_blank', 'noopener') : toast('Ссылка на бота не задана: укажите MAX_BOT_URL в app.js'); break;
    case 'export': { const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' }); const u = URL.createObjectURL(blob);
      const l = document.createElement('a'); l.href = u; l.download = `gd-backup-${dstr()}.json`; l.click(); setTimeout(() => URL.revokeObjectURL(u), 2000); break; }
    case 'import': $('#importFile').click(); break;
    case 'reset': if (confirm('Стереть весь прогресс, заметки и избранное на этом устройстве?')) { localStorage.removeItem(KEY); location.hash = ''; location.reload(); } break;
    case 'luckyAgain': lucky(); break;
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.sec) { const rec = dayRec(viewDate); t.checked ? rec.done[t.dataset.sec] = 1 : delete rec.done[t.dataset.sec];
    save(); t.closest('.card').classList.toggle('done', t.checked); updateProgress(); checkAch();
    const r = streakInfo(); if (t.checked && Object.keys(rec.done).length === 1 && r.cur > 1) toast(`🔥 Ты занимаешься ${r.cur} ${plural(r.cur, 'день', 'дня', 'дней')} подряд!`); }
  if (t.id === 'setTime') { S.time = t.value || '09:00'; save(); }
  if (t.id === 'setTheme') { S.theme = t.value; applyTheme(); save(); }
  if (t.id === 'importFile' && t.files[0]) { t.files[0].text().then(txt => { try { const j = JSON.parse(txt); if (j.v !== 1) throw 0; S = Object.assign(defaults(), j); save(); toast('Данные восстановлены'); render(); } catch (_) { toast('Файл не подходит: нужна резервная копия этого приложения'); } }); t.value = ''; }
});
let noteT;
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.note !== undefined) { clearTimeout(noteT); noteT = setTimeout(() => { dayRec(viewDate).notes[t.dataset.note] = t.value; save(); }, 400); }
  if (t.id === 'taskText') { clearTimeout(noteT); noteT = setTimeout(() => { dayRec(viewDate).task = t.value; save(); }, 400); }
  if (t.id === 'setName') { S.name = t.value.trim().slice(0, 40); save(); }
  if (t.id === 'setFont') { S.font = +t.value; $('#fontVal').textContent = S.font; applyFont(); save(); }
  if (t.id === 'q') { searchQ = t.value; if (searchQ.trim()) { if (currentRoute() !== 'search') { sessionStorage.setItem('gd:back', location.hash || '#/today'); location.hash = '#/search'; } else render(); } else if (currentRoute() === 'search') location.hash = sessionStorage.getItem('gd:back') || '#/today'; }
});
window.addEventListener('hashchange', () => { if (currentRoute() !== 'search' && $('#q').value) { $('#q').value = ''; searchQ = ''; } render(); });
$('#themeBtn').addEventListener('click', () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; applyTheme(); save(); });
$('#lucky').addEventListener('click', () => lucky());
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#dlg').open) $('#dlg').close(); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });

/* «Мне повезло»: случайный анекдот, цитата или промпт */
function lucky() {
  const pools = [['joke', D.jokes.filter(j => passes(j.t)).map(j => ({ t: j.t, m: kindLab(j.kind) }))],
    ['quote', D.quotes.map(q => ({ t: `«${q.t}» — ${q.a}${q.dis ? ' (приписывается)' : ''}`, m: q.src }))],
    ['prompt', D.library.map(p => ({ t: p.text, m: p.title }))]];
  const [type, arr] = pools[Math.floor(Math.random() * pools.length)]; const x = arr[Math.floor(Math.random() * arr.length)]; const it = mk(type, x.t, x.m);
  openDlg(`<h2>🎲 Мне повезло</h2><span class="tag">${TYPES[type]}</span><p style="white-space:pre-wrap">${esc(x.t)}</p><p class="muted"><small>${esc(x.m)}</small></p><div class="row">${actions(it)}<button class="btn sm" data-act="luckyAgain">Ещё</button></div>`);
}

/* Карточка для соцсетей: canvas → PNG → Web Share или скачивание */
function shareCard(text, author) {
  const c = document.createElement('canvas'); c.width = 1080; c.height = 1350; const g = c.getContext('2d');
  g.fillStyle = '#0F0F12'; g.fillRect(0, 0, 1080, 1350);
  const gr = g.createLinearGradient(0, 0, 1080, 0); gr.addColorStop(0, '#F5A623'); gr.addColorStop(1, '#2ECC71'); g.fillStyle = gr; g.fillRect(90, 140, 140, 8);
  g.fillStyle = '#ECECF1'; g.font = '600 56px Inter, -apple-system, "Segoe UI", Arial, sans-serif'; g.textBaseline = 'top';
  const words = text.split(' '); let line = '', y = 220; const lines = [];
  words.forEach(w => { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > 900 && line) { lines.push(line); line = w; } else line = t; }); lines.push(line);
  lines.slice(0, 14).forEach(l => { g.fillText(l, 90, y); y += 76; });
  g.fillStyle = '#F5A623'; g.font = '500 40px Inter, Arial, sans-serif'; g.fillText(author, 90, Math.min(y + 40, 1100));
  g.fillStyle = '#A3A3B1'; g.font = '400 32px Inter, Arial, sans-serif'; g.fillText('Ближе к людям · ' + parseD(viewDate).toLocaleDateString('ru-RU'), 90, 1230);
  c.toBlob(async blob => {
    if (!blob) { toast('Не удалось создать картинку'); return; }
    const f = new File([blob], 'blizhe-k-lyudyam.png', { type: 'image/png' });
    try { if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], text: 'Ближе к людям' }); return; } } catch (err) { if (err && err.name === 'AbortError') return; }
    const u = URL.createObjectURL(blob); const l = document.createElement('a'); l.href = u; l.download = f.name; l.click(); setTimeout(() => URL.revokeObjectURL(u), 2000); toast('Картинка сохранена');
  }, 'image/png');
}

/* =====================================================================
   ТЕМА, ШРИФТ, УВЕДОМЛЕНИЯ
   ===================================================================== */
function applyTheme() { document.documentElement.dataset.theme = S.theme; const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = S.theme === 'dark' ? '#0F0F12' : '#F7F7F4'; }
function applyFont() { document.documentElement.style.setProperty('--fs', S.font); }
async function enableNotif() {
  if (!('Notification' in window)) { toast('Уведомления не поддерживаются на этом устройстве'); return false; }
  try { S.notify = (await Notification.requestPermission()) === 'granted'; } catch (e) { S.notify = false; } save(); return S.notify;
}
async function showNotif(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') { toast('Сначала включите уведомления'); return; }
  try { const reg = await navigator.serviceWorker.ready; reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'daily' }); }
  catch (e) { try { new Notification(title, { body }); } catch (_) {} }
}
function scheduleReminder() {
  if (!S.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (localStorage.getItem('gd:notified') === dstr()) return;
  const [hh, mm] = S.time.split(':').map(Number); const t = new Date(); t.setHours(hh, mm, 0, 0); const wait = t - new Date();
  const fire = () => { localStorage.setItem('gd:notified', dstr()); showNotif('Ближе к людям', 'Твоя программа дня готова'); };
  if (wait <= 0) fire(); else if (wait < 864e5) setTimeout(fire, wait);
}

/* =====================================================================
   ОНБОРДИНГ (4 экрана)
   ===================================================================== */
function onboarding() {
  const box = $('#onb'); box.hidden = false; let step = 0; const draft = { name: S.name, time: S.time, theme: S.theme };
  const screens = [
    () => `<h1>Ближе к людям</h1><p class="quote" style="color:var(--amber)">Говори. Узнавай. Расти.</p><p>Это твой ежедневник на 25–30 минут. Каждый день: секреты коммуникации, открытия, цитаты, юмор, промпт-инжиниринг и ещё 8 разделов.</p>`,
    () => `<h1>Что получишь за месяц</h1><p>Ты будешь говорить увереннее, знать больше и создавать промпты уровня эксперта. Главное — регулярность, а не героизм.</p>`,
    () => `<h1>Настрой под себя</h1>
      <label class="f" for="oName">Имя (необязательно)</label><input class="input" id="oName" value="${esc(draft.name)}" autocomplete="given-name">
      <label class="f" for="oTime">Время напоминания</label><input class="input" type="time" id="oTime" value="${esc(draft.time)}">
      <label class="f" for="oTheme">Тема</label><select class="input" id="oTheme"><option value="dark" ${draft.theme === 'dark' ? 'selected' : ''}>Тёмная</option><option value="light" ${draft.theme === 'light' ? 'selected' : ''}>Светлая</option></select>
      <label class="f" for="oLang">Язык</label><select class="input" id="oLang" disabled><option>Русский</option><option>English (скоро)</option></select>`,
    () => `<h1>Напоминания</h1><p>Разрешить уведомления? Приложение напомнит о программе дня. Можно пропустить и включить позже в настройках.</p>
      <div class="row"><button class="btn" id="oNotif">Разрешить</button></div>`
  ];
  function paint() {
    box.innerHTML = `<div class="box"><div class="dots" aria-hidden="true">${screens.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>
      <div>${screens[step]()}</div><div class="row" style="margin-top:22px">
      ${step > 0 ? '<button class="btn ghost" id="oBack">Назад</button>' : ''}
      <button class="btn" id="oNext">${step === 3 ? 'Начать' : 'Далее'}</button></div></div>`;
    const f = box.querySelector('input,button.btn'); if (f) f.focus();
    const n = $('#oName'); if (n) { n.oninput = () => draft.name = n.value.trim().slice(0, 40); $('#oTime').onchange = ev => draft.time = ev.target.value || '09:00'; $('#oTheme').onchange = ev => { draft.theme = ev.target.value; S.theme = draft.theme; applyTheme(); }; }
    const nb = $('#oNotif'); if (nb) nb.onclick = async () => { const ok = await enableNotif(); nb.textContent = ok ? 'Разрешено ✓' : 'Не разрешено (можно позже)'; nb.disabled = true; };
    $('#oNext').onclick = () => { if (step < 3) { step++; paint(); } else { S.name = draft.name; S.time = draft.time; S.theme = draft.theme; S.onboarded = true; save(); box.hidden = true; applyTheme(); render(); scheduleReminder(); } };
    const bb = $('#oBack'); if (bb) bb.onclick = () => { step--; paint(); };
  }
  paint();
}

/* =====================================================================
   ЗАПУСК
   ===================================================================== */
(function init() {
  /* Параметры ссылки: ?ref=USER_ID&day=YYYY-MM-DD (только безопасные значения) */
  const p = new URLSearchParams(location.search);
  const ref = p.get('ref'), day = p.get('day');
  if (ref && /^[0-9a-zA-Z-]{8,40}$/.test(ref) && ref !== S.uid) S.friend = ref;
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && !isNaN(parseD(day))) viewDate = day;
  applyTheme(); applyFont();
  S.stats.sessions++; save();
  let lastTick = Date.now();
  const flush = () => { S.stats.totalSec += Math.round((Date.now() - lastTick) / 1000); lastTick = Date.now(); save(); };
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); else lastTick = Date.now(); });
  if (!location.hash) history.replaceState(null, '', location.pathname + location.search + '#/today');
  render();
  fetchDaily();
  if (!S.onboarded) onboarding(); else scheduleReminder();
  /* Service Worker: офлайн-режим (работает только по https или localhost) */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('service-worker.js').catch(() => {});
  /* Ошибки не ломают интерфейс */
  addEventListener('unhandledrejection', e => { e.preventDefault(); console.warn('Необработанная ошибка:', e.reason); });
})();
})();
