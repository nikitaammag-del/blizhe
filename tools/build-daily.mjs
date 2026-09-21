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
import { TOPICS } from './curriculum.mjs';   // годовая программа: 360 тем
import { WORDS } from './words.mjs';         // 490 слов для «Слова дня»
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = process.env.BUILD_DATE || new Date().toISOString().slice(0, 10);
const DAYNUM = Math.floor(Date.parse(TODAY + 'T00:00:00Z') / 864e5);
const GIGA = process.env.GIGACHAT_AUTH_KEY || '';      // «Ключ авторизации» из личного кабинета GigaChat (Studio)
const DAY_OF_YEAR = Math.floor((Date.parse(TODAY + 'T00:00:00Z') - Date.parse(TODAY.slice(0, 4) + '-01-01T00:00:00Z')) / 864e5) + 1;
const COURSE_DAY = ((DAY_OF_YEAR - 1) % TOPICS.length) + 1;   // день года → номер темы: 12 месяцев без повторов
class Exhausted extends Error {}                             // «новых материалов не осталось» → тогда берём лучшее из прошлых
const httpUrl = u => /^https?:\/\/[^\s"'<>]+$/i.test(String(u || '').trim()) ? String(u).trim() : ''; // только http(s): защита от javascript:-ссылок
const KEY = process.env.ANTHROPIC_API_KEY || '';       // запасной вариант
const HAS_LLM = !!(GIGA || KEY);                       // есть ли хоть какая-то нейросеть
let LLM_NAME = GIGA ? 'GigaChat' : KEY ? 'Claude' : ''; // какая нейросеть реально работает (уточняется после проверки входа)
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
const strip = h => { let t = decode((h || '').replace(/<!\[CDATA\[|\]\]>/g, '')); t = t.replace(/<[^>]+>/g, ' '); return decode(t).replace(/\s+/g, ' ').trim(); }; // сначала раскодируем &lt;p&gt;, потом вырезаем теги

/* Что уже публиковали за последние 30 дней — не повторяем */
async function loadSeen() {
  const seen = new Set();
  try {
    const dir = path.join(ROOT, 'archive'); const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json') && f < TODAY + '.json').sort().slice(-400); // почти год: без повторов
    for (const f of files) { const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      (j.quotes || []).forEach(x => seen.add(norm(x.t || ''))); (j.prompts || []).forEach(x => { if (x.id) seen.add(x.id); });
      [...(j.jokes || []), ...(j.stories || [])].forEach(x => seen.add(x.h || jh(x.t || '')));
      (j.words || []).forEach(x => seen.add(norm(x.w))); (j.books || []).forEach(x => { seen.add(norm(x.t)); if (x.url) seen.add(x.url); });
      (j.films || []).forEach(x => seen.add(norm(x.t))); (j.tracks || []).forEach(x => { if (x.k) seen.add(x.k); }); }
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
    if (/^:|^(Категория|Category|Файл|File|Шаблон|Template):/i.test(text)) continue; // служебные ссылки Википедии — не цитаты
    /* Подпункты «**» бывают источником, а бывают комментарием редакторов («Реальная цитата…», «Эта цитата восходит…») — комментарий не источник и говорит о сомнительной атрибуции */
    const NOTE = /^(Реальная цитата|Эта цитата|Приписыва|См\.|Оригинал|На самом деле|Ошибочно|Фактически|Цитата (не|неточно))/i; let src = '', j = i + 1, doubtful = false;
    while (lines[j] && /^\*\*/.test(lines[j])) { const s2 = wikiClean(lines[j].replace(/^\*+\s*/, '')); if (NOTE.test(s2)) doubtful = true; else if (s2) src += (src ? '; ' : '') + s2; j++; }
    if (text.length < 30 || text.length > 220 || !clean(text)) continue;
    const score = (src ? 3 : 0) + (text.length >= 40 && text.length <= 200 ? 2 : 0) + (dis ? 0 : 1) - (doubtful ? 2 : 0) - (/^[—–-]\s/.test(wikiClean(m[1])) ? 4 : 0); // реплики диалога без контекста — в конец
    out.push({ a: author, t: text, src: src ? clip(src, 160) : '', dis: dis || !src || doubtful, doubtful, score });
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
      parseWikiquote(wt, name).forEach(q => cands.push({ ...q, hasSrc: !!q.src, score: q.score + (PRIORITY_AUTHORS.includes(name) ? 1 : 0), url, src: 'Викицитатник (CC BY-SA 4.0)' + (q.src ? ': ' + q.src : ': источник не указан') }));
    } catch (e) { /* автор не найден — пропускаем */ }
  }
  if (!cands.length) throw new Error('нет кандидатов');
  const used = new Set(); const out = [];
  cands.filter(q => !seen.has(norm(q.t)) && !q.doubtful).sort((a, b) => b.score - a.score || a.t.localeCompare(b.t)).forEach(q => { // цитаты с пометкой редакторов «неверная атрибуция» не берём; без источника — не больше одной за выпуск
    if (out.length < 4 && !used.has(q.a) && (q.hasSrc || !out.some(x => !x.hasSrc))) { used.add(q.a); out.push(q); } });
  if (!out.length && cands.length) throw new Exhausted('все найденные цитаты уже показывали');
  return out;
}

