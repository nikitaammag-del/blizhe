#!/usr/bin/env node
/* =====================================================================
   tools/build-daily.mjs — ежедневный сборщик контента «Ближе к людям»
   Запускается по расписанию (GitHub Actions) без зависимостей, Node 20+.
   Что делает: собирает кандидатов из открытых источников, считает ПРОЗРАЧНЫЙ
   рейтинг (формулы ниже), выбирает лучшее и пишет daily.json + archive/ДАТА.json.

   ПРАВИЛА:
   • Цитаты, факты, слова, книги, фильмы — только из источников, ничего не сочиняется.
   • Нейросеть (GigaChat или, запасной вариант, Claude) используется ТОЛЬКО для шуток
     и перевода промптов. К цитатам и фактам она не прикасается.
   • Любой упавший источник не ломает сборку: он помечается в sources.
   ===================================================================== */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = process.env.BUILD_DATE || new Date().toISOString().slice(0, 10);
const DAYNUM = Math.floor(Date.parse(TODAY + 'T00:00:00Z') / 864e5);
const GIGA = process.env.GIGACHAT_AUTH_KEY || '';      // «Ключ авторизации» из личного кабинета GigaChat (Studio)
const KEY = process.env.ANTHROPIC_API_KEY || '';       // запасной вариант
const HAS_LLM = !!(GIGA || KEY);                       // есть ли хоть какая-то нейросеть
const LLM_NAME = GIGA ? 'GigaChat' : KEY ? 'Claude' : '';
const TMDB = process.env.TMDB_API_KEY || '';
const report = {};

