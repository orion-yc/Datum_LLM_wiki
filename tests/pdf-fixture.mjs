import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { backendEnvironment } from '../scripts/backend.mjs';

export async function academicPdf({ pages = 2, scanned = false } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Academic layout - page ${i + 1}`, { x: 40, y: 740, font, size: 18 });
    const columns = i % 2 ? 3 : 2;
    const width = 532 / columns;
    for (let col = 0; col < columns; col++) {
      const label = ['LEFT', 'MIDDLE', 'RIGHT'][columns === 2 && col === 1 ? 2 : col];
      for (let line = 0; line < 12; line++)
        page.drawText(`${label}${line === 0 ? 'START' : line === 11 ? 'END' : 'BODY'} Evidence ${line}.`, { x: 40 + col * width, y: 690 - line * 12, font, size: 10 });
    }
    page.drawText('Table 1. Measurement: 12.5 ms. Equation: E = mc^2.', { x: 40, y: 350, font, size: 11 });
  }
  const bytes = Buffer.from(await pdf.save());
  if (!scanned) return bytes;
  const folder = await mkdtemp(join(tmpdir(), 'datum-scanned-pdf-'));
  try {
    const path = join(folder, 'original.pdf'), prefix = join(folder, 'page');
    await writeFile(path, bytes);
    const env = backendEnvironment();
    const renderer = env.PDFTOPPM || (env.PDFTOTEXT ? join(dirname(env.PDFTOTEXT), process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm') : 'pdftoppm');
    const scan = await PDFDocument.create();
    for (let page = 1; page <= pages; page++) {
      await promisify(execFile)(renderer, ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '1200', '-jpeg', path, prefix], { env, windowsHide: true });
      const image = await scan.embedJpg(await readFile(prefix + '.jpg'));
      scan.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    }
    return Buffer.from(await scan.save());
  } finally { await rm(folder, { recursive: true, force: true }); }
}