/* =====================================================================
   2. НОВОСТИ — RSS-ленты. «Самое интересное в мире», но с приоритетом на Россию и открытия. Внутри каждой группы — общий рейтинг.
      Рейтинг = вес источника + свежесть (0..3) + 1,5 за каждое совпадение темы в другом издании (макс. 2)
                + 3, если новость про Россию, + 3, если про открытия, изобретения, науку и гениев (Архимед, Ньютон, Менделеев,
                Попов, радио, ИИ и т. п.), + 1, если оба сразу, − 1,5 за кричащий заголовок («шок», «сенсация»).
      Отбор: 6 новостей поровну — 3 про Россию и науку и 3 про мир; не больше 2 из одного издания; одну историю из нескольких изданий показываем один раз.
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
    items.push({ title: strip(g('title')), link: httpUrl(link), desc: strip(g('description') || g('summary') || g('content')), html: g('description') || g('summary') || g('content'), date: strip(g('pubDate') || g('published') || g('updated') || g('dc:date')) });
  }
  return items;
}
const toks = t => new Set(norm(t).split(' ').filter(w => w.length > 4).map(w => w.slice(0, 5)));
const RUSSIA = /росси|(^|[^а-яё])рф([^а-яё]|$)|москв|кремл|russia|moscow|kremlin/i;
const DISCOVERY = /научн\w* открыти|открыти\w* (в области|учён|ученых|физик|астроном|биолог|химик|генетик)|(сделал|совершил)\w* открыти|учён|учен(ые|ых|ым|ыми|ого)|физик|химик[аиов]|биолог|астроном|генетик|изобрет|нобелев|прорыв в|искусственн\w* интеллект|нейросет|(^|[^а-яё])ии([^а-яё]|$)|архимед|ньютон|менделеев|радио|телескоп|космическ|квантов|днк|геном|вакцин|breakthrough|discover|invent|scientist|researchers|newton|archimedes|artificial intelligence|\bAI\b/i; // «открыт» отдельно НЕ берём: цепляет «открытая площадка», «открыли памятник»
const CLICKBAIT = /(^|[^а-яё])шок|сенсаци|не поверите|won't believe|you won.t believe/i;
/* Для новостей допускаем политику и ЧП, отсекаем откровенное, оскорбления по национальности и темы самоубийств */
const newsOk = t => { const x = yo(t); return !BANNED[0].test(x) && !BANNED[1].test(x) && !/суицид|самоубий|педофил/.test(x); };
async function buildNews(seen) {
  const all = [];
  await Promise.all(FEEDS.map(async f => { try { parseRss(await getTextAuto(f.u)).slice(0, f.big ? 30 : 15).forEach(x => all.push({ ...x, title: x.title.split(' // ')[0].trim(), src: f.n, cat: f.cat, w: f.w, lang: f.lang })); report['feed:' + f.n] = 'ok'; } catch (e) { report['feed:' + f.n] = 'fail: ' + e.message; } }));
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
  /* Пополам (ваш выбор): 3 новости про Россию и науку (есть тег «Россия» или «открытия и наука») + 3 про мир (без этих тегов).
     Если в одной группе не хватает кандидатов, добираем из другой. Не больше 2 из одного издания, дубли историй убираем. */
  const grp = x => (x.tags && x.tags.length ? 'A' : 'B');
  const choose = (cands, start = []) => {
    const res = [...start], per = {}, cnt = { A: 0, B: 0 };
    res.forEach(x => { per[x.src] = (per[x.src] || 0) + 1; cnt[grp(x)]++; });
    const tryAdd = (x, strict, cap) => {
      if (res.length >= 6 || res.includes(x) || (per[x.src] || 0) >= cap || (strict && cnt[grp(x)] >= 3)) return;
      const t = x._t || toks(x.title); if (res.some(c => { let n = 0; t.forEach(w => { if (c._t.has(w)) n++; }); return n >= 3; })) return; // та же история из другого издания
      x._t = t; per[x.src] = (per[x.src] || 0) + 1; cnt[grp(x)]++; res.push(x);
    };
    cands.forEach(x => tryAdd(x, true, 2));    // сначала по 3 из каждой группы, не больше 2 из одного издания
    cands.forEach(x => tryAdd(x, true, 3));    // если группе не хватило — ослабляем лимит на издание, но пополам сохраняем
    cands.forEach(x => tryAdd(x, false, 4));   // и только потом добираем до 6 из любой группы
    return res;
  };
  let out = choose(sorted);
  /* Всё в приложении должно быть по-русски: английские новости переводим, а если перевода нет — заменяем русскими */
  const en = out.filter(x => x.lang === 'en');
  if (en.length && HAS_LLM) { try {
    const tr = await toRussian(en.map(x => ({ title: x.title, text: clip(x.desc, 220) })), 'news');
    en.forEach((x, i) => { if (tr[i] && cyr(tr[i].title) >= 0.5) { x.orig = x.title; x.title = tr[i].title; x.desc = tr[i].text; x.tr = LLM_NAME; x.lang = 'ru'; } });
    const n = en.filter(x => x.tr).length; report['news:translate'] = n === en.length ? `ok (переведено ${n})` : `переведено ${n} из ${en.length}, остальные заменены русскими` + (tr.errors.length ? ' (' + tr.errors[0] + ')' : '');
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
  const latinShare = t => { const L = t.match(/\p{L}/gu) || []; return L.length ? L.filter(c => /[A-Za-z]/.test(c)).length / L.length : 1; };
  const NOT_FOR_US = /video|animation|midjourney|dall-?e|stable diffusion|image generat|render|logo|3d model|\bunity\b|\bunreal\b/i; // видео, картинки, игры — не про общение и развитие
  const rows = parseCSV(await getText('https://raw.githubusercontent.com/f/awesome-chatgpt-prompts/main/prompts.csv')).slice(1).filter(r => r[0] && r[1] && !/^true$/i.test(r[2] || '') && !NOT_FOR_US.test(r[0] + ' ' + r[1].slice(0, 400)) && latinShare(r[1].slice(0, 400)) >= 0.9); // только английские (в каталоге есть китайские и турецкие)
  const OURS = /teacher|tutor|coach|interview|negotiat|writer|editor|translator|resume|cover letter|debate|speaker|presentation|counsel|therap|motivat|career|essay|storyteller|mentor|public speaking|summar|explain|study|language|lawyer|philosoph|historian|psycholog|friend|dating|relationship|life coach/i; // тематика приложения
  const ranked = rows.map(r => ({ id: 'ac' + jh(r[0]), title: r[0].trim(), text: r[1].trim(), score: scorePrompt(r[1], r[2]) + (OURS.test(r[0] + ' ' + r[1].slice(0, 300)) ? 3 : 0) }))
    .filter(x => x.text.length <= 1200).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const fresh = ranked.filter(x => !seen.has(x.id)); // каждый день — лучший из ещё не показанных; повтор только когда каталог исчерпан
  if (!fresh.length) throw new Exhausted('все промпты каталога уже показывали');
  if (!HAS_LLM) throw new Error('английский промпт не показываем: нужен перевод (ключ GigaChat) — блок скрыт, остаётся русская библиотека');
  const errs = []; let item = null;
  for (const x of fresh.slice(0, 3)) {                      // берём первый, который удалось перевести (переменные и заголовок проверяются)
    const tr = (await toRussian([{ title: x.title, text: x.text }], 'prompt')); errs.push(...tr.errors);
    if (tr[0] && cyr(tr[0].title) >= 0.5 && cyr(tr[0].text.replace(/\$\{[^}]*\}|\{\{[^}]*\}\}/g, '')) >= 0.4) { item = { id: x.id, cat: 'каталог', title: tr[0].title, text: tr[0].text, src: 'Awesome ChatGPT Prompts (CC0), перевод: ' + LLM_NAME, lang: 'ru', score: x.score }; break; }
  }
  report['prompts:translate'] = item ? 'переведён' : 'не удалось' + (errs[0] ? ' (' + errs[0] + ')' : '');
  if (!item) throw new Error('английский промпт не показываем: перевод не удался — блок скрыт, остаётся русская библиотека');
  try { item.analysis = await analyzePrompt(item); report['prompts:analysis'] = 'ok'; } catch (e) { report['prompts:analysis'] = 'fail: ' + e.message; } // разбор приёмов именно этого промпта
  return [item];
}