/* ---------- Общие помощники ---------- */
const UA = 'blizhe-k-lyudyam/1.0 (daily digest; open sources)';
const http = (u, o = {}) => fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, Accept: '*/*' }, ...o });
const getJSON = async u => { const r = await http(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
const getText = async u => { const r = await http(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); };
async function step(name, fn, fallback) { try { const v = await fn(); report[name] = 'ok'; return v; } catch (e) { report[name] = 'fail: ' + (e && e.message || e); return fallback; } }
const rot = (arr, n, salt = 0) => Array.from({ length: Math.min(n, arr.length) }, (_, i) => arr[(DAYNUM * n + salt + i) % arr.length]);
const clip = (s, n) => s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…';
const norm = s => s.toLowerCase().replace(/[^a-zа-яё0-9]+/g, ' ').trim();
const STOP = ['секс', 'порно', 'чёрн', 'негр', 'жид', 'хач', 'политик', 'путин', 'трамп', 'террор', 'суицид', 'убий', 'изнасил', 'война', 'выборы'];
const clean = t => !STOP.some(w => t.toLowerCase().includes(w));
/* Отпечаток текста: по нему не повторяем шутки, сами тексты чужих анекдотов в archive/ не храним */
const jh = t => { const x = norm(t); let h = 5381; for (let i = 0; i < x.length; i++) h = ((h << 5) + h + x.charCodeAt(i)) | 0; return 'j' + (h >>> 0).toString(36); };
/* Приоритетные темы (ваш выбор): Россия, научные факты, Архимед, Ньютон, открытия, радио, ИИ */
const TOPIC = /росси|российск|архимед|ньютон|открыт|радио|попов|искусственн\w* интеллект|нейросет|(^|[^а-яё])ии([^а-яё]|$)|artificial intelligence|\bAI\b|russia|discover|newton|archimedes|radio/i;
/* Чтение ленты с определением кодировки (старые сайты отдают windows-1251) */
async function getTextAuto(u) {
  const r = await http(u); if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  const m = (r.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || new TextDecoder('latin1').decode(buf.slice(0, 300)).match(/encoding=["']([\w-]+)["']/i);
  try { return new TextDecoder(((m && m[1]) || 'utf-8').toLowerCase()).decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
}
const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&mdash;/g, '—');
const strip = h => decode((h || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/* Что уже публиковали за последние 30 дней — не повторяем */
async function loadSeen() {
  const seen = new Set();
  try {
    const dir = path.join(ROOT, 'archive'); const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json') && f < TODAY + '.json').sort().slice(-30);
    for (const f of files) { const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      [...(j.quotes || []), ...(j.prompts || [])].forEach(x => seen.add(norm(x.t || x.text || ''))); [...(j.jokes || []), ...(j.stories || [])].forEach(x => seen.add(x.h || jh(x.t || ''))); (j.words || []).forEach(x => seen.add(norm(x.w))); (j.books || []).forEach(x => seen.add(norm(x.t))); }
  } catch (e) { /* архива ещё нет */ }
  return seen;
}

/* =====================================================================
   1. ЦИТАТЫ — Викицитатник (ru). Рейтинг: есть источник (+3), длина 40–200 (+2),
      не из раздела «Приписываемые/Спорные» (+1). Без источника → «приписывается».
   ===================================================================== */
const AUTHORS = ['Альберт Эйнштейн', 'Лев Толстой', 'Антон Чехов', 'Александр Пушкин', 'Фёдор Достоевский', 'Михаил Булгаков', 'Иван Тургенев', 'Николай Гоголь',
  'Михаил Лермонтов', 'Максим Горький', 'Владимир Набоков', 'Ричард Фейнман', 'Исаак Ньютон', 'Стивен Хокинг', 'Карл Саган', 'Никола Тесла', 'Мария Кюри', 'Чарльз Дарвин',
  'Галилео Галилей', 'Дмитрий Менделеев', 'Михаил Ломоносов', 'Сократ', 'Платон', 'Аристотель', 'Марк Аврелий', 'Луций Анней Сенека', 'Эпиктет', 'Конфуций', 'Лао-цзы',
  'Фрэнсис Бэкон', 'Рене Декарт', 'Иммануил Кант', 'Артур Шопенгауэр', 'Фридрих Ницше', 'Иоганн Вольфганг Гёте', 'Уильям Шекспир', 'Виктор Гюго', 'Оноре де Бальзак', 'Антуан де Сент-Экзюпери',
  'Марк Твен', 'Эрнест Хемингуэй', 'Оскар Уайльд', 'Джордж Бернард Шоу', 'Бертран Рассел', 'Стив Джобс', 'Дейл Карнеги', 'Леонардо да Винчи', 'Виктор Франкл', 'Станислав Ежи Лец', 'Фаина Раневская'];
const PRIORITY_AUTHORS = ['Архимед', 'Исаак Ньютон', 'Дмитрий Менделеев', 'Михаил Ломоносов', 'Константин Циолковский', 'Иван Павлов', 'Сергей Королёв', 'Алан Тьюринг', 'Никола Тесла', 'Альберт Эйнштейн', 'Ричард Фейнман', 'Карл Саган'];
const SKIP_SEC = /^(о |об |об\b|цитаты о|высказывания о|ссылки|примечани|см\.|источники|литература|внешние)/i;
const DIS_SEC = /припис|спорн|недостоверн|ошибочн|сомнител/i;
const dropTpl = t => { let p; do { p = t; t = t.replace(/\{\{[^{}]*\}\}/g, ''); } while (t !== p); return t.replace(/\{\{|\}\}/g, ''); };
const wikiClean = t => decode(dropTpl(t.replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^>]*\/>/g, '')).replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1').replace(/'''?/g, '').replace(/<[^>]+>/g, '').replace(/\[https?:\/\/\S+\s*([^\]]*)\]/g, '$1')).replace(/\s+/g, ' ').trim();
export function parseWikiquote(wt, author) {
  const out = []; const lines = wt.split('\n'); let sec = '', skip = false, dis = false;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(={2,})\s*(.+?)\s*\1\s*$/);
    if (h) { sec = wikiClean(h[2]); skip = SKIP_SEC.test(sec); dis = DIS_SEC.test(sec); continue; }
    const m = lines[i].match(/^\*\s+([^*].*)$/); if (!m || skip) continue;
    const text = wikiClean(m[1]).replace(/^[—–-]\s*/, '').replace(/^[«"]|[»"]$/g, '').trim();
    let src = '', j = i + 1; while (lines[j] && /^\*\*/.test(lines[j])) { const s = wikiClean(lines[j].replace(/^\*+\s*/, '')); if (s) src += (src ? '; ' : '') + s; j++; }
    if (text.length < 30 || text.length > 220 || !clean(text)) continue;
    const score = (src ? 3 : 0) + (text.length >= 40 && text.length <= 200 ? 2 : 0) + (dis ? 0 : 1) - (/^[—–-]\s/.test(wikiClean(m[1])) ? 4 : 0); // реплики диалога без контекста — в конец
    out.push({ a: author, t: text, src: src ? clip(src, 160) : '', dis: dis || !src, score });
  }
  return out;
}
async function buildQuotes(seen) {
  const cands = [];
  for (const name of [...rot(PRIORITY_AUTHORS, 4), ...rot(AUTHORS, 4)]) {
    try {
      const j = await getJSON(`https://ru.wikiquote.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(name)}`);
      const wt = j.query.pages[0].revisions[0].slots.main.content;
      const url = 'https://ru.wikiquote.org/wiki/' + encodeURIComponent(name.replace(/ /g, '_'));
      parseWikiquote(wt, name).forEach(q => cands.push({ ...q, score: q.score + (PRIORITY_AUTHORS.includes(name) ? 1 : 0), url, src: 'Викицитатник (CC BY-SA 4.0)' + (q.src ? ': ' + q.src : ': источник не указан') }));
    } catch (e) { /* автор не найден — пропускаем */ }
  }
  if (!cands.length) throw new Error('нет кандидатов');
  const used = new Set(); const out = [];
  cands.filter(q => !seen.has(norm(q.t))).sort((a, b) => b.score - a.score || a.t.localeCompare(b.t)).forEach(q => { if (out.length < 4 && !used.has(q.a)) { used.add(q.a); out.push(q); } });
  return out;
}

/* =====================================================================
   2. НОВОСТИ — RSS-ленты. «Самое интересное в мире», но с приоритетом на Россию и открытия. Квот нет: один общий рейтинг.
      Рейтинг = вес источника + свежесть (0..3) + 1,5 за каждое совпадение темы в другом издании (макс. 2)
                + 3, если новость про Россию, + 3, если про открытия, изобретения, науку и гениев (Архимед, Ньютон, Менделеев,
                Попов, радио, ИИ и т. п.), + 1, если оба сразу, − 1,5 за кричащий заголовок («шок», «сенсация»).
      Отбор: 6 лучших, не больше 2 из одного издания, одну историю из нескольких изданий показываем один раз.
      Политика допускается (ваше решение). Отсекаем только откровенное, оскорбления по национальности и темы самоубийств.
   ===================================================================== */
const FEEDS = [
  /* Наука и технологии */
  { n: 'N+1', u: 'https://nplus1.ru/rss', cat: 'наука', w: 1, lang: 'ru' }, { n: 'Naked Science', u: 'https://naked-science.ru/feed', cat: 'наука', w: 0.9, lang: 'ru' },
  { n: 'Элементы', u: 'https://elementy.ru/rss/news', cat: 'наука', w: 0.9, lang: 'ru' }, { n: 'Хабр', u: 'https://habr.com/ru/rss/news/?fl=ru', cat: 'технологии', w: 0.7, lang: 'ru' },
  { n: 'Nature', u: 'https://www.nature.com/nature.rss', cat: 'наука', w: 1.2, lang: 'en' }, { n: 'Science News', u: 'https://www.science.org/rss/news_current.xml', cat: 'наука', w: 1.2, lang: 'en' },
  { n: 'BBC Science', u: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', cat: 'наука', w: 1, lang: 'en' }, { n: 'Ars Technica', u: 'https://feeds.arstechnica.com/arstechnica/index', cat: 'технологии', w: 0.9, lang: 'en' },
  /* Культура и спорт */
  { n: 'The Guardian Culture', u: 'https://www.theguardian.com/culture/rss', cat: 'культура', w: 0.8, lang: 'en' }, { n: 'BBC Sport', u: 'https://feeds.bbci.co.uk/sport/rss.xml', cat: 'спорт', w: 0.7, lang: 'en' },
  /* Россия: общие ленты новостных агентств и изданий (политика допускается) */
  { n: 'ТАСС', u: 'https://tass.ru/rss/v2.xml', cat: 'новости', w: 1, lang: 'ru', big: true }, { n: 'РИА Новости', u: 'https://ria.ru/export/rss2/archive/index.xml', cat: 'новости', w: 0.9, lang: 'ru', big: true },
  { n: 'Интерфакс', u: 'https://www.interfax.ru/rss.asp', cat: 'новости', w: 1, lang: 'ru', big: true }, { n: 'Коммерсантъ', u: 'https://www.kommersant.ru/RSS/news.xml', cat: 'новости', w: 1, lang: 'ru', big: true },
  { n: 'РБК', u: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss', cat: 'новости', w: 0.9, lang: 'ru', big: true }, { n: 'Lenta.ru', u: 'https://lenta.ru/rss/news', cat: 'новости', w: 0.7, lang: 'ru', big: true },
  /* Мир */
  { n: 'BBC World', u: 'https://feeds.bbci.co.uk/news/world/rss.xml', cat: 'мир', w: 1.2, lang: 'en', big: true }, { n: 'The Guardian World', u: 'https://www.theguardian.com/world/rss', cat: 'мир', w: 1, lang: 'en', big: true },
  { n: 'Al Jazeera', u: 'https://www.aljazeera.com/xml/rss/all.xml', cat: 'мир', w: 0.9, lang: 'en', big: true }
];
export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)) {
    const b = m[0]; const g = tag => { const r = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')); return r ? r[1] : ''; };
    const link = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || strip(g('link'));
    items.push({ title: strip(g('title')), link: (link || '').trim(), desc: strip(g('description') || g('summary') || g('content')), html: g('description') || g('summary') || g('content'), date: strip(g('pubDate') || g('published') || g('updated') || g('dc:date')) });
  }
  return items;
}
const toks = t => new Set(norm(t).split(' ').filter(w => w.length > 4).map(w => w.slice(0, 5)));
const RUSSIA = /росси|(^|[^а-яё])рф([^а-яё]|$)|москв|кремл|russia|moscow|kremlin/i;
const DISCOVERY = /открыт|изобрет|учён|ученые|архимед|ньютон|менделеев|попов|радио|искусственн\w* интеллект|нейросет|(^|[^а-яё])ии([^а-яё]|$)|прорыв|breakthrough|discover|invent|scientist|newton|archimedes|artificial intelligence|\bAI\b/i;
const CLICKBAIT = /(^|[^а-яё])шок|сенсаци|не поверите|won't believe|you won.t believe/i;
/* Для новостей допускаем политику и ЧП, отсекаем откровенное, оскорбления по национальности и темы самоубийств */
const newsOk = t => { const x = yo(t); return !BANNED[0].test(x) && !BANNED[1].test(x) && !/суицид|самоубий|педофил/.test(x); };
async function buildNews(seen) {
  const all = [];
  await Promise.all(FEEDS.map(async f => { try { parseRss(await getTextAuto(f.u)).slice(0, f.big ? 30 : 15).forEach(x => all.push({ ...x, src: f.n, cat: f.cat, w: f.w, lang: f.lang })); report['feed:' + f.n] = 'ok'; } catch (e) { report['feed:' + f.n] = 'fail: ' + e.message; } }));
  const now = Date.parse(TODAY + 'T12:00:00Z');
  const pool = all.map(x => { const t = Date.parse(x.date); return { ...x, hrs: isNaN(t) ? 48 : Math.max(0, (now - t) / 36e5) }; })
    .filter(x => x.title && x.link && x.hrs <= 72 && newsOk(x.title + ' ' + x.desc) && !seen.has(norm(x.title)));
  const tk = pool.map(x => toks(x.title));
  pool.forEach((x, i) => {
    const srcs = new Set(); pool.forEach((y, j) => { if (j !== i && y.src !== x.src) { let c = 0; tk[i].forEach(w => { if (tk[j].has(w)) c++; }); if (c >= 2) srcs.add(y.src); } });
    const txt = x.title + ' ' + x.desc, ru = RUSSIA.test(txt), dis = DISCOVERY.test(txt);
    x.tags = [...(ru ? ['Россия'] : []), ...(dis ? ['открытия и наука'] : [])];
    x.score = Math.round((x.w + 3 * (1 - Math.min(x.hrs, 72) / 72) + 1.5 * Math.min(srcs.size, 2) + (ru ? 3 : 0) + (dis ? 3 : 0) + (ru && dis ? 1 : 0) - (CLICKBAIT.test(x.title) ? 1.5 : 0)) * 100) / 100;
  });
  const sorted = pool.sort((a, b) => b.score - a.score);
  const choose = (cands, start = []) => {
    const res = [...start], per = {}; res.forEach(x => { per[x.src] = (per[x.src] || 0) + 1; });
    cands.forEach(x => {
      if (res.length >= 6 || (per[x.src] || 0) >= 2) return;
      const t = x._t || toks(x.title); if (res.some(c => { let n = 0; t.forEach(w => { if (c._t.has(w)) n++; }); return n >= 3; })) return; // та же история из другого издания
      x._t = t; per[x.src] = (per[x.src] || 0) + 1; res.push(x);
    });
    return res;
  };
  let out = choose(sorted);
  /* Всё в приложении должно быть по-русски: английские новости переводим, а если перевода нет — заменяем русскими */
  const en = out.filter(x => x.lang === 'en');
  if (en.length && HAS_LLM) { try {
    const tr = await toRussian(en.map(x => ({ title: x.title, text: clip(x.desc, 220) })), 'news');
    en.forEach((x, i) => { if (cyr(tr[i].title) >= 0.5) { x.orig = x.title; x.title = tr[i].title; x.desc = tr[i].text; x.tr = LLM_NAME; x.lang = 'ru'; } });
    const n = en.filter(x => x.tr).length; report['news:translate'] = n === en.length ? `ok (переведено ${n})` : `переведено ${n} из ${en.length}, остальные заменены русскими`;
  } catch (e) { report['news:translate'] = 'fail: ' + e.message; } }
  const kept = out.filter(x => x.lang === 'ru');
  if (kept.length < out.length) out = choose(sorted.filter(x => x.lang === 'ru' && !kept.includes(x)), kept);
  out.sort((a, b) => b.score - a.score);
  if (!out.length) throw new Error('нет свежих новостей');
  return out.map(x => ({ t: x.title, s: clip(x.desc, 220), l: x.link, src: x.src, cat: x.cat, lang: x.lang, d: x.date.slice(0, 16), score: x.score, tags: x.tags, ...(x.tr ? { tr: x.tr, orig: x.orig } : {}) }));
}

/* =====================================================================
   3. ПРОМПТЫ — каталог Awesome ChatGPT Prompts (CC0). Рейтинг структуры промпта:
      роль (+2), длина 200–900 (+2), формат/ограничения (+1 за каждое, до 3), не для разработчиков (+1).
   ===================================================================== */
export function parseCSV(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; } else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); } return rows;
}
export function scorePrompt(p, dev) {
  let s = 0; if (/act as|you are|I want you to/i.test(p)) s += 2; if (p.length >= 200 && p.length <= 900) s += 2;
  s += Math.min(3, (p.match(/format|step|limit|only|do not|don't|example|tone|words|list/gi) || []).length ? Math.min(3, new Set((p.match(/format|step|limit|only|do not|don't|example|tone|words|list/gi) || []).map(x => x.toLowerCase())).size) : 0);
  if (!/^true$/i.test(dev || '')) s += 1; return s;
}
async function buildPrompts(seen) {
  const rows = parseCSV(await getText('https://raw.githubusercontent.com/f/awesome-chatgpt-prompts/main/prompts.csv')).slice(1).filter(r => r[0] && r[1]);
  const ranked = rows.map(r => ({ title: r[0].trim(), text: r[1].trim(), score: scorePrompt(r[1], r[2]) })).filter(x => x.text.length <= 1200 && !seen.has(norm(x.text))).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const top = ranked.slice(0, 60); const pickd = rot(top, 3);
  let items = pickd.map(x => ({ id: 'ac' + norm(x.title).replace(/ /g, '').slice(0, 20), cat: 'каталог', title: x.title, text: x.text, src: 'Awesome ChatGPT Prompts (CC0)', lang: 'en', score: x.score }));
  if (HAS_LLM && items.length) { try {
    const tr = await toRussian(items.map(i => ({ title: i.title, text: i.text })), 'prompt');
    items = items.map((it, i) => (cyr(tr[i].title) >= 0.5 && cyr(tr[i].text) >= 0.4) ? { ...it, title: tr[i].title, text: tr[i].text, lang: 'ru', src: it.src + ', перевод: ' + LLM_NAME } : it);
  } catch (e) { report['prompts:translate'] = 'fail: ' + e.message; } }
  items = items.filter(x => x.lang === 'ru');
  if (!items.length) throw new Error('английский промпт не показываем: нужен перевод (ключ GigaChat) — блок скрыт, остаётся русская библиотека');
  return items;
}

