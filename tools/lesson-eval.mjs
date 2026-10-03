/* =====================================================================
   tools/lesson-eval.mjs — проверка качества уроков на выборке (по умолчанию 100 тем).
   Запуск: Actions → «Проверка качества уроков» → Run workflow (там же выбирается размер выборки).

   Что делает: берёт N тем, равномерно по всему курсу (все 12 блоков), и для каждой темы:
   • СТАРЫЙ способ (до 02.10.2026): один запрос по старому шаблону + старая проверка формата;
   • НОВЫЙ способ: шаблон коуча-психолога, автопроверка, рецензент, до 3 попыток (как в ежедневной сборке).
   Оба урока оценивает один и тот же рецензент-психолог по 5 критериям — так сравнение честное.
   Результат: eval/report.md (сводка, частые ошибки, худшие и лучшие уроки целиком) и eval/results.json.
   Обе вещи появляются во вкладке запуска (Artifacts) и в Summary.

   Ограничитель расхода: EVAL_MAX_TOKENS (по умолчанию 1 200 000) — при превышении проверка
   останавливается и пишет отчёт по тому, что успела.
   ===================================================================== */
import fs from 'node:fs/promises';
import { TOPICS } from './curriculum.mjs';
import { llm, retry, lessonPrompt, parseLesson, safeText, LLM_USAGE } from './build-daily.mjs';
import { generateLessonV2, judgePrompt, parseJudge, passes, CRITERIA } from './lesson.mjs';

const N = Math.max(1, Math.min(360, Number(process.env.EVAL_N) || 100));
const MODE = process.env.EVAL_MODE === 'new' ? 'new' : 'ab';
const MAX_TOKENS = Number(process.env.EVAL_MAX_TOKENS) || 1200000;
const OUT = 'eval';
const ask = (p, m, t) => retry(() => llm(p, m, t));
const OLD_HARD = new Set(['ситуация', 'диалог', 'задание', 'язык', 'запрещённые слова', 'диалог-лекция', 'задание без срока']);
const r1 = x => Math.round(x * 10) / 10;
const mean = a => (a.length ? r1(a.reduce((s, x) => s + x, 0) / a.length) : null);
const pct = (a, n) => (n ? Math.round(100 * a / n) + '%' : '—');

await fs.mkdir(OUT, { recursive: true });
const results = []; let stopped = '';
const t0 = Date.now();

for (let i = 0; i < N; i++) {
  if (LLM_USAGE.tokens > MAX_TOKENS) { stopped = `остановлено на ${i} из ${N}: израсходовано ${LLM_USAGE.tokens} токенов (лимит ${MAX_TOKENS})`; break; }
  const idx = Math.floor(i * TOPICS.length / N), t = TOPICS[idx], day = idx + 1;
  const row = { day, block: t.block, topic: t.topic };

  /* Новый способ */
  const tok1 = LLM_USAGE.tokens;
  try {
    const { lesson, log } = await generateLessonV2(t, day, { llm: ask, safe: safeText });
    const first = log[0] || {};
    row.new = { status: lesson.weak ? 'слабый' : 'строгий', quality: lesson.quality, judge: lesson.qa.judge, attempts: log.length, firstOk: !first.error && !(first.hard || []).length,
      firstPass: !!(first.judge && !(first.hard || []).length && passes({ ok: true, format: first.format }, first.judge)), log, lesson };
  } catch (e) { row.new = { status: 'нет урока', error: e.message }; }
  row.new.tokens = LLM_USAGE.tokens - tok1;

  /* Старый способ (для сравнения) */
  if (MODE === 'ab') {
    const tok2 = LLM_USAGE.tokens;
    try {
      const r = parseLesson(await ask(lessonPrompt(t), 2500));
      const accepted = r.ok || !r.errs.some(e => OLD_HARD.has(e));
      let judge = null;
      if (r.lesson.dialog.length) { try { judge = parseJudge(await ask(judgePrompt(t, { technique: '', ...r.lesson }), 300, 0.1)); } catch (e) { /* без оценки */ } }
      row.old = { accepted, errs: r.errs, oldQuality: r.lesson.quality, judge, lesson: r.lesson };
    } catch (e) { row.old = { accepted: false, error: e.message }; }
    row.old.tokens = LLM_USAGE.tokens - tok2;
  }
  results.push(row);
  const n = row.new, o = row.old;
  console.log(`[${i + 1}/${N}] день ${day} «${t.topic.slice(0, 50)}» → новый: ${n.status}${n.judge ? ' ' + n.judge.avg : ''}` + (o ? ` | старый: ${o.accepted ? 'принят' : 'брак'}${o.judge ? ' ' + o.judge.avg : ''}` : '') + ` | токенов всего ${LLM_USAGE.tokens}`);
  if ((i + 1) % 5 === 0) await fs.writeFile(`${OUT}/results.json`, JSON.stringify({ partial: true, results }, null, 1));
}

/* ---------- Отчёт ---------- */
const R = results, n = R.length;
const NEW = R.map(r => r.new), OLD = R.map(r => r.old).filter(Boolean);
const jN = NEW.map(x => x.judge).filter(Boolean), jO = OLD.map(x => x.judge).filter(Boolean);
const crit = (arr, c) => mean(arr.map(j => j[c]));
const goodJ = j => j.ЛОГИКА >= 7 && j.БЕЗОПАСНОСТЬ >= 8 && Math.min(...CRITERIA.map(c => j[c])) >= 6;
const strict = NEW.filter(x => x.status === 'строгий').length, weak = NEW.filter(x => x.status === 'слабый').length, none = NEW.filter(x => x.status === 'нет урока').length;

