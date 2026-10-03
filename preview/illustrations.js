/* =====================================================================
   illustrations.js — схемные иллюстрации к 12 блокам курса «Ближе к людям».
   Рисуются кодом (SVG), поэтому бесплатны, не требуют авторских прав, работают офлайн и подстраиваются под тёмную и светлую тему.
   Цвета задаются классами в index.html: .a — янтарный контур, .g — изумрудный, .m — приглушённый, .fa/.fg/.fm — заливки.
   Ключ — название блока из tools/curriculum.mjs. Для неизвестного блока показывается запасная картинка.
   ===================================================================== */
(function (g) {
  const svg = (label, body) => `<svg class="il" viewBox="0 0 320 140" role="img" aria-label="Иллюстрация: ${label}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  const person = (x, cls) => `<circle class="${cls}" cx="${x}" cy="62" r="16"/><path class="${cls}" d="M${x - 28} 118 Q${x} 78 ${x + 28} 118"/>`;
  const bars = () => { // звуковая волна с паузой посередине
    const h = [14, 26, 40, 58, 44, 30, 16, 0, 0, 0, 16, 30, 44, 58, 40, 26, 14]; let s = '';
    h.forEach((v, i) => { const x = 40 + i * 15; s += v ? `<path class="${i < 7 ? 'a' : 'g'}" d="M${x} ${70 - v / 2} V${70 + v / 2}"/>` : `<circle class="fm" cx="${x}" cy="70" r="2.5"/>`; });
    return s;
  };
  const dots = () => Array.from({ length: 8 }, (_, i) => `<circle class="fm" cx="${40 + i * 34}" cy="132" r="5"/>`).join('');
  const I = {
    'Первый контакт': svg('первый контакт: двое знакомятся',
      person(90, 'a') + person(230, 'g') + '<rect class="m" x="118" y="14" width="84" height="38" rx="14"/><path class="m" d="M150 52 l-8 12 l20 -12"/>' +
      '<circle class="fm" cx="142" cy="33" r="3.5"/><circle class="fm" cx="160" cy="33" r="3.5"/><circle class="fm" cx="178" cy="33" r="3.5"/><path class="m" d="M124 92 H196" stroke-dasharray="2 8"/>'),
    'Слушать и слышать': svg('слушать и слышать: звук приходит к слушателю',
      '<path class="a" d="M70 45 Q52 70 70 95"/><path class="a" d="M94 32 Q68 70 94 108"/><path class="a" d="M118 20 Q84 70 118 120"/>' +
      '<circle class="g" cx="236" cy="70" r="42"/><path class="g" d="M204 50 Q184 58 190 78 Q196 96 216 92"/><path class="g" d="M204 62 Q198 70 204 80"/><path class="m" d="M232 54 Q248 54 254 66 Q258 78 246 86" stroke-dasharray="1 7"/>'),
    'Вопросы, которые открывают': svg('вопросы, которые открывают разговор',
      '<circle class="m" cx="160" cy="70" r="52" stroke-dasharray="3 9"/><circle class="m" cx="160" cy="70" r="66" stroke-dasharray="3 12"/>' +
      '<path class="a" d="M138 52 Q138 26 162 26 Q186 26 186 48 Q186 64 164 72 Q160 74 160 88"/><circle class="fa" cx="160" cy="108" r="5.5"/>'),
    'Голос, тело и паузы': svg('голос, тело и паузы: звуковая волна с паузой', bars()),
    'Уверенность и волнение': svg('уверенность и волнение: вершина и ровный пульс',
      '<path class="a" d="M50 112 L120 48 L160 86 L196 60 L270 112 Z"/><path class="a" d="M120 48 V22"/><path class="fa" d="M120 22 L148 30 L120 38 Z"/>' +
      '<path class="g" d="M40 128 H66 L74 116 L84 138 L92 128 H120 H200 H280"/>'),
    'Работа и переговоры': svg('работа и переговоры: две стороны договариваются',
      '<rect class="a" x="52" y="24" width="72" height="80" rx="8"/><path class="a" d="M66 46 H110 M66 62 H110 M66 78 H96"/>' +
      '<rect class="g" x="196" y="24" width="72" height="80" rx="8"/><path class="g" d="M210 46 H254 M210 62 H254 M210 78 H240"/>' +
      '<path class="m" d="M138 56 H182 M148 46 L138 56 L148 66 M172 46 L182 56 L172 66"/><circle class="g" cx="160" cy="98" r="14"/><path class="g" d="M153 98 L158 104 L168 92"/>'),
    'Сложные разговоры': svg('сложные разговоры: напряжение и мост между людьми',
      '<rect class="a" x="34" y="22" width="86" height="52" rx="16"/><path class="a" d="M60 74 l-8 16 l24 -16"/><rect class="g" x="200" y="50" width="86" height="52" rx="16"/><path class="g" d="M262 102 l8 16 l-24 -16"/>' +
      '<path class="m" d="M128 30 l12 12 l-12 10 l12 12"/><path class="g" d="M126 118 Q160 82 194 118"/>'),
    'Письма и мессенджеры': svg('письма и мессенджеры: конверт и сообщения',
      '<rect class="a" x="40" y="36" width="104" height="72" rx="8"/><path class="a" d="M40 42 L92 82 L144 42"/>' +
      '<rect class="g" x="180" y="22" width="96" height="36" rx="12"/><path class="g" d="M196 58 l-6 12 l18 -12"/><rect class="m" x="196" y="76" width="96" height="36" rx="12"/><path class="m" d="M272 112 l6 10 l-16 -10"/>'),
    'Выступления и презентации': svg('выступление: спикер, экран и слушатели',
      '<rect class="m" x="196" y="14" width="102" height="62" rx="6"/><path class="a" d="M212 62 V50 M228 62 V36 M244 62 V44 M260 62 V28 M276 62 V50"/>' +
      '<circle class="g" cx="110" cy="38" r="14"/><path class="g" d="M84 88 Q110 58 136 88"/><rect class="g" x="78" y="88" width="64" height="28" rx="6"/>' + dots()),
    'Друзья, семья, близкие': svg('друзья, семья, близкие: сердце и двое рядом',
      '<path class="a" d="M160 114 C120 88 108 64 124 48 C138 34 156 42 160 54 C164 42 182 34 196 48 C212 64 200 88 160 114 Z"/>' +
      '<circle class="g" cx="66" cy="58" r="12"/><path class="g" d="M44 108 Q66 76 88 108"/><circle class="g" cx="254" cy="58" r="12"/><path class="g" d="M232 108 Q254 76 276 108"/>'),
    'Убеждение, влияние и этика': svg('убеждение и этика: весы аргументов',
      '<path class="m" d="M160 40 V116 M122 116 H198"/><path class="a" d="M76 52 L244 36"/><circle class="fa" cx="160" cy="44" r="6"/>' +
      '<path class="a" d="M76 52 L52 92 M76 52 L100 92 M46 92 H106 Q76 116 46 92 Z"/><path class="g" d="M244 36 L220 76 M244 36 L268 76 M214 76 H274 Q244 100 214 76 Z"/>'),
    'Рост: рефлексия, обратная связь, ИИ-помощник': svg('рост: ступени вверх и росток',
      '<path class="a" d="M40 124 H90 V102 H140 V80 H190 V58 H240 V44 H292"/><path class="g" d="M266 44 V18"/><path class="g" d="M266 28 Q248 20 246 34 Q259 38 266 28"/><path class="g" d="M266 22 Q284 12 288 26 Q275 32 266 22"/>')
  };
  g.ILLUS = I;
  g.illusFor = block => I[block] || I['Рост: рефлексия, обратная связь, ИИ-помощник'];
})(typeof window !== 'undefined' ? window : globalThis);
