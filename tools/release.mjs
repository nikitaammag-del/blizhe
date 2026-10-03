/* =====================================================================
   tools/release.mjs — правило публикации: ничего не выходит без одобрения владельца.

   node tools/release.mjs notify    — черновик готов: сводка владельцу в Telegram + кнопки
   node tools/release.mjs approve   — владелец одобрил черновик (Actions → «Одобрить выпуск»)
   node tools/release.mjs publish   — ночью: одобренный выпуск становится сегодняшним на сайте

   Файлы:
   preview/daily.json       — черновик выпуска (на завтра)
   preview/archive/ДАТА.json — его запись для архива «без повторов»
   preview/approved.txt     — дата, которую владелец одобрил
   preview/missed.txt       — служебная отметка «уже сообщили, что выпуск не одобрен»

   Секреты (необязательные — без них всё работает, только без сообщений): TG_BOT_TOKEN, TG_OWNER_ID
   ===================================================================== */
import fs from 'node:fs';

const REPO = process.env.GITHUB_REPOSITORY || 'nikitaammag-del/blizhe';
const SITE = 'https://nikitaammag-del.github.io/blizhe/';
const PREVIEW = SITE + 'preview/';
const ACT = wf => `https://github.com/${REPO}/actions/workflows/${wf}`;
const TOKEN = process.env.TG_BOT_TOKEN || '', OWNER = process.env.TG_OWNER_ID || '';
const DRY = process.env.DRY_RUN === '1';

const NOW = () => (process.env.RELEASE_NOW ? Date.parse(process.env.RELEASE_NOW) : Date.now()); // RELEASE_NOW — только для проверки
const mskNow = () => new Date(NOW() + 3 * 3600e3);
const today = () => mskNow().toISOString().slice(0, 10);
const hour = () => mskNow().getUTCHours();
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const readTxt = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return ''; } };
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const human = date => new Date(date + 'T12:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: 'UTC' });
const say = m => console.log('[выпуск] ' + m);
const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

async function tg(text, buttons) {
  if (DRY) { console.log('--- сообщение владельцу ---\n' + text + (buttons ? '\n[кнопки] ' + buttons.flat().map(b => b.text + ' → ' + b.url).join(' | ') : '')); return; }
  if (!TOKEN || !OWNER) { say('нет TG_BOT_TOKEN или TG_OWNER_ID — сообщение владельцу не отправлено'); return; }
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: OWNER, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) }) })
    .then(x => x.json()).catch(e => ({ ok: false, description: String(e) }));
  if (!r.ok) console.log(`::warning::Сообщение владельцу не отправлено: ${r.description}`);
}

/* ---------- Сводка черновика ---------- */
function summary(d) {
  const L = d.lesson, j = L && L.qa && L.qa.judge, rows = [];
  rows.push(`📝 <b>Черновик выпуска на ${esc(human(d.date))}</b>`);
  if (L) {
    const mark = L.qa ? (L.weak ? '⚠️ слабый — в канал не пойдёт' : '✅ прошёл строгую проверку') : '⚠️ без проверки психолога';
    rows.push(`<b>Урок</b> (день ${L.day} из ${L.of}): ${esc(L.topic)}\nПриём: ${esc(L.technique || '—')} · оценка ${L.quality}/10${j ? ` · психолог ${j.avg}` : ''} · ${mark}` + (j && j.note ? `\nЗамечание психолога: ${esc(clip(j.note, 160))}` : ''));
  } else rows.push('⚠️ <b>Урока нет</b> — в приложении будет резервная база');
  const n = (d.news || []);
  rows.push(`<b>Новости (${n.length}):</b>\n` + (n.length ? n.map((x, i) => `${i + 1}. ${esc(clip(x.t, 110))} <i>(${esc(x.src || '')})</i>`).join('\n') : '—'));
  const st = (d.stories || [])[0]; rows.push(`<b>История:</b> ${st ? esc(clip(st.t, 160)) : '— (будет встроенная)'}`);
  const q = (d.quotes || [])[0]; if (q) rows.push(`<b>Цитата:</b> «${esc(clip(q.t, 140))}» — ${esc(q.a)}`);
  const w = (d.words || [])[0], b = (d.books || [])[0], f = (d.films || [])[0], t = (d.tracks || [])[0];
  rows.push([w && `Слово: ${esc(w.w)}`, b && `Книга: ${esc(clip(b.t, 50))}`, f && `Фильм: ${esc(clip(f.t, 50))}`, t && `Трек: ${esc(clip(t.a + ' — ' + t.t, 60))}`].filter(Boolean).join(' · '));
  const ev = d.events && (d.events.main || [])[0]; if (ev) rows.push(`<b>Событие дня:</b> ${esc(clip(ev.t, 120))}`);
  const bad = Object.entries(d.sources || {}).filter(([k, v]) => /^fail/.test(String(v)));
  if (bad.length) rows.push(`⚠️ Не ответило источников: ${bad.length} (${esc(clip(bad.map(([k]) => k.replace(/^feed:/, '')).join(', '), 160))})`);
  rows.push('Проверь с 20:00 до 22:00. Если всё хорошо — «Одобрить». Если нет — «Пересобрать», и через 5 минут придёт новый вариант.');
  return rows.filter(Boolean).join('\n\n');
}
const BUTTONS = [[{ text: '👀 Открыть черновик', url: PREVIEW }], [{ text: '✅ Одобрить', url: ACT('approve.yml') }, { text: '🔄 Пересобрать', url: ACT('draft.yml') }]];

