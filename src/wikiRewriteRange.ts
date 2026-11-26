export type RewriteTarget = { scope: 'selection' | 'section' | 'page'; start: number; end: number };

export function wikiHeadings(body: string) {
  const headings: { start: number; level: number; label: string }[] = [];
  let fence = '', pos = 0;
  for (const line of body.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = '';
    } else if (marker) fence = marker;
    else {
      const heading = /^(#{1,6})[ \t]+/.exec(line);
      if (heading) headings.push({start: pos, level: heading[1].length, label: line.slice(heading[0].length).trim()});
    }
    pos += line.length + 1;
  }
  return headings;
}

export function wikiSectionAt(body: string, offset: number): RewriteTarget | null {
  const headings = wikiHeadings(body);
  const current = headings.filter(h => h.start <= offset).at(-1);
  if (!current) return null;
  const end = headings.find(h => h.start > current.start && h.level <= current.level)?.start ?? body.length;
  return { scope: 'section', start: current.start, end: current.start + body.slice(current.start, end).trimEnd().length };
}

// For a DOM range with element endpoints (including touch selection), find its
// first and last selected source spans. Formula layout is one atomic span.
export function wikiSelectionOffsets(paper: HTMLElement, range: Range): RewriteTarget | null {
  let start: number | undefined, end: number | undefined;
  for (const span of paper.querySelectorAll<HTMLElement>('[data-wiki-start]')) {
    if (!range.intersectsNode(span)) continue;
    const from = Number(span.dataset.wikiStart), to = Number(span.dataset.wikiEnd);
    const text = span.firstChild;
    if (!text) continue;
    const left = range.startContainer === text && text.nodeType === Node.TEXT_NODE && !span.hasAttribute('data-atomic') ? from + range.startOffset : from;
    const right = range.endContainer === text && text.nodeType === Node.TEXT_NODE && !span.hasAttribute('data-atomic') ? from + range.endOffset : to;
    if (right <= left) continue;
    start ??= left;
    end = right;
  }
  return start !== undefined && end !== undefined ? {scope:'selection', start, end} : null;
}
