/* =====================================================================
   channel-post.mjs — утренний пост «Фраза дня» в Telegram-канал.
   Запускается из .github/workflows/daily.yml сразу после сборки daily.json.

   Что делает: берёт урок дня из daily.json и публикует в канал ситуацию, готовые фразы, задание
   и кнопки «Пройти урок в боте» / «Открыть на сайте».

   Правила:
   • Публикует один раз в день: дата последнего поста хранится в channel/last-post.txt.
   • Только с 06:00 до 13:00 по Москве — ночью пост не уходит, даже если подборка уже собрана.
   • Если урока за сегодня ещё нет, нет фраз или урок задевает тему военного конфликта — пропускает
     (следующий запуск по расписанию попробует снова).

   Нужны секреты GitHub (Settings → Secrets and variables → Actions):
   • TG_BOT_TOKEN  — токен бота (тот же, что в Cloudflare; посмотреть: @BotFather → /mybots → бот → API Token)
   • TG_CHANNEL_ID — адрес канала, например @blizhe_daily (бот должен быть админом канала с правом публикации)
   Необязательно: BOT_URL, SITE_URL. Проверка без отправки: DRY_RUN=1 node tools/channel-post.mjs
   ===================================================================== */
import fs from 'node:fs';
import BLOCK from '../blocklist.js';

const TOKEN = process.env.TG_BOT_TOKEN || '';
const CHANNEL = process.env.TG_CHANNEL_ID || '';
const BOT_URL = process.env.BOT_URL || 'https://t.me/blizhe_k_lyudyam_bot';
const SITE_URL = process.env.SITE_URL || 'https://nikitaammag-del.github.io/blizhe/';
const DRY = process.env.DRY_RUN === '1';
const MARK = 'channel/last-post.txt';

const msk = new Date(Date.now() + 3 * 3600e3);
const today = msk.toISOString().slice(0, 10), hour = msk.getUTCHours();
const say = m => console.log('[канал] ' + m);

if (!DRY && (!TOKEN || !CHANNEL)) { say('нет TG_BOT_TOKEN или TG_CHANNEL_ID — пропускаю'); process.exit(0); }
if (!DRY && (hour < 6 || hour >= 13)) { say(`сейчас ${hour}:xx по Москве — постим только с 06 до 13`); process.exit(0); }
if (!DRY && fs.existsSync(MARK) && fs.readFileSync(MARK, 'utf8').trim() === today) { say('сегодня уже публиковали'); process.exit(0); }

const d = JSON.parse(fs.readFileSync('daily.json', 'utf8'));
const L = d.lesson;
if (!DRY && d.date !== today) { say(`подборка за ${d.date}, а сегодня ${today} — ждём сборку`); process.exit(0); }
if (!L || !L.topic || !Array.isArray(L.phrases) || !L.phrases.length) { say('в подборке нет урока с фразами — пропускаю'); process.exit(0); }
// В публичный канал — только уроки, прошедшие строгую проверку (v2: автопроверка + психолог). Старые уроки без проверки — при оценке не ниже 7
if (L.weak || (L.qa ? !L.qa.pass : (L.quality || 0) < 7)) { say(`урок не прошёл строгую проверку качества (оценка ${L.quality}) — в канал не публикуем`); process.exit(0); }

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = s => String(s || '').replace(/\s+/g, ' ').replace(/^[-–—\s]+$/, '').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);
const phrases = L.phrases.map(clean).filter(p => p.length > 3).slice(0, 3);
const all = [L.topic, L.situation, ...phrases, L.task, L.evening].join(' ');
if (BLOCK.core(all) || BLOCK.test(all)) { say('урок задевает тему военного конфликта — не публикую'); process.exit(0); }

const parts = [
  `💬 <b>Фраза дня</b> · урок ${esc(L.day || d.course?.day || '')} из ${esc(L.of || d.course?.of || 360)}`,
  `<b>${esc(clean(L.topic))}</b>`,
  clean(L.situation) ? `📍 ${esc(clip(clean(L.situation), 400))}` : '',
  `<b>Как сказать:</b>\n` + phrases.map(p => `— «${esc(p.replace(/^[«"]|[»"]$/g, ''))}»`).join('\n'),
  clean(L.task) ? `✅ <b>Задание на сегодня:</b> ${esc(clip(clean(L.task), 300))}` : '',
  clean(L.evening) ? `🌙 <i>Вопрос на вечер:</i> ${esc(clip(clean(L.evening), 200))}` : '',
  'Разбор диалога, ошибки «слабо → лучше» и серия дней — в боте 👇'
].filter(Boolean);
const text = parts.join('\n\n');
const reply_markup = { inline_keyboard: [[{ text: '🎯 Пройти урок в боте', url: BOT_URL }], [{ text: '📖 Открыть на сайте', url: SITE_URL }]] };

if (DRY) { console.log(text + '\n\n[кнопки] ' + reply_markup.inline_keyboard.flat().map(b => b.text + ' → ' + b.url).join(' | ')); process.exit(0); }

const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chat_id: CHANNEL, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup })
}).then(x => x.json()).catch(e => ({ ok: false, description: String(e) }));

if (!r.ok) { console.log(`::warning::Пост в канал не отправлен: ${r.description || 'неизвестная ошибка'}`); process.exit(0); }
fs.mkdirSync('channel', { recursive: true }); fs.writeFileSync(MARK, today + '\n');
say('опубликовано: ' + L.topic);