const errCount = {}; NEW.forEach(x => (x.log || []).forEach(l => [...(l.hard || []), ...(l.soft || [])].forEach(e => { errCount[e] = (errCount[e] || 0) + 1; })));
const topErr = Object.entries(errCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
const notes = NEW.flatMap(x => (x.log || []).map(l => l.judge && l.judge.note).filter(Boolean));
const tokNew = mean(NEW.map(x => x.tokens)), tokOld = mean(OLD.map(x => x.tokens));

const show = r => { const L = r.new.lesson; if (!L) return `### День ${r.day}: «${r.topic}» — урока нет\n${r.new.error}\n`;
  const j = r.new.judge || {}; return `### День ${r.day}: «${r.topic}» — ${r.new.status}, оценка ${L.quality}\n` +
  `Психолог: ${CRITERIA.map(c => `${c.toLowerCase()} ${j[c] ?? '—'}`).join(', ')}${j.note ? `. Замечание: ${j.note}` : ''}\n\n` +
  `**Приём:** ${L.technique}\n\n**Ситуация:** ${L.situation}\n\n${L.dialog.map(x => '> ' + x).join('\n>\n')}\n\n**Разбор:**\n${L.breakdown.map(x => '- ' + x).join('\n')}\n\n**Фразы:** ${L.phrases.join(' · ')}\n\n**Задание:** ${L.task}\n`; };
const ranked = R.filter(r => r.new.lesson).sort((a, b) => a.new.quality - b.new.quality || (a.new.judge?.avg || 0) - (b.new.judge?.avg || 0));

const md = `# Проверка качества уроков — ${new Date().toISOString().slice(0, 10)}

Выборка: **${n} тем** из ${TOPICS.length} (равномерно по всем 12 блокам курса)${MODE === 'ab' ? ', старый и новый способ на одних и тех же темах' : ', только новый способ'}.
${stopped ? `\n⚠️ ${stopped}\n` : ''}
Время: ${Math.round((Date.now() - t0) / 60000)} мин · запросов к нейросети: ${LLM_USAGE.calls} · токенов: ${LLM_USAGE.tokens.toLocaleString('ru-RU')}

## Главное

| Показатель | Старый способ | Новый способ |
|---|---|---|
| Урок без брака с первой попытки | ${MODE === 'ab' ? pct(OLD.filter(x => x.accepted).length, OLD.length) + ' (по старой, мягкой проверке)' : '—'} | ${pct(NEW.filter(x => x.firstOk).length, n)} (по новой, строгой) |
| Психолог доволен (логика ≥ 7, безопасность ≥ 8, все ≥ 6) | ${pct(jO.filter(goodJ).length, OLD.length)} | ${pct(jN.filter(goodJ).length, n)} |
| Средняя оценка психолога | ${mean(jO.map(j => j.avg)) ?? '—'} | ${mean(jN.map(j => j.avg)) ?? '—'} |
| Итог за день (до 3 попыток) | — | строгих ${pct(strict, n)} · слабых ${pct(weak, n)} · без урока ${pct(none, n)} |
| Попыток в среднем | 1 | ${mean(NEW.filter(x => x.attempts).map(x => x.attempts)) ?? '—'} |
| Токенов на один урок | ${tokOld ?? '—'} | ${tokNew ?? '—'} |

## Оценки психолога по критериям (среднее, 1–10)

| Критерий | Старый | Новый |
|---|---|---|
${CRITERIA.map(c => `| ${c} | ${crit(jO, c) ?? '—'} | ${crit(jN, c) ?? '—'} |`).join('\n')}

## Частые ошибки автопроверки (все попытки нового способа)

${topErr.length ? topErr.map(([e, k]) => `- ${e} — ${k}`).join('\n') : 'Нет.'}

## Замечания психолога (выборочно)

${notes.slice(0, 12).map(x => '- ' + x).join('\n') || 'Нет.'}

## По блокам курса (новый способ)

| Блок | Тем | Строгих | Средняя оценка психолога |
|---|---|---|---|
${[...new Set(R.map(r => r.block))].map(b => { const g = R.filter(r => r.block === b); return `| ${b} | ${g.length} | ${pct(g.filter(r => r.new.status === 'строгий').length, g.length)} | ${mean(g.map(r => r.new.judge && r.new.judge.avg).filter(Boolean)) ?? '—'} |`; }).join('\n')}

## 5 худших уроков (для ручной проверки)

${ranked.slice(0, 5).map(show).join('\n')}
## 3 лучших урока

${ranked.slice(-3).reverse().map(show).join('\n')}
---
Важно: рецензент — та же нейросеть, что пишет уроки, поэтому её оценки могут быть мягче, чем у человека.
Для независимой проверки пришлите файл results.json в чат с Claude — он вручную разберёт выборку.
`;
await fs.writeFile(`${OUT}/report.md`, md);
await fs.writeFile(`${OUT}/results.json`, JSON.stringify({ partial: !!stopped, mode: MODE, n, usage: LLM_USAGE, results }, null, 1));
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md.split('## 5 худших')[0]);
console.log(md.split('## 5 худших')[0]);
