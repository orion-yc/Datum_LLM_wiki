import { memo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './Formula.css';

export default memo(function Formula({ tex, raw, display }: { tex: string; raw: string; display: boolean }) {
  try {
    const html = katex.renderToString(tex, { displayMode: display, trust: false, throwOnError: true,
      strict: 'ignore', maxSize: 20, maxExpand: 500 });
    return <span className={display ? 'formula-block' : 'formula-inline'} dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <span className="formula-source">{raw}</span>;
  }
});
