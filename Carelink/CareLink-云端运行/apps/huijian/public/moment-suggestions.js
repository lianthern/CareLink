const LIMITS = Object.freeze({ minimum: 3, maximum: 4, label: 14, text: 90 });
const controls = /[\u0000-\u001f\u007f]/u;
const markup = /[<>]|(?:javascript|data)\s*:/iu;
const concreteClaim = /^(?:(?:我|我们)(?:是|在|有|叫|去了|吃了|和|跟|很(?:开心|难过|害怕|生气))|(?:这|那)(?:是|在|有))|(?:庆祝|生日|结婚|婚礼|毕业).{0,12}[。！？!?]?$/u;
const unsupportedSpecific = /(?:\d{1,4}\s*(?:年|月|日|号|点)|去年|前年|今年|早餐|午餐|晚餐|早饭|午饭|晚饭|吃饭|聚餐|生日|婚礼|结婚|毕业|庆祝|求婚)/u;
const namedPlaceClaim = /(?:是在|地点是|拍于)(?!家附近|旅行途中|工作或学校附近)[\p{Script=Han}]{2,16}/u;

function compact(value, maximum) {
  if (typeof value !== 'string') return '';
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return !text || text.length > maximum || controls.test(text) || markup.test(text) ? '' : text;
}

function spokenHistory(history) {
  if (!Array.isArray(history)) return '';
  return history.filter(item => item?.role === 'user' && typeof item.text === 'string')
    .map(item => item.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()).join('\n');
}

// Syntax is strict because model output is untrusted UI data. A concrete first-person claim is
// accepted only when it already appears verbatim in the user's own history; otherwise the whole
// generated set is discarded and the caller can use the fact-free fallback below.
export function normalizeMomentSuggestions(value, history = []) {
  const source = Array.isArray(value) ? value : Array.isArray(value?.suggestions) ? value.suggestions : [];
  if (source.length < LIMITS.minimum) return [];
  const userWords = spokenHistory(history);
  const seen = new Set(), result = [];
  for (const item of source) {
    const label = compact(item?.label, LIMITS.label), text = compact(item?.text, LIMITS.text);
    if (!label || !text || seen.has(text)) continue;
    const userConfirmed = userWords.includes(text.replace(/[。！？!?]+$/u, ''));
    if (!userConfirmed && (concreteClaim.test(text) || unsupportedSpecific.test(text) || namedPlaceClaim.test(text))) continue;
    seen.add(text); result.push({ label, text });
    if (result.length === LIMITS.maximum) break;
  }
  return result.length >= LIMITS.minimum ? result : [];
}

const fallbackSets = Object.freeze({
  person: [
    { label: '朋友', text: '朋友。' },
    { label: '家人', text: '家人。' },
    { label: '同事', text: '同事。' },
    { label: '记不清', text: '我记不清了。' }
  ],
  place: [
    { label: '家附近', text: '是在家附近。' },
    { label: '旅行途中', text: '是在旅行途中。' },
    { label: '工作或学校', text: '是在工作或学校附近。' },
    { label: '记不清', text: '我记不清地点了。' }
  ],
  time: [
    { label: '最近几年', text: '是最近几年的事。' },
    { label: '很久以前', text: '已经是很久以前了。' },
    { label: '大概记得', text: '我只记得大概时间。' },
    { label: '记不清', text: '我记不清时间了。' }
  ],
  feeling: [
    { label: '轻松', text: '很轻松。' },
    { label: '开心', text: '很开心。' },
    { label: '有点不舍', text: '有点不舍。' },
    { label: '说不清', text: '有点说不清。' }
  ],
  event: [
    { label: '随手记录', text: '只是随手记录的一刻。' },
    { label: '值得纪念', text: '那一刻值得纪念。' },
    { label: '和人有关', text: '和当时一起的人有关。' },
    { label: '记不清', text: '我记不清经过了。' }
  ],
  detail: [
    { label: '照片里的人', text: '先聊照片里的人。' },
    { label: '拍照的地方', text: '先聊拍照的地方。' },
    { label: '发生的事', text: '先聊当时发生的事。' },
    { label: '当时的感受', text: '先聊当时的感受。' }
  ]
});

export function fallbackMomentSuggestions(question, history = []) {
  const value = typeof question === 'string' ? question : '';
  const key = /谁|人物|关系|和你|哪位/u.test(value) ? 'person'
    : /哪里|哪儿|地点|地方/u.test(value) ? 'place'
      : /什么时候|何时|哪年|时间|多久/u.test(value) ? 'time'
        : /感受|感觉|心情|情绪/u.test(value) ? 'feeling'
          : /发生|经过|后来|故事|为什么|怎么/u.test(value) ? 'event' : 'detail';
  const alreadySaid = new Set((Array.isArray(history) ? history : []).filter(item => item?.role === 'user')
    .map(item => compact(item.text, LIMITS.text)).filter(Boolean));
  const preferred = fallbackSets[key].filter(item => !alreadySaid.has(item.text));
  const reserve = Object.values(fallbackSets).flat().filter(item => !alreadySaid.has(item.text));
  const unique = new Set();
  const fresh = [...preferred, ...reserve].filter(item => !unique.has(item.text) && unique.add(item.text));
  const selected = fresh.slice(0, 4), selectedTexts = new Set(selected.map(item => item.text));
  for (const item of fallbackSets[key]) if (selected.length < 4 && !selectedTexts.has(item.text)) { selectedTexts.add(item.text); selected.push(item); }
  for (const item of Object.values(fallbackSets).flat()) if (selected.length < 4 && !selectedTexts.has(item.text)) { selectedTexts.add(item.text); selected.push(item); }
  return normalizeMomentSuggestions(selected, []);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function suggestionsHtml(value, { disabled = false, history = [] } = {}) {
  return normalizeMomentSuggestions(value, history).map(item => `<button type="button" class="suggestion-chip" data-action="suggestion" data-suggestion-text="${escapeHtml(item.text)}"${disabled ? ' disabled' : ''}>${escapeHtml(item.label)}</button>`).join('');
}

export const MOMENT_SUGGESTION_LIMITS = LIMITS;