/* ---------- Публикация: копируем одобренный черновик в выпуск сайта ---------- */
function publishNow(d) {
  fs.copyFileSync('preview/daily.json', 'daily.json');
  fs.mkdirSync('archive', { recursive: true });
  const arch = `preview/archive/${d.date}.json`;
  if (fs.existsSync(arch)) fs.copyFileSync(arch, `archive/${d.date}.json`);
  out('published', d.date);
}

const cmd = process.argv[2];
const d = readJSON('preview/daily.json');

if (cmd === 'notify') {
  if (!d) { say('черновика нет'); process.exit(0); }
  await tg(summary(d), BUTTONS);
  say('сводка отправлена владельцу');
}

else if (cmd === 'approve') {
  if (!d) { console.log('::error::Черновика нет — сначала запустите «Черновик выпуска»'); process.exit(1); }
  const T = today(), site = readJSON('daily.json');
  if (d.date < T) { console.log(`::error::Черновик устарел (на ${d.date}). Запустите «Черновик выпуска» → Run workflow, чтобы собрать новый.`); await tg(`⚠️ Черновик на ${esc(d.date)} устарел — одобрять нечего. Нажми «Пересобрать».`, [[{ text: '🔄 Пересобрать', url: ACT('draft.yml') }]]); process.exit(1); }
  fs.writeFileSync('preview/approved.txt', d.date + '\n');
  if (d.date === T && (!site || site.date !== T || site.generated !== d.generated)) { publishNow(d); /* черновик на сегодня владелец одобрил — заменяем выпуск сразу */ say(`одобрено и сразу опубликовано: ${d.date}`); await tg(`✅ Выпуск на ${esc(human(d.date))} одобрен и <b>опубликован сейчас</b>.`, [[{ text: '🌐 Открыть сайт', url: SITE }]]); }
  else { say(`одобрено: ${d.date}, выйдет ночью`); await tg(`✅ Выпуск на ${esc(human(d.date))} одобрен. Выйдет на сайте после полуночи, в 08:00 — в боте${process.env.TG_CHANNEL_ID ? ' и канале' : ''}.`); }
}

else if (cmd === 'publish') {
  const T = today(), site = readJSON('daily.json');
  if (site && site.date === T) { say(`выпуск на ${T} уже на сайте`); process.exit(0); }
  if (d && d.date === T && readTxt('preview/approved.txt') === T) { publishNow(d); say(`опубликован одобренный выпуск на ${T}`); process.exit(0); }
  // Не одобрен: по правилу ничего не публикуем — на сайте остаётся прошлый выпуск. Утром один раз сообщаем владельцу
  say(`выпуск на ${T} не одобрен — не публикую` + (d ? ` (черновик на ${d.date})` : ' (черновика нет)'));
  if (hour() >= 6 && readTxt('preview/missed.txt') !== T) {
    fs.mkdirSync('preview', { recursive: true }); fs.writeFileSync('preview/missed.txt', T + '\n');
    const can = d && d.date === T;
    await tg(`⏸ Выпуск на ${esc(human(T))} <b>не опубликован</b>: одобрения не было. На сайте остаётся прошлый выпуск, в канал ничего не ушло.` + (can ? '\n\nЧерновик на сегодня есть — можно проверить и одобрить сейчас, он выйдет сразу.' : ''),
      can ? BUTTONS : [[{ text: '🔄 Собрать черновик на сегодня', url: ACT('draft.yml') }]]);
  }
}

else { console.log('Использование: node tools/release.mjs notify | approve | publish'); process.exit(1); }
