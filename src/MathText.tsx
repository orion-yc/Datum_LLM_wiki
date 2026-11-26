import { lazy, Suspense, type ReactNode } from 'react';

const Formula = lazy(() => import('./Formula'));

// Protect complete expressions before Markdown splits lines, table cells or citation markers.
// Backtick spans and fences consume their contents first so code examples stay literal.
const formulaTokens = /(?<!\\)(`+)[\s\S]*?\1(?!`)|(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]|(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)|(?<![\\$])\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<!\s)\$(?![\d$])/g;

export function prepareMath(source: string) {
  let marker = '\uE000';
  while (source.includes(marker)) marker += '\uE000';
  const formulas: ReactNode[] = [];
  const positions: { end: number; rawEnd: number }[] = [];
  let delta = 0;
  const text = source.replace(formulaTokens, (raw, code, dollars, brackets, parens, inline, offset: number) => {
    if (code) return raw;
    const tex = dollars ?? brackets ?? parens ?? inline;
    const key = formulas.length;
    formulas.push(<Suspense key={key} fallback={raw}><Formula raw={raw} tex={tex} display={dollars !== undefined || brackets !== undefined} /></Suspense>);
    const token = marker + key + '\uE001';
    const start = offset - delta;
    positions.push({ end: start + token.length, rawEnd: offset + raw.length });
    delta += raw.length - token.length;
    return token;
  });
  function sourceOffset(position: number) {
    let low = 0, high = positions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (positions[mid].end <= position) low = mid + 1;
      else high = mid;
    }
    const last = positions[low - 1];
    return position + (last ? last.rawEnd - last.end : 0);
  }
  function render(value: string, offset?: number): ReactNode {
    if (offset === undefined && (!formulas.length || !value.includes(marker))) return value;
    let pos = offset ?? 0;
    const parts = value.split(new RegExp('(' + marker + '\\d+\uE001)', 'g'));
    return parts.map((part, i) => {
      if (!part) return null;
      const formula = part.startsWith(marker) && /^\d+\uE001$/.test(part.slice(marker.length));
      const node = formula ? formulas[Number(part.slice(marker.length, -1))] : part;
      const start = pos;
      pos += part.length;
      return offset === undefined ? node : <span key={i} data-wiki-start={sourceOffset(start)}
        data-wiki-end={sourceOffset(pos)} data-atomic={formula || undefined}>{node}</span>;
    });
  }
  return { text, render, sourceOffset };
}

export function MathText({ text }: { text: string }) {
  const math = prepareMath(text);
  return <>{math.render(math.text)}</>;
}
