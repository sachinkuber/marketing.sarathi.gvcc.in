// Builds a Word copy of a Markdown document. The Markdown file is the canonical
// source; the .docx is generated and must never be edited by hand.
//
// Usage: node md2docx.js <source.md> <output.docx>
// Mermaid code fences are rendered to PNG with mermaid-cli (needs a local Chrome;
// set PUPPETEER_CONFIG to a puppeteer config JSON if Chrome is not auto-detected).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, LevelFormat, AlignmentType, ImageRun,
  Footer, PageNumber, Bookmark, InternalHyperlink,
} = require('docx');

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node md2docx.js <source.md> <output.docx>');
  process.exit(1);
}
const lines = fs.readFileSync(src, 'utf8').split('\n');

const TABLE_W = 9360; // US Letter with 1" margins, in DXA
const PAGE_W_PX = 624; // 6.5" at 96 dpi
const MAX_IMG_H_PX = 820;
const CHAR_DXA = 105; // approximate width of one 10pt character
const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const borders = { top: border, bottom: border, left: border, right: border };

function runs(text, base = {}) {
  const res = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) res.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const t = m[0];
    if (t.startsWith('**')) res.push(new TextRun({ text: t.slice(2, -2), bold: true, ...base }));
    else res.push(new TextRun({ text: t.slice(1, -1), font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'F0F0F0' }, ...base, size: (base.size || 22) - 2 }));
    last = m.index + t.length;
  }
  if (last < text.length) res.push(new TextRun({ text: text.slice(last), ...base }));
  return res;
}

const plain = s => s.replace(/\*\*|`/g, '');

// Column widths: every column gets at least the width of its longest unbreakable
// word, then the remaining space is shared out by how much text the column holds.
function columnWidths(header, body) {
  const n = header.length;
  const cells = i => [header[i], ...body.map(r => r[i] || '')].map(plain);
  const pad = 240;
  const mins = header.map((_, i) => {
    const longestWord = Math.max(...cells(i).flatMap(c => c.split(/[\s/]+/).map(w => w.length)), 3);
    return Math.min(longestWord * CHAR_DXA + pad, Math.floor(TABLE_W * 0.45));
  });
  const weights = header.map((_, i) => {
    const lens = cells(i).map(c => c.length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    return Math.min(Math.max(avg, 4), 90);
  });
  const minTotal = mins.reduce((a, b) => a + b, 0);
  let widths;
  if (minTotal >= TABLE_W) {
    widths = mins.map(m => Math.floor((m / minTotal) * TABLE_W));
  } else {
    const spare = TABLE_W - minTotal;
    const wTotal = weights.reduce((a, b) => a + b, 0);
    widths = mins.map((m, i) => m + Math.floor((weights[i] / wTotal) * spare));
  }
  widths[n - 1] += TABLE_W - widths.reduce((a, b) => a + b, 0);
  return widths;
}

function makeTable(rows) {
  const cells = rows.map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
  const header = cells[0];
  const body = cells.slice(2);
  const widths = columnWidths(header, body);
  const size = header.length >= 6 ? 18 : 20;
  const mk = (row, isHead) => new TableRow({
    tableHeader: isHead,
    cantSplit: true, // never split one row across two pages
    children: row.map((c, i) => new TableCell({
      borders, width: { size: widths[i], type: WidthType.DXA },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      shading: isHead ? { type: ShadingType.CLEAR, fill: 'E8EEF7' } : undefined,
      children: [new Paragraph({ children: runs(c, isHead ? { bold: true, size } : { size }) })],
    })),
  });
  return new Table({
    width: { size: TABLE_W, type: WidthType.DXA }, columnWidths: widths,
    rows: [mk(header, true), ...body.map(r => mk(r, false))],
  });
}

function renderMermaid(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-'));
  const inFile = path.join(dir, 'd.mmd');
  const outFile = path.join(dir, 'd.png');
  fs.writeFileSync(inFile, code);
  const mmdc = process.env.MMDC || 'mmdc';
  const args = ['-i', inFile, '-o', outFile, '-s', '2', '-b', 'white'];
  if (process.env.PUPPETEER_CONFIG) args.unshift('-p', process.env.PUPPETEER_CONFIG);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      execFileSync(mmdc, args, { stdio: 'pipe', timeout: 180000 });
      if (fs.existsSync(outFile)) return fs.readFileSync(outFile);
    } catch (e) { lastErr = e; }
  }
  throw new Error('mermaid render failed: ' + (lastErr ? String(lastErr.stderr || lastErr.message).slice(0, 400) : 'no output'));
}

function imageParagraph(png) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const scale = Math.min(PAGE_W_PX / w, MAX_IMG_H_PX / h, 0.5); // rendered at 2x
  return new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 }, keepNext: true,
    children: [new ImageRun({ type: 'png', data: png, transformation: { width: Math.round(w * scale), height: Math.round(h * scale) } })],
  });
}

const children = [];
const contents = []; // {text, anchor}
const numConfigs = [];
let i = 0, firstH1 = true, numberRef = 0, diagrams = 0, firstSectionIndex = 1;
const isBlockStart = l => /^(#{1,3} |\||- |\d+\. |```)/.test(l);