/* =====================================================================
   4. СЛОВО ДНЯ — Викисловарь (ru). Слова берутся из списка редких слов ниже (расширяйте его),
      значение и этимология — из статьи. Если статья не разобрана — берём следующее слово.
   ===================================================================== */
const WORDS = ['кручина', 'отрада', 'нега', 'сермяга', 'благоговение', 'пытливый', 'светозарный', 'вёдро', 'радушие', 'ветхий', 'лучезарный', 'дремучий', 'задумчивость', 'бережливость',
  'безмятежность', 'многолетие', 'приволье', 'смекалка', 'забава', 'душевность', 'радение', 'тихоня', 'озарение', 'простор', 'чаяние', 'благодать', 'разумение', 'задорный', 'светлица',
  'росстани', 'закоулок', 'бирюза', 'околица', 'златоуст', 'мудрёный', 'кротость', 'ненастье', 'заповедный', 'непоседа', 'соловьиный', 'вешний', 'бескрайний', 'первозданный', 'лад', 'отзывчивость'];
export function parseWikt(wt) {
  /* Разметка ru.wiktionary менялась, поэтому не полагаемся на уровень заголовков: ищем «Значение» и «Этимология» на любом уровне */
  let start = wt.search(/\{\{-ru-\}\}|^=+\s*Русский\s*=+\s*$/m); if (start < 0) start = 0;
  let body = wt.slice(start); const next = body.slice(10).search(/^=\s*\{\{-(?!ru-)[a-z-]+-\}\}|^==?\s*(?!Русский)[А-ЯЁ][а-яё]+\s*==?\s*$/m); if (next > 0) body = body.slice(0, next + 10);
  const sec = name => { const m = body.match(new RegExp('^=+\\s*' + name + '\\s*=+\\s*$\\n([\\s\\S]*?)(?=^=+[^=\\n]|$(?![\\s\\S]))', 'm')); return m ? m[1] : ''; };
  const meanings = sec('Значение').split('\n').filter(l => /^#(?![#*:])/.test(l)).map(l => wikiClean(l.replace(/^#\s*/, ''))).filter(l => l.length > 8 && !/[{}]/.test(l));
  if (!meanings.length) return null;
  const et = sec('Этимология').split('\n').map(l => wikiClean(l)).filter(l => l.length > 10 && !/[{}]/.test(l)).join(' ');
  return { m: clip(meanings.slice(0, 2).join('; '), 240), e: clip(et, 240) };
}
async function buildWord(seen) {
  const why = [];
  for (const w of rot(WORDS, 6)) { if (seen.has(norm(w))) { why.push(w + ': уже было'); continue; }
    try { const j = await getJSON(`https://ru.wiktionary.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(w)}`);
      const pg = j.query.pages[0]; if (pg.missing) { why.push(w + ': нет статьи'); continue; }
      const r = parseWikt(pg.revisions[0].slots.main.content);
      if (!r) { why.push(w + ': не найден раздел «Значение»'); continue; }
      return [{ w: w[0].toUpperCase() + w.slice(1), m: r.m, e: r.e, ex: '', src: 'Викисловарь (CC BY-SA)', url: 'https://ru.wiktionary.org/wiki/' + encodeURIComponent(w) }];
    } catch (e) { why.push(w + ': ' + e.message); } }
  throw new Error('слово не разобрано (' + why.join('; ') + ')'); // причина видна в daily.json → sources.word
}

/* =====================================================================
   5. КНИГИ — Open Library. Рейтинг = средняя оценка × ln(1 + число оценок). Минимум 5 оценок.
   ===================================================================== */
const SUBJECTS = ['science', 'physics', 'artificial intelligence', 'mathematics', 'history of science', 'communication', 'psychology', 'philosophy', 'biography', 'business'];
async function buildBooks(seen) {
  const subj = rot(SUBJECTS, 1)[0]; let docs = [], lg = 'rus';
  for (const lang of ['rus', 'eng']) { const j = await getJSON(`https://openlibrary.org/search.json?q=${encodeURIComponent(`subject:"${subj}" language:${lang}`)}&sort=rating&limit=30&fields=key,title,author_name,first_publish_year,ratings_average,ratings_count`);
    docs = (j.docs || []).filter(d => d.ratings_count >= 5 && d.ratings_average); if (docs.length) { lg = lang; break; } }
  const ranked = docs.map(d => ({ t: d.title, a: (d.author_name || ['—'])[0], y: d.first_publish_year, rating: Math.round(d.ratings_average * 100) / 100, count: d.ratings_count, url: 'https://openlibrary.org' + d.key,
    score: Math.round(d.ratings_average * Math.log(1 + d.ratings_count) * 100) / 100, why: '' })).filter(b => !seen.has(norm(b.t))).sort((a, b) => b.score - a.score);
  if (!ranked.length) throw new Error('нет подходящих книг');
  let pick = rot(ranked.slice(0, 15), 1);
  if (lg === 'eng') { // русскоязычных книг с оценками нет: берём зарубежную только с русским названием
    if (!HAS_LLM) throw new Error('русских книг с оценками нет, а для перевода названий нужен ключ GigaChat — остаётся русская база');
    const tr = await toRussian(pick.map(b => ({ title: b.t, text: b.a })), 'book');
    pick = pick.map((b, i) => cyr(tr[i].title) >= 0.5 ? { ...b, orig: b.t, t: tr[i].title, a: tr[i].text && cyr(tr[i].text) >= 0.5 ? tr[i].text : b.a } : null).filter(Boolean);
    if (!pick.length) throw new Error('перевод названия не удался');
  }
  return pick;
}

/* =====================================================================
   6. ФИЛЬМЫ — TMDB (нужен бесплатный ключ TMDB_API_KEY). Рейтинг = оценка × ln(1 + голосов).
   ===================================================================== */
async function buildFilms(seen) {
  if (!TMDB) throw new Error('ключ TMDB_API_KEY не задан — раздел остаётся на локальной базе');
  const j = await getJSON(`https://api.themoviedb.org/3/movie/top_rated?language=ru-RU&page=${1 + (DAYNUM % 20)}&api_key=${TMDB}`);
  const r = (j.results || []).filter(m => m.overview && m.vote_count > 500 && !seen.has(norm(m.title))).map(m => ({ t: m.title, y: (m.release_date || '').slice(0, 4), g: '', rating: m.vote_average, count: m.vote_count,
    why: clip(m.overview, 220), score: Math.round(m.vote_average * Math.log(1 + m.vote_count) * 100) / 100, src: 'TMDB' })).sort((a, b) => b.score - a.score);
  if (!r.length) throw new Error('нет фильмов'); return r.slice(0, 2);
}

/* =====================================================================
   7. ЮМОР — официальные RSS-ленты «Анекдоты из России» (anekdot.ru).
      Сайт разрешает транслировать ленты на другие сайты при обязательной ссылке на него, поэтому
      каждый анекдот подписан «Источник: anekdot.ru» и ведёт на оригинал. Права на тексты принадлежат
      их владельцам (так написано на сайте), поэтому берём ТОЛЬКО эти ленты, не больше 3 анекдотов в день,
      а в archive/ тексты не сохраняем — только отпечатки для «не повторять».
      Ленты: «Ежедневная десятка анекдотов» и «Лучшие по голосованию читателей».
      Рейтинг: место в ленте (это голосование читателей) + 3 за присутствие в обеих лентах + 1 за краткость.
      Фильтр (по вашему решению): БЕЗ МАТА и без масок вроде х**. Пошловатый юмор допустим, но не откровенная
      порнография, оскорбления по национальности и политика (её можно разрешить: HUMOR_ALLOW_POLITICS).
      GigaChat/Claude — запасной вариант, только если ленты не дали хотя бы 2 анекдота.
   ===================================================================== */
const HUMOR_ALLOW_POLITICS = false;
const yo = t => t.toLowerCase().replace(/ё/g, 'е');
const MAT = [/х[уy][йеяию]/, /п[иi]зд/, /бля[дт]/, /(^|[^а-я])бля([^а-я]|$)/,
  /(^|[^а-я])(на|по|за|вы|у|от|до|при|раз|об|под|про|пере)?еб([аоуиыяеюл]|ну|ан)/, /долбо?еб|долбае/, /мудак|мудил/, /пид[оа]р|пидр/,
  /гандон|залуп|манд[ао]в|шлюх/, /(^|[^а-я])сук(а|и|е|у|ой|ам|ами)([^а-я]|$)|сучар/, /трахат|трахну|трахал|трахн/, /\*{2,}|[а-я]\*[а-я]|#{2,}/];
const BANNED = [/жид(ы|ов|ам)?([^а-я]|$)|хач|чурк|хохл|кацап|москал|черномаз/, /порно|минет|оргазм|сперм|изнасил|педофил|инцест|зоофил|некрофил/, /суицид|самоубий|теракт|террор|похорон|погибш/];
const POLITICS = [/путин|трамп|байден|зеленск|навальн|политик|госдум|депутат|санкци|единорос|коммунист|мобилизац|вторжен|спецоперац/];
export const hasMat = t => MAT.some(r => r.test(yo(t)));
const hasBanned = t => BANNED.some(r => r.test(yo(t))) || (!HUMOR_ALLOW_POLITICS && POLITICS.some(r => r.test(yo(t))));
const sentences = t => (t.match(/[.!?…]+(\s|$)/g) || []).length || 1;
export const jokeOk = (t, maxSent = 6) => t.length >= 40 && t.length <= 500 && sentences(t) <= maxSent && t.split('\n').length <= 8 && !hasMat(t) && !hasBanned(t);
const htmlToLines = h => decode((h || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')).split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');

async function fetchAnekdot() {
  const feeds = [['десятка', 'https://www.anekdot.ru/rss/export_j.xml'], ['лучшие', 'https://www.anekdot.ru/rss/export_top.xml']]; const all = [];
  await Promise.all(feeds.map(async ([n, u]) => { try {
    const items = parseRss(await getTextAuto(u));
    items.forEach((x, i) => { const body = htmlToLines(x.html); all.push({ feed: n, idx: i, t: body.length >= 30 ? body : htmlToLines(x.title), url: x.link }); });
    report['feed:anekdot.ru ' + n] = 'ok (' + items.length + ')';
  } catch (e) { report['feed:anekdot.ru ' + n] = 'fail: ' + e.message; } }));
  return all;
}
async function buildHumor(seen) {
  const uniq = new Map();
  (await fetchAnekdot()).forEach(x => { const k = norm(x.t); if (!k) return; const cur = uniq.get(k);
    if (cur) cur.score += 3; else uniq.set(k, { ...x, score: (9 - Math.min(x.idx, 9)) + (x.t.length <= 250 ? 1 : 0) }); });
  const cands = [...uniq.values()];
  const passed = cands.filter(x => jokeOk(x.t) && !seen.has(jh(x.t))).sort((a, b) => b.score - a.score);
  report['humor:anekdot.ru'] = `кандидатов ${cands.length}, прошло фильтр ${passed.length}`;
  const safeUrl = u => (u && /^https?:\/\/(www\.)?anekdot\.ru\//.test(u)) ? u : 'https://www.anekdot.ru/';
  const jokes = passed.slice(0, 3).map(x => ({ id: 'a' + jh(x.t), kind: 'anekdot', t: x.t, src: 'anekdot.ru', url: safeUrl(x.url), score: x.score }));
  let stories = [];
  if (jokes.length < 2 && HAS_LLM) {  // запасной вариант: нейросеть, только если ленты не ответили
    try {
      const arr = JSON.parse(extractJSON(await llm(`Ты — редактор юмористической рубрики. Придумай 6 коротких шуток и 1 смешную историю на русском, без мата и без политики. Шутка ≤ 6 предложений, история ≤ 12. Не пересказывай известные анекдоты. Если сомневаешься — не включай. Верни ТОЛЬКО JSON: [{"type":"joke"|"story","text":"..."}]`, 2500)));
      const ok = (Array.isArray(arr) ? arr : []).filter(x => x && typeof x.text === 'string' && !seen.has(jh(x.text)));
      const mkj = x => ({ id: 'h' + jh(x.text), kind: 'ai', t: x.text.trim() });
      ok.filter(x => x.type !== 'story' && jokeOk(x.text)).slice(0, 3 - jokes.length).forEach(x => jokes.push(mkj(x)));
      stories = ok.filter(x => x.type === 'story' && jokeOk(x.text, 12)).slice(0, 1).map(mkj);
      report['humor:' + LLM_NAME] = 'запасной вариант: ' + jokes.filter(j => j.kind === 'ai').length + ' шуток';
    } catch (e) { report['humor:' + LLM_NAME] = 'fail: ' + e.message; }
  }
  if (!jokes.length && !stories.length) throw new Error('ленты не дали подходящих анекдотов');
  return { jokes, stories };
}

/* ---------- Нейросеть: GigaChat (основной) или Claude (запасной) — только для шуток и перевода ---------- */
let gigaTok = null;
async function gigaToken() {
  if (gigaTok && gigaTok.exp > Date.now() + 60000) return gigaTok.t;
  const r = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', RqUID: crypto.randomUUID(), Authorization: 'Basic ' + GIGA },
    body: 'scope=' + encodeURIComponent(process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS') });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) throw new Error('GigaChat OAuth: ' + (j.message || r.status));
  gigaTok = { t: j.access_token, exp: j.expires_at || Date.now() + 25 * 60000 }; return gigaTok.t;
}
async function gigachat(prompt, max = 2000) {
  const r = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + await gigaToken() },
    body: JSON.stringify({ model: process.env.GIGACHAT_MODEL || 'GigaChat', messages: [{ role: 'user', content: prompt }], temperature: 0.8, max_tokens: max }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('GigaChat: ' + (j.message || r.status));
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}
async function claude(prompt, max = 2000) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-5', max_tokens: max, messages: [{ role: 'user', content: prompt }] }) });
  const j = await r.json(); if (!r.ok) throw new Error('Claude API: ' + (j.error && j.error.message || r.status));
  return (j.content || []).map(b => b.text || '').join('');
}
const llm = (prompt, max) => (GIGA ? gigachat(prompt, max) : claude(prompt, max));

/* ---------- Перевод на русский: всё, что показывается в приложении, должно быть по-русски ---------- */
export const cyr = t => { const l = (t.match(/[a-zа-яё]/gi) || []).length; return l ? (t.match(/[а-яё]/gi) || []).length / l : 1; }; // доля кириллицы среди букв
async function toRussian(list, kind) {
  const rules = { news: 'Это новости: переводи точно, без оценок и добавлений; имена, числа, названия организаций и стран сохраняй.',
    prompt: 'Это промпты для нейросети: сохрани структуру, списки и все плейсхолдеры в [скобках], {фигурных скобках} и ${...} без изменений.',
    book: 'Это названия книг (title) и имена авторов (text): название переведи на русский (если есть устоявшийся русский перевод — используй его), имя автора запиши кириллицей.' }[kind];
  const arr = JSON.parse(extractJSON(await llm(`Переведи на русский язык. ${rules} Ничего не объясняй. Верни ТОЛЬКО JSON-массив [{"title":"...","text":"..."}] того же размера и в том же порядке.\n\n${JSON.stringify(list)}`, 4000)));
  if (!Array.isArray(arr) || arr.length !== list.length) throw new Error('перевод вернул неверный формат');
  return arr.map(x => ({ title: String((x && x.title) || ''), text: String((x && x.text) || '') }));
}
const extractJSON = t => { const a = t.search(/[\[{]/); const b = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}')); if (a < 0 || b < a) throw new Error('JSON не найден'); return t.slice(a, b + 1); };

/* =====================================================================
   СБОРКА
   ===================================================================== */
async function main() {
  const seen = await loadSeen();
  const [quotes, news, prompts, words, books, films, humor] = await Promise.all([
    step('quotes', () => buildQuotes(seen), []), step('news', () => buildNews(seen), []), step('prompts', () => buildPrompts(seen), []),
    step('word', () => buildWord(seen), []), step('books', () => buildBooks(seen), []), step('films', () => buildFilms(seen), []), step('humor', () => buildHumor(seen), { jokes: [], stories: [] })]);
  const out = { v: 1, date: TODAY, generated: new Date().toISOString(), sources: report,
    scoring: 'Цитаты: источник+длина+раздел; новости: вес источника+свежесть+совпадение тем; промпты: роль+длина+ограничения; книги: оценка×ln(1+голоса); фильмы: оценка×ln(1+голоса).',
    quotes, news, prompts, words, books, films, jokes: humor.jokes, stories: humor.stories };
  await fs.mkdir(path.join(ROOT, 'archive'), { recursive: true });
  const s = JSON.stringify(out, null, 1);
  const arch = { ...out, jokes: out.jokes.map(j => ({ id: j.id, h: jh(j.t) })), stories: out.stories.map(j => ({ id: j.id, h: jh(j.t) })) }; // тексты анекдотов в архив не пишем
  await fs.writeFile(path.join(ROOT, 'daily.json'), s); await fs.writeFile(path.join(ROOT, 'archive', TODAY + '.json'), JSON.stringify(arch, null, 1));
  const okN = Object.values(report).filter(v => v === 'ok').length;
  console.log(`daily.json готов за ${TODAY}: источников ок ${okN}/${Object.keys(report).length}`); Object.entries(report).forEach(([k, v]) => console.log(' ', k, '→', v));
  /* Если не собралось вообще ничего — это ошибка сборки, чтобы Actions не публиковал пустой файл */
  if (![quotes, news, prompts, words, books].some(a => a.length)) { console.error('Ни один источник не ответил'); process.exit(1); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