/* =====================================================================
   4. СЛОВО ДНЯ — Викисловарь (ru). Слова берутся из списка редких слов ниже (расширяйте его),
      значение и этимология — из статьи. Если статья не разобрана — берём следующее слово.
   ===================================================================== */
export function parseWikt(wt) {
  /* Разметка ru.wiktionary менялась, поэтому не полагаемся на уровень заголовков: ищем «Значение» и «Этимология» на любом уровне */
  let start = wt.search(/\{\{-ru-\}\}|^=+\s*Русский\s*=+\s*$/m); if (start < 0) start = 0;
  let body = wt.slice(start); const next = body.slice(10).search(/^=\s*\{\{-(?!ru-)[a-z-]+-\}\}|^==?\s*(?!Русский)[А-ЯЁ][а-яё]+\s*==?\s*$/m); if (next > 0) body = body.slice(0, next + 10);
  const sec = name => { const m = body.match(new RegExp('^=+\\s*' + name + '\\s*=+\\s*$\\n([\\s\\S]*?)(?=^=+[^=\\n]|$(?![\\s\\S]))', 'm')); return m ? m[1] : ''; };
  const tidy = t => t.replace(/^[\s;,.:—–-]+/, '').replace(/[\s;,:—–-]+$/, '').trim(); // убираем «; » в начале и обрывки после удалённых шаблонов
  const meanings = sec('Значение').split('\n').filter(l => /^#(?![#*:])/.test(l)).map(l => tidy(wikiClean(l.replace(/^#\s*/, '')))).filter(l => l.length > 8 && !/[{}]/.test(l));
  if (!meanings.length) return null;
  let et = tidy(sec('Этимология').split('\n').map(l => wikiClean(l)).filter(l => l.length > 10 && !/[{}]/.test(l)).join(' '));
  et = et.replace(/[,;]?\s*(далее\s+)?(из|от|и|или|через|с|от\s+слова)\s*$/i, '').trim(); // оборванное «…, далее из» после вырезанного шаблона
  if (et && !/[.!?…]$/.test(et)) et += '.';
  return { m: clip(meanings.slice(0, 2).join('; '), 240), e: et.length > 12 ? clip(et, 240) : '' };
}
async function buildWord(seen) {
  const why = []; let tried = 0, allSeen = true;
  for (let n = 0; n < WORDS.length && tried < 15; n++) {
    const w = WORDS[(DAY_OF_YEAR * 7 + n) % WORDS.length];           // каждый день начинаем с другого места списка
    if (seen.has(norm(w))) { why.push(w + ': уже было'); continue; }
    allSeen = false; tried++;
    try { const j = await getJSON(`https://ru.wiktionary.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(w)}`);
      const pg = j.query.pages[0]; if (pg.missing) { why.push(w + ': нет статьи'); continue; }
      const r = parseWikt(pg.revisions[0].slots.main.content);
      if (!r) { why.push(w + ': не найден раздел «Значение»'); continue; }
      return [{ w: w[0].toUpperCase() + w.slice(1), m: r.m, e: r.e, ex: '', src: 'Викисловарь (CC BY-SA)', url: 'https://ru.wiktionary.org/wiki/' + encodeURIComponent(w) }];
    } catch (e) { why.push(w + ': ' + e.message); } }
  if (allSeen) throw new Exhausted('весь список слов уже показывали');
  throw new Error('слово не разобрано (' + why.slice(-6).join('; ') + ')'); // причина видна в daily.json → sources.word
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
    score: Math.round(d.ratings_average * Math.log(1 + d.ratings_count) * 100) / 100, why: '' })).filter(b => !seen.has(norm(b.t)) && !seen.has(b.url)).sort((a, b) => b.score - a.score);
  if (!ranked.length) throw new (docs.length ? Exhausted : Error)('нет подходящих книг');
  /* Сначала книги, у которых название уже по-русски; название и имя автора должны быть кириллицей (иначе переводим/транслитерируем) */
  const ordered = [...ranked.filter(b => cyr(b.t) >= 0.5), ...ranked.filter(b => cyr(b.t) < 0.5)].slice(0, 30);
  for (const b of rot(ordered, 3)) {
    let t = b.t, a = b.a, orig = '';
    if (cyr(t) < 0.5 || cyr(a) < 0.5) {
      if (!HAS_LLM) continue;
      const tr = await toRussian([{ title: t, text: a }], 'book'); if (!tr[0]) continue;
      if (cyr(t) < 0.5) { if (cyr(tr[0].title) < 0.5) continue; orig = t; t = tr[0].title; }
      if (cyr(a) < 0.5) { if (cyr(tr[0].text) >= 0.5) a = tr[0].text; else continue; }
    }
    return [{ ...b, t, a, ...(orig ? { orig } : {}) }];
  }
  throw new Error('у лучших книг нет русского названия или имени автора, а перевод недоступен — остаётся русская база');
}