while (i < lines.length) {
  const line = lines[i];
  if (!line.trim()) { i++; continue; }
  let m;
  if ((m = line.match(/^```(\w*)/))) {
    const lang = m[1];
    const buf = [];
    i++;
    while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
    i++;
    if (lang === 'mermaid') {
      children.push(imageParagraph(renderMermaid(buf.join('\n'))));
      diagrams++;
    } else {
      for (const l of buf) children.push(new Paragraph({ children: [new TextRun({ text: l || ' ', font: 'Consolas', size: 18 })] }));
    }
    continue;
  }
  if ((m = line.match(/^(#{1,3}) (.*)/))) {
    const lvl = m[1].length;
    if (lvl === 1 && firstH1) {
      children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: runs(m[2]) }));
      firstH1 = false;
    } else {
      const level = [null, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][lvl];
      let kids = runs(m[2]);
      if (lvl === 2) {
        const anchor = 'h_' + crypto.createHash('md5').update(m[2]).digest('hex').slice(0, 10);
        if (!contents.length) firstSectionIndex = children.length;
        contents.push({ text: plain(m[2]), anchor });
        kids = [new Bookmark({ id: anchor, children: kids })];
      }
      children.push(new Paragraph({ heading: level, keepNext: true, children: kids }));
    }
    i++;
    continue;
  }
  if (line.startsWith('|')) {
    const rows = [];
    while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
    children.push(makeTable(rows));
    children.push(new Paragraph({ children: [] }));
    continue;
  }
  if (/^- /.test(line)) {
    while (i < lines.length && /^- /.test(lines[i])) {
      children.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: runs(lines[i].slice(2)) }));
      i++;
    }
    continue;
  }
  if (/^\d+\. /.test(line)) {
    const ref = 'num' + (numberRef++);
    numConfigs.push({
      reference: ref,
      levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
    });
    while (i < lines.length && /^\d+\. /.test(lines[i])) {
      children.push(new Paragraph({ numbering: { reference: ref, level: 0 }, children: runs(lines[i].replace(/^\d+\. /, '')) }));
      i++;
    }
    continue;
  }
  let buf = line;
  i++;
  while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf += ' ' + lines[i++];
  children.push(new Paragraph({ spacing: { after: 120 }, children: runs(buf) }));
}

// A static contents list with links, placed after the title and the first
// block that follows it. Static so it is never empty when the file is opened.
const toc = [
  new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: [new TextRun('Contents')] }),
  ...contents.map(c => new Paragraph({
    spacing: { after: 40 },
    children: [new InternalHyperlink({ anchor: c.anchor, children: [new TextRun({ text: c.text, color: '2F5496' })] })],
  })),
  new Paragraph({ children: [] }),
];
if (contents.length) children.splice(firstSectionIndex, 0, ...toc);

const stamp = `${path.basename(src)} · generated ${new Date().toISOString().slice(0, 10)} · `;
const footer = new Footer({
  children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({ text: stamp, size: 16, color: '666666' }),
      new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 16, color: '666666' }),
    ],
  })],
});

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Calibri', size: 22 } } },
    paragraphStyles: [
      { id: 'Title', name: 'Title', basedOn: 'Normal', run: { size: 44, bold: true, color: '1F3864' }, paragraph: { spacing: { after: 200 } } },
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 30, bold: true, color: '1F3864' }, paragraph: { spacing: { before: 320, after: 140 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 26, bold: true, color: '2F5496' }, paragraph: { spacing: { before: 240, after: 100 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 23, bold: true, color: '2F5496' }, paragraph: { spacing: { before: 180, after: 80 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      ...numConfigs,
    ],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    footers: { default: footer },
    children,
  }],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes, ${contents.length} sections, ${diagrams} diagrams)`);
});
