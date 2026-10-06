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
import BLOCK from '../blocklist.js';       // тематический фильтр «без военного конфликта» (общий с приложением)
import { TOPICS } from './curriculum.mjs';
import { SLANG } from './slang.mjs';        // молодёжный сленг, новые и редкие слова
import { RU_DATES } from './ru-dates.mjs';  // календарь России: дни воинской славы, научные и памятные даты   // годовая программа: 360 тем
import { WORDS } from './words.mjs';
import { generateLessonV2 } from './lesson.mjs'; // урок дня v2: методика коуча-психолога, автопроверка и рецензент         // 490 слов для «Слова дня»
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* Режим черновика (02.10.2026): выпуск собирается заранее в папку OUT_DIR (preview/) и выходит на сайт только после одобрения владельца.
   Архив прошлых дней (для «без повторов») по-прежнему читается из корня archive/ — там только опубликованные выпуски */
const OUTD = process.env.OUT_DIR ? path.resolve(ROOT, process.env.OUT_DIR) : ROOT;
const DRAFT = !!process.env.DRAFT_MODE;                                      // черновик: новости не «освежаем» — что владелец проверил, то и выйдет
const MSK_MS = 3 * 3600e3;                                                   // Москва = UTC+3, без перехода на летнее время
const TODAY = process.env.BUILD_DATE || new Date(Date.now() + MSK_MS).toISOString().slice(0, 10); // «сегодня» — по Москве, а не по UTC
const mskHour = () => (process.env.MSK_HOUR != null ? Number(process.env.MSK_HOUR) : new Date(Date.now() + MSK_MS).getUTCHours());
const FORCE = !!process.env.FORCE_BUILD;                                     // ручной запуск: пересобрать всё заново
const NEWS_N = 8;                                                            // новостей в день: 4 «про Россию и науку» + 4 «про мир»
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
      (j.films || []).forEach(x => { seen.add(norm(x.t)); if (x.k) seen.add(x.k); }); (j.tracks || []).forEach(x => { if (x.k) seen.add(x.k); }); }
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
    if (/^(См\.|See |Смотрите|Смотри )/i.test(text) || /^в отдельн\w* категори/i.test(text)) continue; // указатель «смотри в другом месте» — не цитата
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
  cands.filter(q => !seen.has(norm(q.t)) && !q.doubtful && !BLOCK.test(q.t)).sort((a, b) => b.score - a.score || a.t.localeCompare(b.t)).forEach(q => { // цитаты с пометкой редакторов «неверная атрибуция» не берём; без источника — не больше одной за выпуск
    if (out.length < 4 && !used.has(q.a) && (q.hasSrc || !out.some(x => !x.hasSrc))) { used.add(q.a); out.push(q); } });
  out.sort((a, b) => (a.hasSrc ? 0 : 1) - (b.hasSrc ? 0 : 1)); // цитатой дня (первой) ставим цитату с указанным источником, «источник не указан» — только ниже
  if (!out.length && cands.length) throw new Exhausted('все найденные цитаты уже показывали');
  /* Портрет автора: только файлы с Викисклада (свободные лицензии), из статьи русской Википедии о человеке. Нет фото — цитата без картинки */
  await Promise.all(out.map(async q => {
    try {
      const sm = await getJSON('https://ru.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(q.a.replace(/ /g, '_')));
      const src = sm && sm.type === 'standard' && sm.thumbnail && sm.thumbnail.source;
      if (src && /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/[^\s"'<>]+$/.test(src)) q.img = { src, w: sm.thumbnail.width, h: sm.thumbnail.height };
    } catch (e) { /* без портрета */ }
  }));
  report['quotes:портреты'] = `${out.filter(q => q.img).length} из ${out.length}`;
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
  /* ══ НАУКА РОССИЙСКАЯ ══════════════════════════════════════════════════════════════════════
     N+1, Naked Science, Элементы — три лучших русскоязычных научпоп-издания. Почти никогда
     не пишут о военных конфликтах. РИА Наука и ТАСС Наука — тематические разделы крупных
     агентств: науку от политики там разделяет редакция, а не только наш фильтр.
     Коммерсантъ Наука — глубокие материалы об открытиях и технологиях.              */
  { n: 'N+1',             u: 'https://nplus1.ru/rss',                                        cat: 'наука',       w: 1.3, lang: 'ru' },
  { n: 'Naked Science',   u: 'https://naked-science.ru/feed',                                cat: 'наука',       w: 1.1, lang: 'ru' },
  { n: 'Элементы',        u: 'https://elementy.ru/rss/news',                                 cat: 'наука',       w: 1.1, lang: 'ru' },
  { n: 'РИА Наука',       u: 'https://ria.ru/export/rss2/science/index.xml',                 cat: 'наука',       w: 1.0, lang: 'ru' },
  { n: 'ТАСС Наука',      u: 'https://tass.ru/rss/v2.xml?sections=nauka',                    cat: 'наука',       w: 1.0, lang: 'ru' },
  { n: 'Коммерсант Наука',u: 'https://www.kommersant.ru/RSS/science.xml',                    cat: 'наука',       w: 0.9, lang: 'ru' },

  /* ══ ТЕХНОЛОГИИ И ИИ ════════════════════════════════════════════════════════════════════════
     Хабр AI и Хабр ML — профильные хабы на русском. Хабр Новости — общий поток.
     BBC Technology и Guardian Tech — лучшие мировые технологические разделы, почти без
     военного контента. Ars Technica — глубокий анализ технологий.                    */
  { n: 'Хабр ИИ',         u: 'https://habr.com/ru/rss/hub/artificial_intelligence/all/?fl=ru', cat: 'ИИ',        w: 1.2, lang: 'ru', aiTopic: true },
  { n: 'Хабр ML',         u: 'https://habr.com/ru/rss/hub/machine_learning/all/?fl=ru',      cat: 'ИИ',          w: 1.1, lang: 'ru', aiTopic: true },
  { n: 'Хабр',            u: 'https://habr.com/ru/rss/news/?fl=ru',                          cat: 'технологии',  w: 0.8, lang: 'ru' },
  { n: 'BBC Technology',  u: 'https://feeds.bbci.co.uk/news/technology/rss.xml',             cat: 'технологии',  w: 0.9, lang: 'en' },
  { n: 'Guardian Tech',   u: 'https://www.theguardian.com/technology/rss',                   cat: 'технологии',  w: 0.8, lang: 'en' },
  { n: 'Ars Technica',    u: 'https://feeds.arstechnica.com/arstechnica/index',              cat: 'технологии',  w: 0.9, lang: 'en' },

  /* ══ МИРОВАЯ НАУКА (английская, без политики) ══════════════════════════════════════════════
     Nature и Science News — рецензируемая наука. BBC Science — широкая аудитория.
     Guardian Science — понятно написанная наука от ведущих журналистов.               */
  { n: 'Nature',          u: 'https://www.nature.com/nature.rss',                            cat: 'наука',       w: 1.3, lang: 'en' },
  { n: 'Science News',    u: 'https://www.science.org/rss/news_current.xml',                 cat: 'наука',       w: 1.2, lang: 'en' },
  { n: 'BBC Science',     u: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',cat: 'наука',       w: 1.0, lang: 'en' },
  { n: 'Guardian Science',u: 'https://www.theguardian.com/science/rss',                      cat: 'наука',       w: 0.9, lang: 'en' },

  /* ══ РОССИЯ: КУЛЬТУРА, ОБЩЕСТВО, ЭКОНОМИКА ══════════════════════════════════════════════════
     РИА Культура и ТАСС Культура — события культуры и искусства.
     Коммерсантъ (общий) — деловое издание с глубокой аналитикой. РБК — экономика.
     Интерфакс — нейтральное информационное агентство.                                 */
  { n: 'РИА Культура',    u: 'https://ria.ru/export/rss2/culture/index.xml',                 cat: 'культура',    w: 1.0, lang: 'ru', big: true },
  { n: 'ТАСС Культура',   u: 'https://tass.ru/rss/v2.xml?sections=kultura',                  cat: 'культура',    w: 0.9, lang: 'ru', big: true },
  { n: 'Коммерсантъ',     u: 'https://www.kommersant.ru/RSS/news.xml',                       cat: 'новости',     w: 0.9, lang: 'ru', big: true },
  { n: 'РБК',             u: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss',            cat: 'экономика',   w: 0.8, lang: 'ru', big: true },
  { n: 'Интерфакс',       u: 'https://www.interfax.ru/rss.asp',                              cat: 'новости',     w: 0.9, lang: 'ru', big: true },

  /* ══ СПОРТ ══════════════════════════════════════════════════════════════════════════════════
     BBC Sport — нейтральный и без политики. ТАСС Спорт — российский спорт.           */
  { n: 'BBC Sport',       u: 'https://feeds.bbci.co.uk/sport/rss.xml',                       cat: 'спорт',       w: 0.7, lang: 'en' },
  { n: 'ТАСС Спорт',      u: 'https://tass.ru/rss/v2.xml?sections=sport',                    cat: 'спорт',       w: 0.7, lang: 'ru' },

  /* ══ УБРАНЫ: BBC World, Guardian World, Al Jazeera ══════════════════════════════════════════
     Причина: активно освещают военный конфликт — основной источник утечек 02.10.
     Замена: тематические разделы тех же доменов (наука, технологии, культура).       */
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
const DISCOVERY = /научн\w* открыти|открыти\w* (в области|учён|ученых|физик|астроном|биолог|химик|генетик)|(сделал|совершил)\w* открыти|учён|учен(ые|ых|ым|ыми|ого)|физик|химик[аиов]|биолог|астроном|генетик|изобрет|нобелев|прорыв в|искусственн\w* интеллект|нейросет|(^|[^а-яё])ии([^а-яё]|$)|архимед|ньютон|менделеев|радио|телескоп|космическ|квантов|днк|геном|вакцин|breakthrough|\bdiscover|\binvent(ed|ion|ions|or|ors)?\b|scientist|researchers|newton|archimedes|artificial intelligence|\bAI\b/i; // «открыт» отдельно НЕ берём: цепляет «открытая площадка», «открыли памятник»
const CLICKBAIT = /(^|[^а-яё])шок|сенсаци|не поверите|won't believe|you won.t believe/i;
/* Для новостей допускаем политику и ЧП, отсекаем откровенное, оскорбления по национальности и темы самоубийств */
const newsOk = t => { const x = yo(t); return !BANNED[0].test(x) && !BANNED[1].test(x) && !/суицид|самоубий|педофил/.test(x) && !BLOCK.test(t); };   // новости о военном конфликте не берём ни с какой стороны
async function buildNews(seen) {
  const all = [];
  await Promise.all(FEEDS.map(async f => { try { parseRss(await getTextAuto(f.u)).slice(0, f.big ? 30 : 15).forEach((x, idx) => all.push({ ...x, idx, big: !!f.big, title: x.title.split(' // ')[0].trim(), src: f.n, cat: f.cat, w: f.w, lang: f.lang })); report['feed:' + f.n] = 'ok'; } catch (e) { report['feed:' + f.n] = 'fail: ' + e.message; } }));
  const now = process.env.BUILD_DATE && !DRAFT ? Date.parse(TODAY + 'T12:00:00Z') : Date.now(); // свежесть считаем от реального момента сборки
  const pool = all.map(x => { const t = Date.parse(x.date); return { ...x, hrs: isNaN(t) ? 48 : Math.max(0, (now - t) / 36e5) }; })
    .filter(x => x.title && x.link && x.hrs <= 48 && newsOk(x.title + ' ' + x.desc + ' ' + x.link) && !seen.has(norm(x.title)));
  const tk = pool.map(x => toks(x.title));
  pool.forEach((x, i) => {
    const srcs = new Set(); pool.forEach((y, j) => { if (j !== i && y.src !== x.src) { let c = 0; tk[i].forEach(w => { if (tk[j].has(w)) c++; }); if (c >= 2) srcs.add(y.src); } });
    const txt = x.title + ' ' + x.desc, ru = RUSSIA.test(txt), dis = DISCOVERY.test(txt);
    x.tags = [...(ru ? ['Россия'] : []), ...(dis ? ['открытия и наука'] : [])];
    x.score = Math.round((x.w + 3 * (1 - Math.min(x.hrs, 72) / 72) + 2 * Math.min(srcs.size, 3) + (x.big && x.idx < 3 ? 1.5 - 0.5 * x.idx : 0) + (ru ? 3 : 0) + (dis ? 3 : 0) + (ru && dis ? 1 : 0) - (CLICKBAIT.test(x.title) ? 1.5 : 0)) * 100) / 100;
  });
  const sorted = pool.sort((a, b) => b.score - a.score);
  /* Пополам (ваш выбор): 3 новости про Россию и науку (есть тег «Россия» или «открытия и наука») + 3 про мир (без этих тегов).
     Если в одной группе не хватает кандидатов, добираем из другой. Не больше 2 из одного издания, дубли историй убираем. */
  const grp = x => (x.tags && x.tags.length ? 'A' : 'B');
  const choose = (cands, start = []) => {
    const res = [...start], per = {}, cnt = { A: 0, B: 0 };
    res.forEach(x => { per[x.src] = (per[x.src] || 0) + 1; cnt[grp(x)]++; });
    const tryAdd = (x, strict, cap) => {
      if (res.length >= NEWS_N || res.includes(x) || (per[x.src] || 0) >= cap || (strict && cnt[grp(x)] >= NEWS_N / 2)) return;
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
  /* Сначала промпты, полезные для общения, учёбы и работы (около 200 штук, хватает на полгода), затем остальные, кроме заведомо неподходящих */
  const USEFUL = /(coach|interview|negotiat|debate|speaker|speech|presentation|public speaking|resume|cover letter|career|mentor|teacher|tutor|essay|writing|writer|editor|proofread|summar|explain|study|motivat|therap|counsel|psycholog|relationship|dating|life|habit|productiv|email|feedback|critic|friend|persuasi|storytell|brainstorm|decision|strateg|marketing|sales|advis|consult|plan|learn|teach|socrat|philosoph|question)/i;
  const BAD = /(bibl|religio|astrolog|tarot|horoscope|dream|character|stand-?up|comedian|poet|rapper|song|lyric|gnomist|tic tac|unit|linux|terminal|console|sql|regex|excel|python|javascript|react|docker|midjourney|prompt generator|dan\b|jailbreak|emoji|translator|pirate|drunk|lunatic|riddle|chess|football|commentator|fancy title|movie|screenwriter|composer|novelist|cyber|fallacy|hypnot|spoken english|position interviewer|plagiar|chinese|turkish|japanese|korean|arabic|spanish|french|german|hindi|english language|to english|inner desire|erotic|summar|fitness|workout|app development|design|generator)/i;
  const CORE = /coach|interview|negotiat|debate|speak|speech|relationship|friend|feedback|persuasi|counsel|therap|mentor|motivat|socrat|philosoph|life|habit|decision/i; // ближе всего к теме приложения — вперёд
  const usefulAll = ranked.filter(x => USEFUL.test(x.title) && !BAD.test(x.title)), good = [...usefulAll.filter(x => CORE.test(x.title)), ...usefulAll.filter(x => !CORE.test(x.title))], rest = ranked.filter(x => !BAD.test(x.title) && !good.includes(x));
  const fresh = [...good, ...rest].filter(x => !seen.has(x.id)); // каждый день — лучший из ещё не показанных; повтор только когда каталог исчерпан
  if (!fresh.length) throw new Exhausted('все промпты каталога уже показывали');
  if (!HAS_LLM) throw new Error('английский промпт не показываем: нужен перевод (ключ GigaChat) — блок скрыт, остаётся русская библиотека');
  const errs = []; let item = null;
  for (const x of fresh.slice(0, 3)) {                      // берём первый, который удалось перевести (переменные и заголовок проверяются)
    const tr = (await toRussian([{ title: x.title, text: x.text }], 'prompt')); errs.push(...tr.errors);
    if (tr[0] && cyr(tr[0].title) >= 0.5 && cyr(tr[0].text.replace(/\$\{[^}]*\}|\{\{[^}]*\}\}/g, '')) >= 0.4) { item = { id: x.id, cat: 'каталог', title: tr[0].title, text: tr[0].text, src: 'Awesome ChatGPT Prompts (CC0), перевод: ' + LLM_NAME, lang: 'ru', score: x.score }; break; }
  }
  report['prompts:translate'] = item ? 'переведён' : 'не удалось' + (errs[0] ? ' (' + errs[0] + ')' : '');
  if (!item) throw new Error('английский промпт не показываем: перевод не удался — блок скрыт, остаётся русская библиотека');
  try { item.analysis = await analyzePrompt(item); report['prompts:analysis'] = 'ok'; } catch (e) { report['prompts:analysis'] = 'fail: ' + e.message; }
  try { item.aiNews = await fetchAiNews(); report['prompts:ai-news'] = 'ok'; } catch (e) { report['prompts:ai-news'] = 'fail: ' + e.message; }
  try { item.termOfDay = await makeTermOfDay(item); report['prompts:term'] = 'ok'; } catch (e) { report['prompts:term'] = 'fail: ' + e.message; }
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
  /* Пример употребления из Викисловаря (строка «#* {{пример|…}}») — если есть и он по-русски */
  const exLine = sec('Значение').split('\n').find(l => /^#\*/.test(l));
  let ex = '';
  if (exLine) { const mm = exLine.match(/\{\{пример\|(?:текст=)?([^|}]+)/); ex = tidy(wikiClean(mm ? mm[1] : exLine.replace(/^#\*\s*/, ''))); if (ex.length < 12 || ex.length > 220 || /[{}]/.test(ex) || cyr(ex) < 0.6) ex = ''; }
  return { m: clip(meanings.slice(0, 2).join('; '), 240), e: et.length > 12 ? clip(et, 240) : '', ex };
}
async function wiktWord(w) {
  const j = await getJSON(`https://ru.wiktionary.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(w)}`);
  const pg = j.query.pages[0]; if (pg.missing) return { why: w + ': нет статьи' };
  const r = parseWikt(pg.revisions[0].slots.main.content);
  return r ? { r } : { why: w + ': не найден раздел «Значение»' };
}
/* Сначала — молодёжный сленг, новые и редкие слова (slang.mjs); если за 15 попыток не нашлось статьи — классические слова (words.mjs) */
async function buildWord(seen) {
  const why = []; let tried = 0, allSeen = true;
  const pools = [SLANG.map(([w, tag]) => [w, tag]), WORDS.map(w => [w, ''])];
  for (const pool of pools) {
    tried = 0;
    for (let n = 0; n < pool.length && tried < 15; n++) {
      const [w, tag] = pool[(DAY_OF_YEAR * 7 + n) % pool.length];      // каждый день начинаем с другого места списка
      if (seen.has(norm(w))) { why.push(w + ': уже было'); continue; }
      allSeen = false; tried++;
      try { const x = await wiktWord(w); if (x.why) { why.push(x.why); continue; }
        return [{ w: w[0].toUpperCase() + w.slice(1), tag, m: x.r.m, e: x.r.e, ex: x.r.ex || '', src: 'Викисловарь (CC BY-SA)', url: 'https://ru.wiktionary.org/wiki/' + encodeURIComponent(w) }];
      } catch (e) { why.push(w + ': ' + e.message); }
    }
  }
  if (allSeen) throw new Exhausted('весь список слов уже показывали');
  throw new Error('слово не разобрано (' + why.slice(-6).join('; ') + ')'); // причина видна в daily.json → sources.word
}

/* =====================================================================
   5. КНИГИ — Open Library. Рейтинг = средняя оценка × ln(1 + число оценок). Минимум 5 оценок.
   ===================================================================== */
const SUBJECTS = ['science', 'physics', 'artificial intelligence', 'mathematics', 'history of science', 'communication', 'psychology', 'philosophy', 'biography', 'business'];
export async function realPublishYear(workUrl, fallback) {
  try {
    const key = (workUrl.match(/\/works\/(OL\w+W)/) || [])[1]; if (!key) return fallback;
    const ed = await getJSON(`https://openlibrary.org/works/${key}/editions.json?limit=50`);
    const years = (ed.entries || []).map(e => { const m = String(e.publish_date || '').match(/(1[4-9]\d{2}|20\d{2})/); return m ? +m[1] : null; }).filter(Boolean);
    return years.length ? Math.min(...years) : fallback;
  } catch (e) { return fallback; }
}
async function buildBooks(seen) {
  const subj = rot(SUBJECTS, 1)[0]; let docs = [], lg = 'rus';
  for (const lang of ['rus', 'eng']) { const j = await getJSON(`https://openlibrary.org/search.json?q=${encodeURIComponent(`subject:"${subj}" language:${lang}`)}&sort=rating&limit=30&fields=key,title,author_name,first_publish_year,ratings_average,ratings_count`);
    docs = (j.docs || []).filter(d => d.ratings_count >= 5 && d.ratings_average); if (docs.length) { lg = lang; break; } }
  const ranked = docs.map(d => ({ t: d.title, a: (d.author_name || ['—'])[0], y: d.first_publish_year, rating: Math.round(d.ratings_average * 100) / 100, count: d.ratings_count, url: 'https://openlibrary.org' + d.key,
    score: Math.round(d.ratings_average * Math.log(1 + d.ratings_count) * 100) / 100, why: '', olKey: d.key })).filter(b => !seen.has(norm(b.t)) && !seen.has(b.url)).sort((a, b) => b.score - a.score);
  if (!ranked.length) throw new (docs.length ? Exhausted : Error)('нет подходящих книг');
  /* Сначала книги, у которых название уже по-русски; название и имя автора должны быть кириллицей (иначе переводим/транслитерируем) */
  const ordered = [...ranked.filter(b => cyr(b.t) >= 0.5), ...ranked.filter(b => cyr(b.t) < 0.5)].slice(0, 30);
  for (const b of rot(ordered, 3)) {
    let t = b.t, a = b.a, orig = '';
    if (cyr(t) < 0.5 || cyr(a) < 0.5) {
      if (!HAS_LLM) continue;
      const tr = await toRussian([{ title: t, text: a }], 'book'); if (!tr[0]) continue;
      if (cyr(t) < 0.5) { if (cyr(tr[0].title) < 0.5) continue; orig = t; t = tr[0].title; }
      if (cyr(a) < 0.5) { if (cyr(tr[0].text) >= 0.5) a = tr[0].text.replace(/\s*\([^)]*\)\s*$/, ''); else continue; } // убираем «(альтернативное имя)», если модель его добавила
    }
    const y = await realPublishYear(b.url, b.y); // год у самого «произведения» в Open Library иногда испорчен; берём минимальный год из реальных изданий
    /* Краткое описание книги: Open Library → GigaChat */
    if (!b.why) {
      try { const olj = await getJSON('https://openlibrary.org' + (b.olKey||'/works/X') + '.json').catch(()=>({}));
        const desc = olj.description && (typeof olj.description === 'string' ? olj.description : (olj.description||{}).value);
        if (desc && desc.length > 40) b.why = clip(oneLine(desc), 260); } catch(e) {}
    }
    if (!b.why && HAS_LLM && b.t && b.a) {
      try { const braw = await retry(() => llm('Опиши книгу «' + b.t + '» (автор: ' + b.a + (b.y ? ', ' + b.y + ' г.' : '') + ') в 2–3 предложениях: о чём она и почему стоит прочитать. Только текст без вступлений, до 220 знаков.', 280, 0.3));
        if (braw && braw.length > 30 && safeText(braw)) b.why = clip(oneLine(braw), 240); } catch(e) {}
    }
    return [{ ...b, t, a, y, ...(orig ? { orig } : {}) }];
  }
  throw new Error('у лучших книг нет русского названия или имени автора, а перевод недоступен — остаётся русская база');
}

/* =====================================================================
   6. ФИЛЬМЫ — TMDB (нужен бесплатный ключ TMDB_API_KEY). Рейтинг = оценка × ln(1 + голосов).
   ===================================================================== */
async function buildTMDB(seen) {
  if (!TMDB) throw new Error('ключ TMDB_API_KEY не задан — раздел остаётся на локальной базе');
  const call = async path => { try { return await getJSON(`https://api.themoviedb.org/3/${path}${path.includes('?') ? '&' : '?'}api_key=${TMDB}`); }
    catch (e) { throw new Error(/40[13]/.test(e.message) ? 'TMDB отклонил ключ (' + e.message + '): нужен «API Key» (v3), а не «Read Access Token»' : e.message); } };
  const [j, gl] = await Promise.all([call(`movie/top_rated?language=ru-RU&page=${1 + (DAYNUM % 100)}`), call('genre/movie/list?language=ru').catch(() => ({ genres: [] }))]);
  const gname = new Map((gl.genres || []).map(g => [g.id, String(g.name || '').toLowerCase()]));
  const r = (j.results || []).filter(m => m.overview && m.vote_count > 500 && !m.adult && !seen.has('tm' + m.id) && !seen.has(norm(m.title)))
    .map(m => ({ k: 'tm' + m.id, t: m.title, orig: m.original_title && m.original_title !== m.title ? m.original_title : '', y: (m.release_date || '').slice(0, 4),
      g: (m.genre_ids || []).map(id => gname.get(id)).filter(Boolean).slice(0, 3).join(', '), rating: m.vote_average, count: m.vote_count,
      why: clip(m.overview, 240), url: 'https://www.themoviedb.org/movie/' + m.id, src: 'TMDB', rsrc: 'TMDB', kind: 'movie',
      score: Math.round(m.vote_average * Math.log(1 + m.vote_count) * 100) / 100 })).sort((a, b) => b.score - a.score);
  if (!r.length) throw new (j.results && j.results.length ? Exhausted : Error)('нет фильмов');
  return r.slice(0, 1);
}

/* =====================================================================
   6б. ФИЛЬМ ИЛИ СЕРИАЛ ДНЯ без ключей и без расхода токенов нейросети:
       TVmaze (открытый API: рейтинг, жанры, IMDb-номер) + Викиданные и русская Википедия (русское название и описание).
       Рейтинг = оценка × (1 + популярность/100); берём лучшее из ещё не показанных. Только сериалы, у которых есть
       статья в русской Википедии (значит, значимые и с русским описанием). Если задан TMDB_API_KEY — берём фильмы оттуда.
   ===================================================================== */
const TV_GENRE_RU = { Drama: 'драма', Comedy: 'комедия', Action: 'боевик', Adventure: 'приключения', 'Science-Fiction': 'научная фантастика', Crime: 'криминал', Thriller: 'триллер', Mystery: 'детектив',
  Fantasy: 'фэнтези', Horror: 'ужасы', Romance: 'мелодрама', Family: 'семейный', Anime: 'аниме', History: 'история', War: 'военный', Western: 'вестерн', Music: 'музыка', Medical: 'медицина',
  Legal: 'юридический', Sports: 'спорт', Espionage: 'шпионский', Supernatural: 'мистика', Nature: 'природа', Food: 'кулинария', Travel: 'путешествия' };
const TV_SKIP_TYPES = /reality|talk|game|news|sports|variety|panel|award/i;
async function buildSeries(seen) {
  const shows = [];
  for (const k of [0, 1, 2]) { try { const j = await getJSON(`https://api.tvmaze.com/shows?page=${(DAY_OF_YEAR * 3 + k) % 240}`); if (Array.isArray(j)) shows.push(...j); } catch (e) { /* конец списка или сбой одной страницы */ } }
  if (!shows.length) throw new Error('TVmaze не ответил');
  const good = shows.filter(x => x && x.rating && x.rating.average >= 8 && (x.weight || 0) >= 50 && x.externals && /^tt\d+$/.test(x.externals.imdb || '') && !TV_SKIP_TYPES.test(x.type || '') && !(x.genres || []).includes('Adult'))
    .map(x => ({ k: 'tv' + x.id, name: x.name, y: (x.premiered || '').slice(0, 4), g: (x.genres || []).map(z => TV_GENRE_RU[z]).filter(Boolean).slice(0, 3).join(', '), rating: x.rating.average, imdb: x.externals.imdb,
      score: Math.round(x.rating.average * (1 + (x.weight || 0) / 100) * 100) / 100 }));
  const fresh = good.filter(x => !seen.has(x.k)).sort((a, b) => b.score - a.score);
  if (!fresh.length) throw new (good.length ? Exhausted : Error)('нет подходящих сериалов');
  const top = fresh.slice(0, 12);
  /* русские названия и ссылки на статьи — одним запросом к Викиданным */
  const q = `SELECT ?imdb ?label ?ruwiki WHERE { VALUES ?imdb { ${top.map(x => `"${x.imdb}"`).join(' ')} } ?item wdt:P345 ?imdb . OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) = "ru") } OPTIONAL { ?ruwiki schema:about ?item ; schema:isPartOf <https://ru.wikipedia.org/> } }`;
  const wd = await getJSON('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q));
  const map = new Map(); ((wd.results && wd.results.bindings) || []).forEach(b => { if (b.ruwiki && b.imdb) map.set(b.imdb.value, { label: b.label && b.label.value, wiki: b.ruwiki.value }); });
  const best = top.find(x => map.has(x.imdb)); if (!best) throw new Error('у лучших сериалов нет статьи в русской Википедии');
  const w = map.get(best.imdb), wtitle = decodeURIComponent((w.wiki.split('/wiki/')[1] || '')).replace(/_/g, ' ');
  let why = ''; try { const sm = await getJSON('https://ru.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(wtitle.replace(/ /g, '_'))); why = clip(oneLine(sm.extract || ''), 240); } catch (e) { /* без описания тоже можно */ }
  return [{ k: best.k, t: w.label || wtitle, orig: best.name, y: best.y, g: best.g, rating: best.rating, why, url: httpUrl(w.wiki), imdb: best.imdb, src: 'TVmaze, Википедия (CC BY-SA)', rsrc: 'TVmaze', kind: 'series', score: best.score }];
}
/* =====================================================================
   6в. ФИЛЬМ ИЛИ СЕРИАЛ ДНЯ — основной источник без ключей:
       • каталог Cinemeta (официальный публичный сервис Stremio): фильмы и сериалы по годам, рейтинг IMDb, жанры;
       • Викиданные: русское название, номер на Кинопоиске, ссылка на статью в русской Википедии;
       • rating.kinopoisk.ru/{id}.xml — открытый экспорт рейтингов: оценка Кинопоиска и IMDb с числом голосов;
       • русская Википедия — описание.
       Каждый день берётся другой год (1950–2025 для фильмов), из него — лучший по «оценка × ln(голоса)» из ещё не показанных.
       2 дня из 3 — фильм, каждый 4-й день — сериал. Запасные источники по порядку: TMDB (если есть ключ) и TVmaze (сериалы).
   ===================================================================== */
const CM_GENRE_RU = { Action: 'боевик', Adventure: 'приключения', Animation: 'мультфильм', Biography: 'биография', Comedy: 'комедия', Crime: 'криминал', Documentary: 'документальный', Drama: 'драма',
  Family: 'семейный', Fantasy: 'фэнтези', History: 'история', Horror: 'ужасы', Mystery: 'детектив', Romance: 'мелодрама', 'Sci-Fi': 'фантастика', Sport: 'спорт', Thriller: 'триллер', War: 'военный',
  Western: 'вестерн', Music: 'музыка', Musical: 'мюзикл' };
const CM_SKIP = /sex|porn|erotic|nude|xxx|секс|порно|эрот/i;   // откровенное не берём (в каталоге бывают названия с такими словами)
async function kpRating(id) {                                  // открытый XML Кинопоиска (в кодировке windows-1251)
  const xml = await getTextAuto(`https://rating.kinopoisk.ru/${id}.xml`);
  const kp = xml.match(/<kp_rating num_vote="(\d+)">([\d.]+)</), im = xml.match(/<imdb_rating num_vote="(\d+)">([\d.]+)</);
  return { kp: kp ? { r: +kp[2], n: +kp[1] } : null, imdb: im ? { r: +im[2], n: +im[1] } : null };
}
async function ruInfo(ids) {                                   // русские названия, статьи и номера Кинопоиска — одним запросом к Викиданным
  const q = `SELECT ?imdb ?label ?desc ?ruwiki ?kp WHERE { VALUES ?imdb { ${ids.map(x => `"${x}"`).join(' ')} } ?item wdt:P345 ?imdb . OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) = "ru") } OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "ru") } OPTIONAL { ?ruwiki schema:about ?item ; schema:isPartOf <https://ru.wikipedia.org/> } OPTIONAL { ?item wdt:P2603 ?kp } }`;
  const wd = await getJSON('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q)); const m = new Map();
  ((wd.results && wd.results.bindings) || []).forEach(b => { if (!b.imdb) return; const cur = m.get(b.imdb.value) || {};
    m.set(b.imdb.value, { label: cur.label || (b.label && b.label.value), desc: cur.desc || (b.desc && b.desc.value), wiki: cur.wiki || (b.ruwiki && b.ruwiki.value), kp: cur.kp || (b.kp && /^\d+$/.test(b.kp.value) ? b.kp.value : '') }); });
  return m;
}
async function ruSummary(wikiUrl) {
  const title = decodeURIComponent((wikiUrl.split('/wiki/')[1] || '')).replace(/ /g, '_'); if (!title) return '';
  try { const sm = await getJSON('https://ru.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title)); const t = clip(oneLine(sm.extract || ''), 240); if (t) return t; } catch (e) { /* пробуем запасной способ */ }
  try { const j = await getJSON('https://ru.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&formatversion=2&titles=' + encodeURIComponent(title.replace(/_/g, ' ')));
    return clip(oneLine((((j.query || {}).pages || [])[0] || {}).extract || ''), 240); } catch (e) { return ''; }
}
async function buildCinemeta(seen) {
  const type = DAY_OF_YEAR % 4 === 0 ? 'series' : 'movie', minY = type === 'series' ? 1975 : 1950, span = 2025 - minY + 1;
  let exhausted = false, lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {           // если в этом году подходящих нет — берём другой год
    const year = 2025 - ((DAY_OF_YEAR * 11 + attempt * 17) % span);
    let metas; try { metas = ((await getJSON(`https://v3-cinemeta.strem.io/catalog/${type}/year/genre=${year}.json`)).metas) || []; } catch (e) { lastErr = e.message; continue; }
    const cands = metas.filter(m => m && /^tt\d+$/.test(m.imdb_id || m.id || '') && m.name && +m.imdbRating >= 7.4 && !CM_SKIP.test(m.name + ' ' + (m.description || '')) && !(m.genres || m.genre || []).some(g => /reality|talk|game/i.test(g)))
      .map(m => ({ k: m.imdb_id || m.id, name: m.name, y: String(m.year || m.releaseInfo || year).slice(0, 4), imdbR: +m.imdbRating, g: (m.genres || m.genre || []).map(z => CM_GENRE_RU[z]).filter(Boolean).slice(0, 3).join(', ') }))
      .sort((a, b) => b.imdbR - a.imdbR);
    const fresh = cands.filter(x => !seen.has(x.k));
    if (cands.length && !fresh.length) { exhausted = true; continue; }
    if (!fresh.length) continue;
    const top = fresh.slice(0, 12), info = await ruInfo(top.map(x => x.k)), ru = top.filter(x => info.has(x.k) && info.get(x.k).wiki).slice(0, 5); // только с русской статьёй
    if (!ru.length) { lastErr = 'у лучших нет статьи в русской Википедии'; continue; }
    const scored = [];
    for (const x of ru) {
      const i = info.get(x.k); let r = null; if (i.kp) { try { r = await kpRating(i.kp); } catch (e) { r = null; } }
      const kp = r && r.kp && r.kp.n >= 10000 ? r.kp : null, im = r && r.imdb && r.imdb.n >= 20000 ? r.imdb : null;
      const main = kp ? { r: kp.r, n: kp.n, src: 'Кинопоиск' } : im ? { r: im.r, n: im.n, src: 'IMDb' } : { r: x.imdbR, n: 0, src: 'IMDb' };
      scored.push({ x, i, main, im: r && r.imdb, score: main.n ? main.r * Math.log(1 + main.n) : main.r * 4 });
    }
    scored.sort((a, b) => b.score - a.score); const w = scored[0];
    const wtitle = decodeURIComponent((w.i.wiki.split('/wiki/')[1] || '')).replace(/_/g, ' ');
    return [{ k: w.x.k, t: w.i.label || wtitle, orig: w.x.name, y: w.x.y, g: w.x.g, rating: w.main.r, count: w.main.n || undefined, rsrc: w.main.src,
      imdbRating: w.im ? w.im.r : w.x.imdbR, imdbVotes: w.im ? w.im.n : undefined, kpId: w.i.kp || undefined, imdb: w.x.k, kind: type,
      why: (await ruSummary(w.i.wiki)) || (w.i.desc ? w.i.desc[0].toUpperCase() + w.i.desc.slice(1) + '.' : ''), url: httpUrl(w.i.wiki), src: 'Cinemeta, Кинопоиск, Википедия (CC BY-SA)', score: Math.round(w.score * 100) / 100 }];
  }
  throw new (exhausted ? Exhausted : Error)('нет подходящих в каталоге Cinemeta' + (lastErr ? ' (' + lastErr + ')' : ''));
}
/* Порядок источников: Cinemeta+Кинопоиск → TMDB (если есть ключ) → TVmaze (сериалы). В отчёте — какой сработал */
async function buildFilms(seen) {
  const chain = [['Cinemeta', buildCinemeta], ...(TMDB ? [['TMDB', buildTMDB]] : []), ['TVmaze', buildSeries]]; const errs = []; let exhausted = false;
  for (const [name, fn] of chain) { try { const r = await fn(seen); if (r && r.length) { report['films:источник'] = name; return r; } } catch (e) { if (e instanceof Exhausted) exhausted = true; errs.push(name + ': ' + e.message); } }
  throw new (exhausted ? Exhausted : Error)(errs.join(' | '));
}

/* =====================================================================
   6г. ВЕЛИКИЕ СОБЫТИЯ ДНЯ. Собираем на сервере из нескольких источников и выбираем по «известности»:
   • календарь России (ru-dates.mjs): дни воинской славы по ФЗ № 32-ФЗ, научные и памятные даты — всегда первыми;
   • Википедия «В этот день»: избранное + все события + праздники + родились и ушли;
   • известность = число языковых разделов Википедии у статьи (Викиданные): Гагарин, Менделеев, Куликовская битва
     есть в десятках и сотнях языков, мелкие сюжеты — в единицах. Так «побег фигуристов» проигрывает изобретению радио.
   ===================================================================== */
const YEAR_PAGE = /^\d{3,4}(\s*(год|до\s*н\.?\s*э\.?))?$/i;   // страница-заглушка «1981 год» — это не статья о событии
const EV_SCIENCE = /открыл|открыти|изобр[её]л|изобретен|теори|доказал|впервые|первый (полёт|полет|спутник|искусственн)|космос|космическ|орбит|спутник|телескоп|вакцин|антибиотик|пенициллин|днк|рентген|электричеств|радио|телефон|телеграф|паровоз|автомобил|самол[её]т|аэроплан|компьютер|интернет|периодическ|нобелевск|атом|ядерн|лазер|транзистор|учёный|ученый|академи|университет|институт|лаборатор/i;
const EV_AI = /искусственн.{0,15}интеллект|нейросет|языков.{0,10}модел|GPT|ChatGPT|нейронн.{0,10}сет|машинн.{0,10}обучен|deep.{0,5}learning|алгоритм.{0,15}(обучен|распознав|генератив)|робот.{0,10}(обуч|интеллект|разум)|Тьюринг|AlphaGo|DeepMind|OpenAI|Anthropic|Яндекс.{0,10}(GPT|ИИ)|Siri|ChatGPT|трансформер|LLM/i; // рубрика «ии» из ru-dates.mjs и события с ИИ-тематикой
const EV_HISTORY = /завоеван|восстани|высадил|мятеж|осад|битв|сражени|победа|победил|капитуляц|основан|основал|провозгласил|независимост|коронова|венчан|крещени|принял христианств|объединени|революци|штурм|договор|конституци|манифест|отменил|освобожден|окончани|завершилась/i;
const EV_MINOR = /запросил.{0,15}убежищ|попросил.{0,15}убежищ|эмигрировал|развел|развёл|женил|вышла замуж|арестован|задержан|уволен|отправлен в отставку|назначен|матч|чемпионат|дебют|альбом|сингл|скончал|умер|перелёт.{0,30}(рекорд|беспосадочн)|представил процесс|изготовлен(ие|ия) .{0,20}(вод|напит|пив|шампан)|тонула|затонула подводн|в районе .{0,30}(океан|море|остров)|захвачен|освобождён из плен|бежал из|основал компани|основал фирм|выпустил книг|опубликовал статью(?!.{0,30}(ДНК|теори|периодич|относительн|квант))|патент|открыл магазин|открыл ресторан/i;
// Штраф теперь снимается только если событие при этом имеет высокий fame (мировая известность по Викиданным) — см. score()
const PERSON_DESC = /учён|учен|физик|хим|биолог|математик|астроном|изобретател|врач|медик|инженер|конструктор|космонавт|естествоиспытател|философ|географ|путешественник|лётчик|летчик|педагог|писател|поэт|композитор|художник|архитектор|полководец|адмирал|император|царь|князь|государствен|основател/i;

async function fameOf(qids) {   // число языковых разделов Википедии у статьи — из Викиданных (один-два быстрых запроса)
  const out = new Map(), ids = [...new Set(qids.filter(q => /^Q\d+$/.test(q || '')))];
  for (let i = 0; i < ids.length; i += 70) {
    const q = `SELECT ?q ?n WHERE { VALUES ?q { ${ids.slice(i, i + 70).map(x => 'wd:' + x).join(' ')} } ?q wikibase:sitelinks ?n }`;
    const j = await getJSON('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q));
    ((j.results && j.results.bindings) || []).forEach(b => out.set(b.q.value.split('/').pop(), Number(b.n.value)));
  }
  return out;
}
async function qidsByTitle(titles) {   // запасной путь, если у страницы нет wikibase_item
  const out = new Map(), uniq = [...new Set(titles)];
  for (let i = 0; i < uniq.length; i += 40) {
    const j = await getJSON('https://ru.wikipedia.org/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item&redirects=1&format=json&formatversion=2&titles=' + encodeURIComponent(uniq.slice(i, i + 40).join('|')));
    ((j.query && j.query.pages) || []).forEach(pg => { if (pg.pageprops && pg.pageprops.wikibase_item) out.set(String(pg.title).replace(/_/g, ' '), pg.pageprops.wikibase_item); });
  }
  return out;
}
const commonsImg = p => { const u = p && p.thumbnail && p.thumbnail.source; return /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\//.test(u || '') ? u : ''; }; // только свободные файлы Викисклада
const sameStory = (a, b) => { const A = toks(a), B = toks(b); let n = 0; A.forEach(w => { if (B.has(w)) n++; }); return n >= 3; };

async function buildEvents() {
  const key = TODAY.slice(5), [mm, dd] = key.split('-'), stat = RU_DATES[key] || [];
  let wp = {};
  try { wp = await getJSON(`https://ru.wikipedia.org/api/rest_v1/feed/onthisday/all/${mm}/${dd}`); report['events:википедия'] = 'ok'; }
  catch (e) { report['events:википедия'] = 'fail: ' + e.message; }
  const normT = t => String(t || '').replace(/_/g, ' ').trim();
  const pageOf = e => (e.pages || []).find(pg => pg && pg.title && !YEAR_PAGE.test(normT(pg.title))) || (e.pages || [])[0] || {};
  const seenKeys = new Set(), cands = [];
  const push = (e, from) => { if (!e || !e.text || !e.year) return; const k = e.year + '|' + String(e.text).slice(0, 40); if (seenKeys.has(k)) return; seenKeys.add(k); cands.push({ e, from, p: pageOf(e) }); };
  (wp.selected || []).forEach(e => push(e, 'selected')); (wp.events || []).forEach(e => push(e, 'events'));
  const people = [...(wp.births || []).map(e => ({ e, kind: 'родился' })), ...(wp.deaths || []).map(e => ({ e, kind: 'умер' }))].filter(x => x.e && x.e.text && x.e.year).map(x => ({ ...x, p: pageOf(x.e) }));
  const holWp = (wp.holidays || []).filter(h => h && h.text);
  /* известность */
  const allPages = [...cands.map(c => c.p), ...people.map(x => x.p)];
  const byTitle = new Map();
  const noQ = allPages.filter(pg => pg.title && !pg.wikibase_item).map(pg => normT(pg.title));
  if (noQ.length) { try { (await qidsByTitle(noQ)).forEach((q, t) => byTitle.set(t, q)); } catch (e) { /* ок: останемся с тем, что есть */ } }
  const qidOf = pg => pg.wikibase_item || byTitle.get(normT(pg.title)) || '';
  let fame = new Map(), fameOk = true;
  try { fame = await fameOf(allPages.map(qidOf)); } catch (e) { fameOk = false; report['events:известность'] = 'нет данных (' + e.message + '): ранжирование по ключевым словам'; }
  if (fameOk) report['events:известность'] = `Викиданные, статей с оценкой: ${fame.size}`;
  const fameP = pg => fame.get(qidOf(pg)) || 0;
  const txtOf = c => c.e.text + ' ' + (c.p.extract || '');
  const catOf = (t, k) => k === 'ии' || EV_AI.test(t) ? 'ии' : (EV_SCIENCE.test(t) || k === 'наука') ? 'наука' : EV_HISTORY.test(t) ? 'история' : 'событие';
  const score = c => { const t = txtOf(c);
    return 10 * Math.log10(1 + fameP(c.p))
      + (c.from === 'selected' ? 4 : 0)
      + (EV_SCIENCE.test(t) ? 3 : 0)
      + (EV_AI.test(t) || (c.rd && c.rd.k === 'ии') ? 3 : 0)
      + (EV_HISTORY.test(t) ? 3 : 0)
      + (RUSSIA.test(t) ? 2 : 0)
      - (EV_MINOR.test(c.e.text) && fameP(c.p) < 50 ? 10 : 0)  // мелкие события с низкой известностью выбрасываются; очень известные (> 50 языков) — оставляем
      - (YEAR_PAGE.test(normT(c.p.title)) ? 15 : 0)              // страница-заглушка «1790 год» вместо статьи = жёсткий штраф
      - (!c.p.extract || c.p.extract.length < 80 ? 5 : 0)        // нет описания = событие незначимое
      + Math.min((c.e.pages || []).length, 5) * 0.3; };
  const ranked = cands.filter(c => !BLOCK.core(txtOf(c))).map(c => ({ c, s: score(c), cat: catOf(txtOf(c)) })).sort((a, b) => b.s - a.s);
  /* основной список: сначала записи календаря России, дальше — самые известные, не больше двух из одной рубрики */
  const main = stat.filter(x => x.y).map(x => ({ y: x.y, d: dd + '.' + mm, t: x.t, cat: x.k, glory: !!x.glory, src: 'Календарь России' }));
  const perCat = {}; main.forEach(x => { perCat[x.cat] = (perCat[x.cat] || 0) + 1; });
  // Минимальный порог: событие должно быть известно хоть немного (есть описание) ИЛИ быть из «selected» Википедии ИЛИ иметь fame > 5
  const worthy = r => r.c.from === 'selected' || fameP(r.c.p) > 5 || (r.c.p.extract && r.c.p.extract.length > 100 && r.s > 5);
  for (const r of ranked) {
    if (main.length >= 4) break;
    if (!worthy(r)) continue;
    if ((perCat[r.cat] || 0) >= 2 || main.some(m => sameStory(m.t, r.c.e.text))) continue;
    perCat[r.cat] = (perCat[r.cat] || 0) + 1;
    main.push({ y: r.c.e.year, d: dd + '.' + mm, t: clip(r.c.e.text, 260), ex: clip(oneLine(r.c.p.extract || ''), 240), cat: r.cat, fame: fameP(r.c.p) || undefined,
      url: httpUrl(r.c.p.content_urls && r.c.p.content_urls.desktop && r.c.p.content_urls.desktop.page), img: BLOCK.test(txtOf(r.c)) ? '' : commonsImg(r.c.p), src: 'Википедия' });
  }
  main.sort((a, b) => a.y - b.y);
  /* праздники: закон/календарь России, затем Википедия (сначала российские) */
  const holidays = stat.filter(x => !x.y).map(x => ({ t: x.t, kind: 'праздник' }));
  holWp.filter(h => !BLOCK.core(h.text) && String(h.text).length <= 200).sort((a, b) => (RUSSIA.test(b.text) ? 1 : 0) - (RUSSIA.test(a.text) ? 1 : 0))
    .forEach(h => { if (holidays.length < 5 && !holidays.some(x => norm(x.t) === norm(h.text))) holidays.push({ t: clip(oneLine(h.text), 200), kind: 'праздник', url: httpUrl((h.pages && h.pages[0] && h.pages[0].content_urls && h.pages[0].content_urls.desktop && h.pages[0].content_urls.desktop.page)) }); });
  /* знаменитые люди дня: учёные, изобретатели, писатели, правители — по известности */
  const famous = people.map(x => ({ ...x, f: fameP(x.p), ok: PERSON_DESC.test(String(x.p.description || '') + ' ' + x.e.text) })).filter(x => x.ok && !BLOCK.core(x.e.text))
    .sort((a, b) => b.f - a.f).slice(0, 3)
    .map(x => ({ y: x.e.year, t: clip(oneLine(x.e.text), 130), kind: x.kind, url: httpUrl(x.p.content_urls && x.p.content_urls.desktop && x.p.content_urls.desktop.page) }));
  if (!main.length && !holidays.length) throw new Error('нет событий ни в календаре России, ни в Википедии');
  return { key, main, holidays, people: famous };
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
  /гандон|залуп|манд[ао]в|шлюх/, /(^|[^а-я])сук(а|и|е|у|ой|ам|ами)([^а-я]|$)|сучар/, /трахат|трахну|трахал|трахн/, /\*{2,}|[а-я]\*[а-я]|#{2,}/,
  /бзд|бзи[лт]|пердеж|пердят|дерьм|говн|(^|[^а-я])жоп|дроч|ссан|ссыт|обосс|обссы/];
const BANNED = [/жид(ы|ов|ам)?([^а-я]|$)|хач|чурк|хохл|кацап|москал|черномаз/, /порно|минет|оргазм|сперм|изнасил|педофил|инцест|зоофил|некрофил/, /суицид|самоубий|теракт|террор|похорон|погибш/];
const POLITICS = [/путин|трамп|байден|зеленск|навальн|макрон|мерц|шольц|стармер|эрдоган|орбан|мадьяр|вучич|нетаньяху|цзиньпин|политик|госдум|депутат|санкци|единорос|коммунист|мобилизац|вторжен|спецоперац|избирател|референдум|выбор(ы|ов|ах|ам)([^а-я]|$)|президент|премьер|правительств|министр|чиновник|кремл|белый дом|парламент|конгресс|сенат|оппозиц|митинг|режим|диктатор|демократ|евросоюз|европейск\w* союз|(^|[^а-я])(ес|оон|нато|сша)([^а-я]|$)|генассамбл|коалиц|власт(ь|и|ям|ями|ях)([^а-я]|$)/];
export const hasMat = t => MAT.some(r => r.test(yo(t)));
const hasBanned = t => BANNED.some(r => r.test(yo(t))) || BLOCK.test(t) || (!HUMOR_ALLOW_POLITICS && POLITICS.some(r => r.test(yo(t))));
const sentences = t => (t.match(/[.!?…]+(\s|$)/g) || []).length || 1;
export const jokeOk = (t, maxSent = 6) => t.length >= 40 && t.length <= 500 && sentences(t) <= maxSent && t.split('\n').length <= 8 && !hasMat(t) && !hasBanned(t);
const htmlToLines = h => decode((h || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')).split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');

async function fetchAnekdot() {
  const feeds = [['десятка', 'https://www.anekdot.ru/rss/export_j.xml'], ['лучшие', 'https://www.anekdot.ru/rss/export_top.xml'], ['истории', 'https://www.anekdot.ru/rss/export_o.xml']]; const all = []; // «истории» — официальная «Ежедневная десятка историй»
  await Promise.all(feeds.map(async ([n, u]) => { try {
    const items = parseRss(await getTextAuto(u));
    items.forEach((x, i) => { const body = htmlToLines(x.html); all.push({ feed: n, idx: i, t: body.length >= 30 ? body : htmlToLines(x.title), url: x.link }); });
    report['feed:anekdot.ru ' + n] = 'ok (' + items.length + ')';
  } catch (e) { report['feed:anekdot.ru ' + n] = 'fail: ' + e.message; } }));
  return all;
}
async function buildHumor(seen) {
  const uniq = new Map(), all = await fetchAnekdot();
  all.filter(x => x.feed !== 'истории').forEach(x => { const k = norm(x.t); if (!k) return; const cur = uniq.get(k);
    if (cur) cur.score += 3; else uniq.set(k, { ...x, score: (9 - Math.min(x.idx, 9)) + (x.t.length <= 250 ? 1 : 0) }); });
  const cands = [...uniq.values()];
  const passed = cands.filter(x => jokeOk(x.t) && !seen.has(jh(x.t))).sort((a, b) => b.score - a.score);
  report['humor:anekdot.ru'] = `кандидатов ${cands.length}, прошло фильтр ${passed.length}`;
  const safeUrl = u => (u && /^https?:\/\/(www\.)?anekdot\.ru\//.test(u)) ? u : 'https://www.anekdot.ru/';
  const jokes = passed.slice(0, 3).map(x => ({ id: 'a' + jh(x.t), kind: 'anekdot', t: x.t, src: 'anekdot.ru', url: safeUrl(x.url), score: x.score }));
  /* Смешная история дня: каждый день новая из «Ежедневной десятки историй» anekdot.ru, без повторов (отпечатки в архиве ~400 дней).
     Раньше историй в подборке не было, и приложение показывало одну из двух встроенных — они и повторялись */
  const storyOk = t => t.length >= 150 && t.length <= 1300 && sentences(t) <= 16 && t.split('\n').length <= 16 && !hasMat(t) && !hasBanned(t);
  const storyCands = all.filter(x => x.feed === 'истории');
  const storyPassed = storyCands.filter(x => storyOk(x.t) && !seen.has(jh(x.t))).sort((a, b) => a.idx - b.idx || a.t.length - b.t.length);
  let stories = storyPassed.slice(0, 1).map(x => ({ id: 'o' + jh(x.t), kind: 'anekdot', t: x.t, src: 'anekdot.ru', url: safeUrl(x.url) }));
  report['humor:истории'] = `кандидатов ${storyCands.length}, прошло фильтр ${storyPassed.length}` + (stories.length ? '' : ' — нет подходящей');
  if ((jokes.length < 2 || !stories.length) && HAS_LLM) {  // запасной вариант: нейросеть, только если ленты не ответили
    try {
      const arr = JSON.parse(extractJSON(await llm(`Ты — редактор юмористической рубрики. Придумай 6 коротких шуток и 1 смешную историю на русском, без мата и без политики. Шутка ≤ 6 предложений, история ≤ 12. Не пересказывай известные анекдоты. Если сомневаешься — не включай. Верни ТОЛЬКО JSON: [{"type":"joke"|"story","text":"..."}]`, 2500)));
      const ok = (Array.isArray(arr) ? arr : []).filter(x => x && typeof x.text === 'string' && !seen.has(jh(x.text)));
      const mkj = x => ({ id: 'h' + jh(x.text), kind: 'ai', t: x.text.trim() });
      ok.filter(x => x.type !== 'story' && jokeOk(x.text)).slice(0, 3 - jokes.length).forEach(x => jokes.push(mkj(x)));
      if (!stories.length) stories = ok.filter(x => x.type === 'story' && jokeOk(x.text, 12)).slice(0, 1).map(mkj); // история от нейросети — только если лента историй ничего не дала
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
export const retry = async (fn, n = 3) => { let last; for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { last = e; if (gigaDown && !KEY) break; await new Promise(r => setTimeout(r, 2000 * (i + 1))); } } throw last; };
async function gigaToken() {
  if (gigaTok && gigaTok.exp > Date.now() + 60000) return gigaTok.t;
  const r = await fetchG('GigaChat OAuth', 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', RqUID: crypto.randomUUID(), Authorization: 'Basic ' + GIGA },
    body: 'scope=' + encodeURIComponent(process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS') });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) throw new Error('GigaChat OAuth: ' + (j.message || r.status));
  gigaTok = { t: j.access_token, exp: j.expires_at || Date.now() + 25 * 60000 }; return gigaTok.t;
}
export const LLM_USAGE = { calls: 0, tokens: 0 }; // сколько запросов и токенов потрачено за запуск (для отчёта и проверки качества)
async function gigachat(prompt, max = 2000, temperature = 0.8) {
  const r = await fetchG('GigaChat запрос', 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + await gigaToken() },
    body: JSON.stringify({ model: process.env.GIGACHAT_MODEL || 'GigaChat', messages: [{ role: 'user', content: prompt }], temperature, max_tokens: max }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('GigaChat: ' + (j.message || r.status));
  LLM_USAGE.calls++; LLM_USAGE.tokens += (j.usage && j.usage.total_tokens) || 0;
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5'; // можно заменить на более дешёвую 'claude-sonnet-5' переменной CLAUDE_MODEL
async function claude(prompt, max = 2000, temperature) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: max, ...(temperature != null ? { temperature } : {}), messages: [{ role: 'user', content: prompt }] }) });
  const j = await r.json(); if (!r.ok) throw new Error('Claude API: ' + (j.error && j.error.message || r.status));
  LLM_USAGE.calls++; LLM_USAGE.tokens += ((j.usage && (j.usage.input_tokens + j.usage.output_tokens)) || 0);
  return (j.content || []).map(b => b.text || '').join('');
}
/* GigaChat — основной; если вход не удался, а ключ Claude есть — автоматически переключаемся на Claude Opus */
const llmRaw = (prompt, max, temp) => (GIGA && !gigaDown) ? gigachat(prompt, max, temp) : KEY ? claude(prompt, max, temp) : Promise.reject(new Error(GIGA ? 'GigaChat недоступен (см. giga:oauth), запасного ключа Claude нет' : 'нет ключа нейросети'));
let llmChain = Promise.resolve(); // запросы идут по очереди: у личного тарифа мало параллельных запросов
export const llm = (prompt, max, temp) => { const r = llmChain.then(() => llmRaw(prompt, max, temp)); llmChain = r.catch(() => {}); return r; };

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
      let title = m[1].trim().replace(/^["«»<]+|["«»>]+$/g, ''), body = m[2].trim().replace(/^<[^>\n]{1,60}>[ \t]*\n+/, ''); // модель иногда повторяет строку-образец «<перевод текста>»
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
const bullets = x => String(x || '').split('\n').map(l => l.replace(/^\s*(?:[-•–—*]|\d+[.)])\s*/, '').replace(/\s*\*+$/, '').trim()).filter(Boolean);
/* Разбор урока: если модель написала его одним абзацем — режем по предложениям, а не бракуем весь урок */
const splitSent = x => oneLine(x).split(/(?<=[.!?…»])\s+(?=[А-ЯЁA-Z«"—-])/).map(y => y.trim()).filter(y => y.length >= 15);
const fixBreakdown = raw => { let b = bullets(raw); if (b.length < 3) { const alt = splitSent(raw); if (alt.length >= 3) b = alt; } return b.slice(0, 5); };
const oneLine = x => String(x || '').replace(/\s+/g, ' ').trim();
export const safeText = t => !BANNED.slice(0, 2).some(r => r.test(yo(t))) && !hasMat(t) && !BLOCK.core(t);

/* Разбор промпта: какие приёмы в нём использованы, что улучшить, типичная ошибка, задание — по самому промпту, поэтому каждый день новое */
/* ─── AI-новость дня: что происходит в мире нейросетей и промпт-инжиниринга ──────────────────
   Источники: MIT Tech Review AI, Wired AI, The Verge AI, Habr (ИИ). Берётся одна новость в день,
   не повторяется (отпечаток в архиве), переводится GigaChat простым языком.  */
const AI_FEEDS = [
  ['MIT Tech Review', 'https://www.technologyreview.com/feed/'],
  ['Wired AI',        'https://www.wired.com/feed/tag/artificial-intelligence/latest/rss'],
  ['The Verge AI',    'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'],
  ['Habr ИИ',        'https://habr.com/ru/rss/hub/artificial_intelligence/all/']
];
const AI_GOOD = /\b(prompt|llm|gpt|claude|gemini|openai|anthropic|mistral|llama|искусственн|нейросет|языков.{0,10}модел|промпт|генератив|ии\b|ai\b|ChatGPT|Midjourney|diffusion|transformer|fine.?tun|embeddin|RAG|agent|мультимодал)/i;

async function fetchAiNews() {
  const candidates = [];
  for (const [src, url] of AI_FEEDS) {
    try {
      const xml = await getText(url, 7000);
      const items = parseRss(xml).slice(0, 8);
      for (const it of items) {
        const t = (it.title + ' ' + it.description).slice(0, 600);
        if (!AI_GOOD.test(t) || hasBanned(t) || hasMat(t)) continue;
        const fp = jh(it.title);
        if (seen.has(fp)) continue;
        candidates.push({ fp, title: it.title, desc: it.description, url: it.url, src });
      }
    } catch (e) { /* источник недоступен */ }
  }
  if (!candidates.length) return null;
  const pick = candidates[0];
  // Переводим и упрощаем: GigaChat объясняет новость как «учитель, не как журналист»
  const raw = await retry(() => llm(
    `Ты — опытный преподаватель промпт-инжиниринга с 20-летним стажем. Объясни эту новость из мира ИИ простым языком, как объяснял бы ученику без технического бэкграунда. Никакого жаргона без расшифровки. Структура ответа строго:
ЗАГОЛОВОК: <короткий заголовок на русском, до 12 слов>
СУТЬ: <2–3 предложения: что произошло, простыми словами>
ПОЧЕМУ ВАЖНО: <1–2 предложения: что это значит для обычного пользователя>
НОВОСТЬ: ${pick.title}
${pick.desc ? 'ДЕТАЛИ: ' + pick.desc.slice(0, 600) : ''}`, 800));
  const b = parseBlocks(raw, ['ЗАГОЛОВОК', 'СУТЬ', 'ПОЧЕМУ ВАЖНО']);
  const title = oneLine(b['ЗАГОЛОВОК']), body = oneLine(b['СУТЬ']), why = oneLine(b['ПОЧЕМУ ВАЖНО']);
  if (!title || body.length < 30) return null;
  seen.add(pick.fp);
  return { title, body, why, src: pick.src, url: safeUrl(pick.url) };
}

/* ─── Термин дня: ключевое понятие промпт-инжиниринга из сегодняшнего промпта ───────────────────
   GigaChat выбирает один термин из промпта (или базовый для темы) и объясняет его тремя способами:
   определение → аналогия из жизни → пример в одну строку.  */
async function makeTermOfDay(prompt) {
  const raw = await retry(() => llm(
    `Ты — лучший в мире преподаватель промпт-инжиниринга. Изучи этот промпт и выбери из него ОДИН ключевой термин или приём промпт-инжиниринга, который стоит объяснить новичку (например: «системный промпт», «ролевой промпт», «few-shot», «chain-of-thought», «температура», «контекстное окно» и т.д.).
Объясни его тремя способами — как учитель с 20-летним стажем объясняет сложное просто:
ТЕРМИН: <название термина>
ПРОСТО: <определение в 1 предложении — без жаргона, как для 10-летнего ребёнка>
АНАЛОГИЯ: <аналогия из обычной жизни — не из мира технологий>
ПРИМЕР: <одна строка: конкретный пример промпта или ситуации, где это работает>
СОВЕТ: <практический совет: как использовать это прямо сейчас>

ПРОМПТ: ${(prompt.title + '\n' + prompt.text).slice(0, 1200)}`, 700));
  const b = parseBlocks(raw, ['ТЕРМИН', 'ПРОСТО', 'АНАЛОГИЯ', 'ПРИМЕР', 'СОВЕТ']);
  const term = oneLine(b['ТЕРМИН']), simple = oneLine(b['ПРОСТО']), analogy = oneLine(b['АНАЛОГИЯ']), ex = oneLine(b['ПРИМЕР']), tip = oneLine(b['СОВЕТ']);
  if (!term || simple.length < 20) return null;
  return { term, simple, analogy, ex, tip };
}

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
  const a = { methods: bullets(b['ПРИЁМЫ']).filter(x => !/<[^<>]{3,80}>/.test(x)).slice(0, 4), improve: oneLine(b['УЛУЧШИТЬ']), mistake: oneLine(b['ОШИБКА']), task: oneLine(b['ЗАДАНИЕ']) }; // строки с незаполненной заготовкой «<...>» из шаблона — не приёмы, а мусор
  const all = [...a.methods, a.improve, a.mistake, a.task].join(' ');
  if (a.methods.length < 2 || a.improve.length < 15 || a.mistake.length < 15 || a.task.length < 15) throw new Error('разбор неполный');
  if (/<[^<>]{3,80}>/.test(all)) throw new Error('разбор содержит незаполненный образец из шаблона');
  if (cyr(all) < 0.8 || !safeText(all)) throw new Error('разбор не прошёл проверку языка');
  return a;
}

/* =====================================================================
   9. УРОК ДНЯ ПО ГОДОВОЙ ПРОГРАММЕ. Тема берётся по дню года (360 тем), текст пишет нейросеть по строгому шаблону.
      Проверяем структуру, язык, отсутствие мата; ставим оценку quality (0–10). Через год повторяем только
      уроки с оценкой ≥ 8 (лучшие), остальные пишутся заново.
   ===================================================================== */
export const lessonPrompt = t =>   // версия 1 (до 02.10.2026) — оставлена для сравнения в tools/lesson-eval.mjs
 `Ты — тренер по коммуникации. Составь мини-урок для аудитории 16+ на тему: «${t.topic}» (раздел курса: «${t.block}»).
Правила:
- Диалог — это ЖИВАЯ СЦЕНА между двумя людьми внутри описанной ситуации (дай героям имена, например Анна и Максим). Нельзя писать разговор О теме урока или об обучении: не начинай со слов «сегодня поговорим», «давайте разберём», «как думаете, стоит ли». Герои просто общаются, а нужный приём виден в их репликах.
- Реплики короткие, как в жизни. 6–10 реплик по очереди.
- Разбор: 3–4 пункта. В каждом: какой приём использовал герой, какими словами и почему это сработало. В последнем пункте покажи пару «Слабо: … → Лучше: …».
- Фразы: 3 короткие готовые фразы, которые человек может взять себе слово в слово.
- Задание: одно конкретное действие на сегодня с числом или сроком (например, «один раз за день…», «в течение 10 минут…»), которое можно сделать в реальной жизни, а не только записать на бумаге.
- Живой разговорный русский, вежливо; без мата, политики, оскорблений, сарказма и придуманной статистики. Вопросы открытые (начинаются с «Как», «Что», «Почему», «Расскажите…»).
Ответь СТРОГО в таком формате, без вступлений и пояснений:
СИТУАЦИЯ: <1–2 предложения: кто, где, что происходит>
ДИАЛОГ:
Анна: <реплика>
Максим: <реплика>
(6–10 реплик по очереди)
РАЗБОР:
- <приём: что сказал герой и почему это сработало>
- <приём: что сказал герой и почему это сработало>
- Слабо: «…» → Лучше: «…» (почему лучше)
ФРАЗЫ:
- <готовая фраза 1>
- <готовая фраза 2>
- <готовая фраза 3>
ЗАДАНИЕ: <одно конкретное действие на сегодня с числом или сроком>
ВОПРОСЫ:
- <открытый вопрос 1>
- <открытый вопрос 2>
- <открытый вопрос 3>
ПРИВЫЧКА: <маленькое действие на 1–2 минуты>
ВЕЧЕРНИЙ ВОПРОС: <один вопрос для рефлексии вечером>`;
export function parseLesson(txt) {
  const b = parseBlocks(txt, ['СИТУАЦИЯ', 'ДИАЛОГ', 'РАЗБОР', 'ФРАЗЫ', 'ЗАДАНИЕ', 'ВОПРОСЫ', 'ПРИВЫЧКА', 'ВЕЧЕРНИЙ ВОПРОС']);
  const sit = oneLine(b['СИТУАЦИЯ']), dialog = bullets(b['ДИАЛОГ']), breakdown = fixBreakdown(b['РАЗБОР']), task = oneLine(b['ЗАДАНИЕ']);
  const questions = bullets(b['ВОПРОСЫ']).slice(0, 3), habit = oneLine(b['ПРИВЫЧКА']), evening = oneLine(b['ВЕЧЕРНИЙ ВОПРОС']), phrases = bullets(b['ФРАЗЫ']).map(x => x.replace(/^[«"]|[»"]$/g, '')).filter(x => x.length >= 8 && x.length <= 160).slice(0, 4);
  const all = [sit, ...dialog, ...breakdown, ...phrases, task, ...questions, habit, evening].join(' '); const errs = [];
  /* «Лекция о теме» вместо живой сцены и задание без срока — брак: пусть модель перепишет */
  if (dialog.some(l => /сегодня (мы )?(поговорим|обсудим|разберём|разберем)|в этом (уроке|диалоге)|тема (нашего|этого)|давайте (попробуем|обсудим|разберём|разберем)|как думаете, стоит ли/i.test(l))) errs.push('диалог-лекция');
  if (breakdown.some(l => /^слабо:?/i.test(l) && !/→|->|—>|➜/.test(l))) errs.push('«Слабо» без пары «Лучше»'); // модель начала приём и не закончила
  if (!/\d|минут|секунд|один раз|каждый|сегодня/i.test(task)) errs.push('задание без срока');
  if (sit.length < 30 || sit.length > 450) errs.push('ситуация'); if (dialog.length < 5) errs.push('диалог'); if (breakdown.length < 3) errs.push('разбор');
  if (task.length < 20 || task.length > 320) errs.push('задание'); if (questions.length < 3) errs.push('вопросы'); if (habit.length < 10) errs.push('привычка'); if (evening.length < 10) errs.push('вечерний вопрос');
  if (cyr(all) < 0.85) errs.push('язык'); if (!safeText(all)) errs.push('запрещённые слова');
  let q = 0; if (phrases.length >= 3) q += 1; if (dialog.length >= 6) q += 2; if (breakdown.length >= 3 && breakdown.length <= 5) q += 2; if (questions.length === 3 && questions.every(x => /\?$/.test(x))) q += 1;
  if (/\d|минут|секунд/.test(task)) q += 2; if (habit.length <= 140) q += 1; if (/\?$/.test(evening)) q += 1; if (sit.length >= 60) q += 1;
  return { ok: errs.length === 0, errs, lesson: { situation: sit, dialog: dialog.slice(0, 12), breakdown, phrases, task, questions, habit, evening, quality: q } };
}
async function readArchive(date) { try { return JSON.parse(await fs.readFile(path.join(ROOT, 'archive', date + '.json'), 'utf8')); } catch (e) { return null; } }
const HARD_ERR = new Set(['ситуация', 'диалог', 'задание', 'язык', 'запрещённые слова', 'диалог-лекция', 'задание без срока']);
const DEFAULT_HABIT = 'Сегодня один раз осознанно используйте одну из фраз этого урока в реальном разговоре.';
const DEFAULT_EVENING = 'Что сегодня получилось в общении лучше всего и что бы вы сделали иначе?';
/* «Мягкая приёмка»: если в уроке не хватает только второстепенного, чиним его, а не выбрасываем весь урок (пустой день хуже чуть менее идеального урока) */
function softFix(r) {
  if (r.errs.some(e => HARD_ERR.has(e))) return null;
  const L = { ...r.lesson };
  L.breakdown = (L.breakdown || []).filter(x => !(/^слабо:?/i.test(x) && !/→|->|—>|➜/.test(x)));
  if (L.breakdown.length < 2 || (L.questions || []).length < 2) return null;
  if (!L.habit || L.habit.length < 10) L.habit = DEFAULT_HABIT;
  if (!L.evening || L.evening.length < 10) L.evening = DEFAULT_EVENING;
  L.quality = Math.max(0, (L.quality || 0) - 2); L.soft = true;
  return L;
}
async function buildLesson() {
  const t = TOPICS[COURSE_DAY - 1];
  const prev = await readArchive((Number(TODAY.slice(0, 4)) - 1) + TODAY.slice(4)); // тот же день прошлого года
  // через год повторяем только урок, который прошёл строгую проверку v2 (автопроверка + рецензент-психолог) с оценкой ≥ 8
  if (prev && prev.lesson && prev.lesson.topic === t.topic && prev.lesson.quality >= 8 && prev.lesson.qa && prev.lesson.qa.v === 2 && prev.lesson.qa.pass) { report['lesson:повтор'] = 'год прошёл: берём лучший урок прошлого года (оценка ' + prev.lesson.quality + ')'; return { ...prev.lesson, reused: true }; }
  if (!HAS_LLM) throw new Error('для нового урока нужна нейросеть (GigaChat) — используется встроенная база');
  const LECTURE_PRONE = /^как (говор|выраз|сказ|объясн|попрос|отказ|поддерж|слуш|реагир|понять)|^(понять|принят|осознать|важность)/i;
  const attempts = LECTURE_PRONE.test(t.topic) ? 5 : 3;
  const { lesson, log } = await generateLessonV2(t, COURSE_DAY, { llm: (p, m, temp) => retry(() => llm(p, m, temp)), safe: safeText, attempts });
  const j = lesson.qa.judge;
  report['lesson:оценка'] = `${lesson.quality}/10 · автопроверка ${lesson.qa.format}` + (j ? ` · психолог ${j.avg} (логика ${j.ЛОГИКА}, безопасность ${j.БЕЗОПАСНОСТЬ})` : ' · рецензент не ответил') + ` · попыток ${log.length}`;
  if (lesson.weak) report['lesson:слабый'] = 'строгую планку не прошёл, принят по минимальной (в канал не публикуется)' + (j && j.note ? ': ' + j.note : '');
  const rejected = log.filter(l => l.error || l.hard.length); if (rejected.length) report['lesson:отклонено'] = rejected.map(l => l.error || l.hard.join(', ')).join(' | ').slice(0, 300);
  return { day: COURSE_DAY, of: TOPICS.length, block: t.block, topic: t.topic, ...lesson, source: LLM_NAME };
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
async function readDaily() { try { return JSON.parse(await fs.readFile(path.join(OUTD, 'daily.json'), 'utf8')); } catch (e) { return null; } }
async function main() {
  /* Запуск идёт по нескольким сигналам расписания (GitHub может опоздать или пропустить один). Поэтому сборщик идемпотентен:
     • за сегодня (по Москве) ничего нет — собираем всё;
     • есть, но чего-то не хватает (урок, новости, события) — дособираем только это;
     • есть всё, но новости старше 90 минут и уже утро (после 06:00) — один раз освежаем новости, чтобы к 8:00 они были самыми свежими;
     • иначе — ничего не делаем. Ручной запуск (FORCE_BUILD) пересобирает всё. */
  const prev = await readDaily();
  const today = prev && prev.v === 2 && prev.date === TODAY ? prev : null;
  let todo = null;
  if (today && !FORCE) {
    const miss = [];
    if (!today.lesson) miss.push('lesson');
    if (!Array.isArray(today.news) || today.news.length < 4) miss.push('news');
    if (!today.events || !(today.events.main || []).length) miss.push('events');
    const refresh = !DRAFT && !miss.length && mskHour() >= 6 && !today.newsFinal && (Date.now() - Date.parse(today.newsAt || today.generated)) > 90 * 60e3;
    if (!miss.length && !refresh) { console.log(`Подборка за ${TODAY} уже собрана полностью — пропускаю.`); return; }
    todo = new Set(miss.length ? miss : ['news']);
    Object.assign(report, today.sources || {});
    report['сборка'] = 'доработка: ' + [...todo].join(', ') + ' (' + new Date().toISOString().slice(11, 16) + ' UTC)';
    console.log('Режим доработки:', [...todo].join(', '));
  } else report['сборка'] = 'полная' + (FORCE ? ' (ручной запуск)' : '');
  const want = k => !todo || todo.has(k);
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
  const R = {}, jobs = [];
  const run = (k, f) => { if (want(k)) jobs.push(f().then(v => { R[k] = v; })); };
  run('quotes', () => withReuse('quotes', buildQuotes)); run('news', () => step('news', () => buildNews(seen), [])); run('prompts', () => withReuse('prompts', buildPrompts));
  run('words', () => withReuse('word', buildWord)); run('books', () => withReuse('books', buildBooks)); run('films', () => withReuse('films', buildFilms)); run('tracks', () => withReuse('tracks', buildTracks));
  run('humor', () => step('humor', () => buildHumor(seen), { jokes: [], stories: [] })); run('lesson', () => step('lesson', () => buildLesson(), null)); run('events', () => step('events', () => buildEvents(), null));
  await Promise.all(jobs);
  const base = todo ? today : {}, val = (k, d) => (k in R ? R[k] : (base[k] ?? d));
  const hm = 'humor' in R ? R.humor : { jokes: base.jokes || [], stories: base.stories || [] };
  const newsBuilt = 'news' in R, nowIso = new Date().toISOString();
  const out = { v: 2, date: TODAY, generated: base.generated || nowIso,
    newsAt: newsBuilt ? nowIso : (base.newsAt || base.generated || nowIso), newsFinal: newsBuilt ? mskHour() >= 6 : !!base.newsFinal,
    sources: report, course: { day: COURSE_DAY, of: TOPICS.length },
    scoring: 'Цитаты: источник+длина+раздел; новости: вес источника+свежесть+сколько изданий пишут об этом+совпадение тем; промпты: роль+длина+ограничения; книги и фильмы: оценка×ln(1+голоса); треки: популярность в чарте; события дня: календарь России + известность статьи (число языков Википедии). Ничего не повторяется 365 дней.',
    lesson: val('lesson', null), events: val('events', null), quotes: val('quotes', []), news: val('news', []), prompts: val('prompts', []), words: val('words', []),
    books: val('books', []), films: val('films', []), tracks: val('tracks', []), jokes: hm.jokes, stories: hm.stories };
  const { lesson, quotes, news, prompts, words, books } = out;
  await fs.mkdir(path.join(OUTD, 'archive'), { recursive: true });
  const s = JSON.stringify(out, null, 1);
  const arch = { ...out, jokes: out.jokes.map(j => ({ id: j.id, h: jh(j.t) })), stories: out.stories.map(j => ({ id: j.id, h: jh(j.t) })) }; // тексты анекдотов в архив не пишем
  await fs.writeFile(path.join(OUTD, 'daily.json'), s); await fs.writeFile(path.join(OUTD, 'archive', TODAY + '.json'), JSON.stringify(arch, null, 1));
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
