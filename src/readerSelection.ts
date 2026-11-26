export type ReaderSelection = {
  chunk_id: string;
  end_chunk_id: string;
  start_offset: number;
  end_offset: number;
  quote: string;
};

const maxQuoteLength = 8000;
type Point = { node: Text; offset: number };

function prose(node: Node, paper: HTMLElement) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const root = element?.closest<HTMLElement>('.text-chunk .rich-text');
  return root && paper.contains(root) ? root : null;
}

function owner(node: Text) {
  return node.parentElement?.closest<HTMLElement>('[data-chunk]')?.dataset.chunk ||
    node.parentElement?.closest<HTMLElement>('section[data-reader-chunk]')?.dataset.readerChunk;
}

function textNodes(root: HTMLElement) {
  return root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
}

// Walk only the displayed sections between the two endpoints. Page captions,
// note buttons and headings outside RichText have no position in the quote.
function describeRange(paper: HTMLElement, range: Range) {
  const first = prose(range.startContainer, paper), last = prose(range.endContainer, paper);
  if (!first || !last || range.collapsed) return null;
  let selection: ReaderSelection | null = null;
  let lastBlock: Element | null = null;
  const ranges: Range[] = [];
  let section = first.closest('section');
  while (section) {
    const root = section.querySelector<HTMLElement>('.rich-text');
    if (!root) return null;
    const offsets = new Map<string, number>();
    const walker = textNodes(root);
    let segment: Range | null = null;
    for (let entry = walker.nextNode(); entry; entry = walker.nextNode()) {
      const node = entry as Text, id = owner(node);
      if (!id || !node.length) continue;
      const base = offsets.get(id) || 0;
      offsets.set(id, base + node.length);
      if (!range.intersectsNode(node)) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      if (end <= start) continue;
      if (!selection) selection = { chunk_id: id, start_offset: base + start, end_chunk_id: id, end_offset: 0, quote: '' };
      const block = node.parentElement!.closest('.text-line, h4, pre, td, th') || root;
      if (lastBlock && block !== lastBlock) {
        selection.quote += block.closest('tr') && block.closest('tr') === lastBlock.closest('tr') ? '\t' : '\n';
      }
      selection.quote += node.substringData(start, end - start);
      if (selection.quote.length > maxQuoteLength) return null;
      lastBlock = block;
      selection.end_chunk_id = id;
      selection.end_offset = base + end;
      if (!segment) {
        segment = document.createRange();
        segment.setStart(node, start);
        ranges.push(segment);
      }
      segment.setEnd(node, end);
    }
    if (root === last) return selection?.quote.trim() ? { selection, ranges } : null;
    let next = section.nextElementSibling;
    while (next?.classList.contains('pdf-image-pages')) next = next.nextElementSibling;
    section = next?.closest('section') || null;
  }
  return null;
}

export function readSelection(paper: HTMLElement): { selection: ReaderSelection; rect: DOMRect } | null {
  const native = window.getSelection();
  if (!native?.rangeCount || native.isCollapsed) return null;
  const range = native.getRangeAt(0);
  const result = describeRange(paper, range);
  return result && { selection: result.selection, rect: range.getBoundingClientRect() };
}

function findPoint(paper: HTMLElement, id: string, offset: number, end: boolean): Point | null {
  const marker = document.getElementById(`chunk-${id}`);
  if (!marker || !paper.contains(marker)) return null;
  const root = marker.closest('section')?.querySelector<HTMLElement>('.rich-text');
  if (!root || !Number.isInteger(offset) || offset < 0) return null;
  const walker = textNodes(root);
  for (let entry = walker.nextNode(); entry; entry = walker.nextNode()) {
    const node = entry as Text;
    if (owner(node) !== id || !node.length) continue;
    if (offset < node.length || (end && offset === node.length)) return { node, offset };
    offset -= node.length;
  }
  return null;
}

export function revealSelection(paper: HTMLElement, selection: ReaderSelection): boolean {
  const start = findPoint(paper, selection.chunk_id, selection.start_offset, false);
  const end = findPoint(paper, selection.end_chunk_id, selection.end_offset, true);
  if (!start || !end) return false;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const result = describeRange(paper, range);
  if (!result || result.selection.quote !== selection.quote) return false;
  if (typeof Highlight !== 'undefined' && CSS.highlights) {
    CSS.highlights.set('reader-quote', new Highlight(...result.ranges));
  } else {
    const native = window.getSelection();
    native?.removeAllRanges();
    native?.addRange(range);
  }
  start.node.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
  return true;
}
