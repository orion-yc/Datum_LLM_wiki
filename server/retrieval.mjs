const stop = new Set(['的', '了', '是', '在', '和', '与', '我', '你', '什么', '如何', '为什么', '请', '解释', '一下', '这个', 'the', 'a', 'is', 'of', 'to', 'and', 'how', 'what']);
export function tokens(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const words = normalized.match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu) || [];
  const result = [];
  for (const word of words) {
    if (stop.has(word)) continue;
    if (/\p{Script=Han}/u.test(word)) {
      for (let i = 0; i < word.length - 1; i++) { const token = word.slice(i, i + 2); if (!stop.has(token)) result.push(token); }
    } else result.push(word);
  }
  return result;
}
export function rankChunks(question, chunks, limit = 6) {
  const query = [...new Set(tokens(question))];
  if (!query.length) return [];
  const documents = chunks.map(c => ({ c, tokens: tokens(c.heading + ' ' + c.content) }));
  const frequency = new Map(query.map(t => [t, documents.filter(d => d.tokens.includes(t)).length]));
  const avgLength = documents.reduce((s, d) => s + d.tokens.length, 0) / Math.max(documents.length, 1);
  return documents.map(({ c, tokens: list }) => {
    let score = 0;
    for (const t of query) {
      const tf = list.filter(v => v === t).length;
      if (!tf) continue;
      const df = frequency.get(t);
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * list.length / Math.max(avgLength, 1)));
      if (c.heading.toLowerCase().includes(t)) score += idf * 0.5;
    }
    return { ...c, score };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.position - b.position).slice(0, limit);
}

export function splitText(text, size = 1100, overlap = 150) {
  const clean = text.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
  const parts = [];
  for (let start = 0; start < clean.length;) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) { const boundary = Math.max(clean.lastIndexOf('\n', end), clean.lastIndexOf('。', end)); if (boundary > start + size / 2) end = boundary + 1; }
    const part = clean.slice(start, end).trim();
    if (part) parts.push(part);
    if (end === clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return parts;
}

export function markdownChunks(text) {
  const sections = [];
  let heading = '正文', body = [], page = 1;
  const flush = () => { for (const content of splitText(body.join('\n'))) sections.push({ heading, content, page }); body = []; };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) { flush(); heading = match[1].trim(); page++; } else body.push(line);
  }
  flush();
  return sections.map((section, index) => ({ ...section, page: index + 1 }));
}
