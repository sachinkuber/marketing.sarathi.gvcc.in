import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'

// PDFs generated in memory, so no large fixture file is committed.
// Each page can carry a ballast stream of the given size: the page's size on disk, as a brochure's images are.
export async function pdfOf(
  pageBallast: number[] | number,
  options: { text?: boolean; linkFirstToLast?: boolean; sharedImage?: number } = {},
): Promise<Buffer> {
  const ballast = typeof pageBallast === 'number' ? Array.from({ length: pageBallast }, () => 0) : pageBallast
  const doc = await PDFDocument.create()
  const font = options.text ? await doc.embedFont(StandardFonts.Helvetica) : null
  ballast.forEach((size, i) => {
    const page = doc.addPage([300, 300])
    if (font) page.drawText(`Page ${i + 1}`, { x: 20, y: 150, size: 18, font })
    if (size > 0) {
      const stream = doc.context.stream(Buffer.alloc(size, (i % 250) + 1), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 1, 1],
      })
      page.node.setXObject(PDFName.of(`Ballast${i}`), doc.context.register(stream))
    }
  })
  if (options.linkFirstToLast) {
    // A link on page 1 whose destination is the last page, as an interactive brochure's contents page has.
    const pages = doc.getPages()
    const link = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [0, 0, 10, 10],
      Dest: [pages[pages.length - 1]!.ref, 'Fit'],
    })
    pages[0]!.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]))
  }
  if (options.sharedImage) {
    // One image that every page draws: a copy of any page carries the whole image.
    const image = doc.context.register(
      doc.context.stream(Buffer.alloc(options.sharedImage, 7), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 1, 1],
      }),
    )
    for (const page of doc.getPages()) page.node.setXObject(PDFName.of('Shared'), image)
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}

// The page count of a PDF, read back.
export async function pageCountOf(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount()
}

// A PDF whose trailer names an Encrypt dictionary: it opens only with a password.
export const ENCRYPTED_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[4 0 R]/Count 1>>endobj',
    '4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj',
    `3 0 obj<</Filter/Standard/V 1/R 2/O(${'a'.repeat(32)})/U(${'b'.repeat(32)})/P -4>>endobj`,
    'trailer<</Root 1 0 R/Size 5/Encrypt 3 0 R/ID[<00><00>]>>',
    '%%EOF',
  ].join('\n'),
)