/* =====================================================================
   6. ФИЛЬМЫ — TMDB (нужен бесплатный ключ TMDB_API_KEY). Рейтинг = оценка × ln(1 + голосов).
   ===================================================================== */
async function buildFilms(seen) {
  if (!TMDB) throw new Error('ключ TMDB_API_KEY не задан — раздел остаётся на локальной базе');
  const j = await getJSON(`https://api.themoviedb.org/3/movie/top_rated?language=ru-RU&page=${1 + (DAYNUM % 100)}&api_key=${TMDB}`);
  const r = (j.results || []).filter(m => m.overview && m.vote_count > 500 && !seen.has(norm(m.title))).map(m => ({ t: m.title, y: (m.release_date || '').slice(0, 4), g: '', rating: m.vote_average, count: m.vote_count,
    why: clip(m.overview, 220), score: Math.round(m.vote_average * Math.log(1 + m.vote_count) * 100) / 100, src: 'TMDB' })).sort((a, b) => b.score - a.score);
  if (!r.length) throw new (j.results && j.results.length ? Exhausted : Error)('нет фильмов'); return r.slice(0, 1);
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
const POLITICS = [/путин|трамп|байден|зеленск|навальн|политик|госдум|депутат|санкци|единорос|коммунист|мобилизац|вторжен|спецоперац|избирател|референдум|выбор(ы|ов|ах|ам)([^а-я]|$)/];
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
let gigaTok = null, gigaDown = false;
const netErr = (what, e) => new Error(`${what}: ${e.message}${e.cause ? ' [' + (e.cause.code || e.cause.message) + ']' : ''}`); // показываем и причину сбоя (сертификат, обрыв, таймаут)
const fetchG = async (what, url, opts) => { try { return await fetch(url, opts); } catch (e) { throw netErr(what, e); } };
const retry = async (fn, n = 3) => { let last; for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { last = e; if (gigaDown && !KEY) break; await new Promise(r => setTimeout(r, 2000 * (i + 1))); } } throw last; };
async function gigaToken() {
  if (gigaTok && gigaTok.exp > Date.now() + 60000) return gigaTok.t;
  const r = await fetchG('GigaChat OAuth', 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', RqUID: crypto.randomUUID(), Authorization: 'Basic ' + GIGA },
    body: 'scope=' + encodeURIComponent(process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS') });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) throw new Error('GigaChat OAuth: ' + (j.message || r.status));
  gigaTok = { t: j.access_token, exp: j.expires_at || Date.now() + 25 * 60000 }; return gigaTok.t;
}
async function gigachat(prompt, max = 2000) {
  const r = await fetchG('GigaChat запрос', 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + await gigaToken() },
    body: JSON.stringify({ model: process.env.GIGACHAT_MODEL || 'GigaChat', messages: [{ role: 'user', content: prompt }], temperature: 0.8, max_tokens: max }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('GigaChat: ' + (j.message || r.status));
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5'; // можно заменить на более дешёвую 'claude-sonnet-5' переменной CLAUDE_MODEL
async function claude(prompt, max = 2000) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: max, messages: [{ role: 'user', content: prompt }] }) });
  const j = await r.json(); if (!r.ok) throw new Error('Claude API: ' + (j.error && j.error.message || r.status));
  return (j.content || []).map(b => b.text || '').join('');
}
/* GigaChat — основной; если вход не удался, а ключ Claude есть — автоматически переключаемся на Claude Opus */
const llmRaw = (prompt, max) => (GIGA && !gigaDown) ? gigachat(prompt, max) : KEY ? claude(prompt, max) : Promise.reject(new Error(GIGA ? 'GigaChat недоступен (см. giga:oauth), запасного ключа Claude нет' : 'нет ключа нейросети'));
let llmChain = Promise.resolve(); // запросы идут по очереди: у личного тарифа мало параллельных запросов
const llm = (prompt, max) => { const r = llmChain.then(() => llmRaw(prompt, max)); llmChain = r.catch(() => {}); return r; };

/* ---------- Перевод на русский: всё, что показывается в приложении, должно быть по-русски ---------- */
export const cyr = t => { const l = (t.match(/[a-zа-яё]/gi) || []).length; return l ? (t.match(/[а-яё]/gi) || []).length / l : 1; }; // доля кириллицы среди букв
/* Переводим по одному материалу за запрос и в простом текстовом формате (не JSON): у моделей JSON с длинными текстами часто ломается.
   Возвращает массив той же длины: {title,text} или null, если этот материал перевести не удалось (причины — в .errors). */
async function toRussian(list, kind) {
  const rules = { news: 'Это новость: переводи точно, без оценок и добавлений; имена, числа, названия организаций и стран сохраняй.',
    prompt: 'Это промпт для нейросети: сохрани структуру и списки; метки в угловых скобках ⟦ ⟧ с номером внутри оставь без изменений и на тех же местах; текст в [квадратных скобках] — это подсказки, что подставить, их переведи.',
    book: 'Это название книги (заголовок) и имя автора (текст): название переведи на русский (если есть устоявшийся русский перевод — используй его), имя автора запиши кириллицей, как принято в русских изданиях (Фёдор Достоевский).' }[kind];
  const res = []; res.errors = [];
  for (const it of list) {
    try {
      /* Переменные вида ${name} и {{name}} прячем под метки: модели их портят (${x} → $[x]\$) */
      const ph = []; let text = it.text;
      if (kind === 'prompt') text = text.replace(/\$\{[^}]*\}|\{\{[^}]*\}\}/g, m => { ph.push(m); return `⟦${ph.length}⟧`; });
      const out = (await retry(() => llm(`Переведи на русский язык. ${rules}\nОтветь СТРОГО в таком формате, без пояснений и без кавычек вокруг ответа:\nЗАГОЛОВОК: <перевод заголовка>\nТЕКСТ:\n<перевод текста>\n\nЗАГОЛОВОК: ${it.title}\nТЕКСТ:\n${text}`, 3000))).replace(/```[a-z]*/gi, '').trim();
      const m = out.match(/ЗАГОЛОВОК:\s*([^\n]*)\n+\s*ТЕКСТ:\s*([\s\S]*)$/i);
      if (!m || !m[1].trim() || !m[2].trim()) throw new Error('ответ не в ожидаемом формате');
      let title = m[1].trim().replace(/^["«»]+|["«»]+$/g, ''), body = m[2].trim();
      if (kind === 'prompt') {
        ph.forEach((v, i) => { body = body.replace(`⟦${i + 1}⟧`, () => v); });
        if (/⟦\d+⟧/.test(body) || ph.some(v => !body.includes(v))) throw new Error('модель испортила переменные промпта');
        /* Заголовок промпта переводим отдельным коротким запросом: в общем ответе модель иногда пишет «Перевод названия» */
        if (!titleOk(title)) {
          const t2 = (await retry(() => llm(`Переведи на русский язык название промпта (2–7 слов). Ответь только переводом, без кавычек и пояснений.\n${it.title}`, 100))).split('\n')[0].trim().replace(/^["«»]+|["«»]+$/g, '');
          if (!titleOk(t2)) throw new Error('не удалось получить название');
          title = t2;
        }
      } else if (/^перевод(\s+названия)?[.:]?$/i.test(title)) throw new Error('модель вернула служебную фразу вместо заголовка');
      res.push({ title, text: body });
    } catch (e) { res.push(null); res.errors.push(e.message); }
  }
  return res;
}
const titleOk = t => t.length > 2 && t.length <= 90 && !t.includes('\n') && cyr(t) >= 0.5 && !/^перевод(\s+(названия|заголовка|текста))?[.:]?$/i.test(t); // служебные ответы модели вместо названия
const extractJSON = t => { const a = t.search(/[\[{]/); const b = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}')); if (a < 0 || b < a) throw new Error('JSON не найден'); return t.slice(a, b + 1); };

/* =====================================================================
   8. РАЗБОР БЛОКОВ ОТВЕТА НЕЙРОСЕТИ (текст с заголовками «СИТУАЦИЯ: …», а не JSON — так надёжнее)
   ===================================================================== */
const clean0 = t => String(t || '').replace(/```[a-z]*/gi, '').replace(/\*\*|__/g, '').replace(/^#+\s*/gm, '').replace(/\r/g, '');
export function parseBlocks(text, heads) {
  const t = clean0(text); const re = new RegExp('^[ \\t]*(' + heads.join('|') + ')[ \\t]*:[ \\t]*', 'gim'); const marks = []; let m;
  while ((m = re.exec(t))) marks.push({ h: m[1].toUpperCase().replace(/\s+/g, ' '), i: m.index, e: re.lastIndex });
  const out = {}; marks.forEach((k, n) => { out[k.h] = t.slice(k.e, n + 1 < marks.length ? marks[n + 1].i : t.length).trim(); });
  return out;
}
const bullets = x => String(x || '').split('\n').map(l => l.replace(/^\s*(?:[-•–—*]|\d+[.)])\s*/, '').trim()).filter(Boolean);
const oneLine = x => String(x || '').replace(/\s+/g, ' ').trim();
const safeText = t => !BANNED.slice(0, 2).some(r => r.test(yo(t))) && !hasMat(t);

/* Разбор промпта: какие приёмы в нём использованы, что улучшить, типичная ошибка, задание — по самому промпту, поэтому каждый день новое */
async function analyzePrompt(it) {
  const out = await retry(() => llm(`Ты — преподаватель по работе с нейросетями. Ниже промпт на русском языке. Разбери его для новичка.
Ответь СТРОГО в таком формате, без вступлений и пояснений:
ПРИЁМЫ:
- <приём и как он использован именно в этом промпте>
- <ещё приём>
(2–4 пункта: роль, аудитория, формат ответа, ограничения, примеры, пошаговость и т. п.)
УЛУЧШИТЬ: <одно конкретное улучшение>
ОШИБКА: <типичная ошибка при использовании такого промпта и как её избежать>
ЗАДАНИЕ: <упражнение на 5 минут: как адаптировать этот промпт под свою задачу>

ПРОМПТ «${it.title}»:
${it.text}`, 1500));
  const b = parseBlocks(out, ['ПРИЁМЫ', 'УЛУЧШИТЬ', 'ОШИБКА', 'ЗАДАНИЕ']);
  const a = { methods: bullets(b['ПРИЁМЫ']).slice(0, 4), improve: oneLine(b['УЛУЧШИТЬ']), mistake: oneLine(b['ОШИБКА']), task: oneLine(b['ЗАДАНИЕ']) };
  const all = [...a.methods, a.improve, a.mistake, a.task].join(' ');
  if (a.methods.length < 2 || a.improve.length < 15 || a.mistake.length < 15 || a.task.length < 15) throw new Error('разбор неполный');
  if (cyr(all) < 0.8 || !safeText(all)) throw new Error('разбор не прошёл проверку языка');
  return a;
}

/* =====================================================================
   9. УРОК ДНЯ ПО ГОДОВОЙ ПРОГРАММЕ. Тема берётся по дню года (360 тем), текст пишет нейросеть по строгому шаблону.
      Проверяем структуру, язык, отсутствие мата; ставим оценку quality (0–10). Через год повторяем только
      уроки с оценкой ≥ 8 (лучшие), остальные пишутся заново.
   ===================================================================== */
const lessonPrompt = t => `Ты — тренер по коммуникации. Составь мини-урок для аудитории 16+ на тему: «${t.topic}» (раздел курса: «${t.block}»).
Требования: живой разговорный русский; без мата, политики и оскорблений; ситуация и диалог бытовые и правдоподобные; в диалоге 6–10 реплик; разбор — 3–4 пункта, в каждом назван приём и объяснено, почему он работает; задание конкретное, выполнимое сегодня за 5–10 минут; вопросы открытые (начинаются с «Как», «Что», «Почему», «Расскажите…»).
Ответь СТРОГО в таком формате, без вступлений и пояснений:
СИТУАЦИЯ: <1–2 предложения>
ДИАЛОГ:
А: <реплика>
Б: <реплика>
(6–10 реплик по очереди)
РАЗБОР:
- <приём: почему он работает>
- <приём: почему он работает>
- <приём: почему он работает>
ЗАДАНИЕ: <одно конкретное задание на сегодня>
ВОПРОСЫ:
- <открытый вопрос 1>
- <открытый вопрос 2>
- <открытый вопрос 3>
ПРИВЫЧКА: <маленькое действие на 1–2 минуты>
ВЕЧЕРНИЙ ВОПРОС: <один вопрос для рефлексии вечером>`;
export function parseLesson(txt) {
  const b = parseBlocks(txt, ['СИТУАЦИЯ', 'ДИАЛОГ', 'РАЗБОР', 'ЗАДАНИЕ', 'ВОПРОСЫ', 'ПРИВЫЧКА', 'ВЕЧЕРНИЙ ВОПРОС']);
  const sit = oneLine(b['СИТУАЦИЯ']), dialog = bullets(b['ДИАЛОГ']), breakdown = bullets(b['РАЗБОР']).slice(0, 5), task = oneLine(b['ЗАДАНИЕ']);
  const questions = bullets(b['ВОПРОСЫ']).slice(0, 3), habit = oneLine(b['ПРИВЫЧКА']), evening = oneLine(b['ВЕЧЕРНИЙ ВОПРОС']);
  const all = [sit, ...dialog, ...breakdown, task, ...questions, habit, evening].join(' '); const errs = [];
  if (sit.length < 30 || sit.length > 450) errs.push('ситуация'); if (dialog.length < 5) errs.push('диалог'); if (breakdown.length < 3) errs.push('разбор');
  if (task.length < 20 || task.length > 320) errs.push('задание'); if (questions.length < 3) errs.push('вопросы'); if (habit.length < 10) errs.push('привычка'); if (evening.length < 10) errs.push('вечерний вопрос');
  if (cyr(all) < 0.85) errs.push('язык'); if (!safeText(all)) errs.push('запрещённые слова');
  let q = 0; if (dialog.length >= 6) q += 2; if (breakdown.length >= 3 && breakdown.length <= 5) q += 2; if (questions.length === 3 && questions.every(x => /\?$/.test(x))) q += 1;
  if (/\d|минут|секунд/.test(task)) q += 2; if (habit.length <= 140) q += 1; if (/\?$/.test(evening)) q += 1; if (sit.length >= 60) q += 1;
  return { ok: errs.length === 0, errs, lesson: { situation: sit, dialog: dialog.slice(0, 12), breakdown, task, questions, habit, evening, quality: q } };
}
async function readArchive(date) { try { return JSON.parse(await fs.readFile(path.join(ROOT, 'archive', date + '.json'), 'utf8')); } catch (e) { return null; } }
async function buildLesson() {
  const t = TOPICS[COURSE_DAY - 1];
  const prev = await readArchive((Number(TODAY.slice(0, 4)) - 1) + TODAY.slice(4)); // тот же день прошлого года
  if (prev && prev.lesson && prev.lesson.topic === t.topic && prev.lesson.quality >= 8) { report['lesson:повтор'] = 'год прошёл: берём лучший урок прошлого года (оценка ' + prev.lesson.quality + ')'; return { ...prev.lesson, reused: true }; }
  if (!HAS_LLM) throw new Error('для нового урока нужна нейросеть (GigaChat) — используется встроенная база');
  let best = null; const errs = [];
  for (let i = 0; i < 2; i++) {
    const r = parseLesson(await retry(() => llm(lessonPrompt(t), 2500)));
    if (r.ok) { if (!best || r.lesson.quality > best.quality) best = r.lesson; if (best.quality >= 8) break; } else errs.push(r.errs.join(','));
  }
  if (!best) throw new Error('урок не прошёл проверку (' + errs.join(' | ') + ')');
  report['lesson:оценка'] = String(best.quality);
  return { day: COURSE_DAY, of: TOPICS.length, block: t.block, topic: t.topic, ...best, source: LLM_NAME };
}

/* =====================================================================
   10. ТРЕК ДНЯ — Deezer (открытый API, без ключа). Берём чарты по жанрам (ротация), без нецензурных текстов,
       лучший по популярности из ещё не показанных.
   ===================================================================== */
const GENRE_RU = { Pop: 'поп', Rock: 'рок', Classical: 'классика', Jazz: 'джаз', 'Films/Games': 'музыка из фильмов и игр', Electro: 'электроника', Alternative: 'альтернатива', Folk: 'фолк', Country: 'кантри',
  Reggae: 'регги', 'Latin Music': 'латино', Dance: 'танцевальная', Blues: 'блюз', 'Soul & Funk': 'соул и фанк', Metal: 'метал', 'R&B': 'R&B' };
async function buildTracks(seen) {
  const gs = ((await getJSON('https://api.deezer.com/genre')).data || []).filter(g => GENRE_RU[g.name]);
  if (!gs.length) throw new Error('нет жанров');
  const genre = rot(gs, 1)[0];
  const j = await getJSON(`https://api.deezer.com/chart/${genre.id}/tracks?limit=100`);
  const all = (j.data || []).filter(t => t && t.title && t.artist && t.artist.name && !t.explicit_lyrics);
  const items = all.map(t => ({ k: jh(t.artist.name + ' ' + t.title), a: t.artist.name, t: t.title, mood: GENRE_RU[genre.name], rank: t.rank || 0, url: httpUrl(t.link) })).filter(x => !seen.has(x.k)).sort((a, b) => b.rank - a.rank);
  if (!items.length) throw new (all.length ? Exhausted : Error)('нет подходящих треков');
  return [items[0]];
}

/* =====================================================================
   СБОРКА
   ===================================================================== */
async function main() {
  const seen = await loadSeen();
  if (GIGA) { // заранее проверяем сертификат и вход в GigaChat, чтобы причина сбоя была видна в daily.json
    const ca = process.env.NODE_EXTRA_CA_CERTS;
    report['giga:cert'] = ca ? 'файл ' + (await fs.stat(ca).then(() => 'есть', () => 'НЕТ')) : 'не задан (шаг «Сертификат Минцифры» не сработал)';
    try { await retry(gigaToken, 2); report['giga:oauth'] = 'ok'; } catch (e) { gigaDown = true; report['giga:oauth'] = 'fail: ' + e.message; }
  }
  if (GIGA && gigaDown && KEY) { LLM_NAME = 'Claude'; report['llm'] = `GigaChat недоступен → работает Claude (${CLAUDE_MODEL})`; }
  else if (GIGA && !gigaDown) report['llm'] = 'GigaChat';
  else if (KEY) report['llm'] = `Claude (${CLAUDE_MODEL})`;
  /* Если новых материалов в источнике не осталось (прошёл год), повторяем лучшее из прошлых */
  const withReuse = (name, fn, fb = []) => step(name, async () => { try { return await fn(seen); } catch (e) { if (!(e instanceof Exhausted)) throw e; report[name + ':повтор'] = 'новых материалов не осталось — берём лучшее из прошлых'; return await fn(new Set()); } }, fb);
  const [quotes, news, prompts, words, books, films, tracks, humor, lesson] = await Promise.all([
    withReuse('quotes', buildQuotes), step('news', () => buildNews(seen), []), withReuse('prompts', buildPrompts), withReuse('word', buildWord), withReuse('books', buildBooks),
    withReuse('films', buildFilms), withReuse('tracks', buildTracks), step('humor', () => buildHumor(seen), { jokes: [], stories: [] }), step('lesson', () => buildLesson(), null)]);
  const out = { v: 2, date: TODAY, generated: new Date().toISOString(), sources: report,
    course: { day: COURSE_DAY, of: TOPICS.length },
    scoring: 'Цитаты: источник+длина+раздел; новости: вес источника+свежесть+совпадение тем; промпты: роль+длина+ограничения; книги и фильмы: оценка×ln(1+голоса); треки: популярность в чарте. Ничего не повторяется 365 дней.',
    lesson, quotes, news, prompts, words, books, films, tracks, jokes: humor.jokes, stories: humor.stories };
  await fs.mkdir(path.join(ROOT, 'archive'), { recursive: true });
  const s = JSON.stringify(out, null, 1);
  const arch = { ...out, jokes: out.jokes.map(j => ({ id: j.id, h: jh(j.t) })), stories: out.stories.map(j => ({ id: j.id, h: jh(j.t) })) }; // тексты анекдотов в архив не пишем
  await fs.writeFile(path.join(ROOT, 'daily.json'), s); await fs.writeFile(path.join(ROOT, 'archive', TODAY + '.json'), JSON.stringify(arch, null, 1));
  const okN = Object.values(report).filter(v => String(v).startsWith('ok')).length;
  console.log(`daily.json готов за ${TODAY}: источников ок ${okN}/${Object.keys(report).length}`); Object.entries(report).forEach(([k, v]) => console.log(' ', k, '→', v));
  /* Контроль состояния: предупреждения в Actions, сводная таблица в Summary */
  const feedRows = Object.entries(report).filter(([k]) => k.startsWith('feed:')), badFeeds = feedRows.filter(([, v]) => !String(v).startsWith('ok'));
  badFeeds.forEach(([k, v]) => console.log(`::warning title=Лента не отвечает::${k} — ${v}`));
  if (feedRows.length && badFeeds.length / feedRows.length > 0.4) console.log('::error title=Мало лент::Ответило меньше 60% лент — проверьте адреса в FEEDS');
  if (!lesson) console.log('::warning title=Нет урока дня::Урок не создан — в приложении будет встроенная база (повторяется)');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(report).map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '/')} |`).join('\n');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Подборка за ${TODAY} (день курса ${COURSE_DAY} из ${TOPICS.length})\n\n| Источник | Статус |\n|---|---|\n${rows}\n`);
  }
  /* Если не собралось вообще ничего — это ошибка сборки, чтобы Actions не публиковал пустой файл */
  if (![quotes, news, prompts, words, books].some(a => a.length) && !lesson) { console.error('Ни один источник не ответил'); process.exit(1); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
