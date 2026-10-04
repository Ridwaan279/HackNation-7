import type { AppContext, Guide, PrivacyConfig } from '@shared/contracts'
import { getStore } from '../services/store'

export const REFERENCE_EXTENSIONS = ['txt', 'md', 'csv', 'json', 'pdf'] as const
const MAX_TEXT = 60_000

/** Extract text only. Original user files never enter the app's store or an agent prompt. */
export async function extractReference(bytes: Buffer, extension: string): Promise<string> {
  if (!REFERENCE_EXTENSIONS.includes(extension as (typeof REFERENCE_EXTENSIONS)[number])) throw new Error('Choose a PDF, TXT, Markdown, CSV or JSON file.')
  if (bytes.length > 5_000_000) throw new Error('Reference files must be under 5 MB.')
  let text = ''
  if (extension === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true })
    try {
      const pdf = await task.promise
      if (pdf.numPages > 40) throw new Error('Choose a PDF with 40 pages or fewer.')
      const pages: string[] = []
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
        const page = await pdf.getPage(pageNo)
        const content = await page.getTextContent()
        pages.push(content.items.map((item) => 'str' in item ? item.str : '').join(' '))
        page.cleanup()
        if (pages.join('\n').length >= MAX_TEXT) break
      }
      text = pages.join('\n')
    } finally { await task.destroy() }
  } else {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new Error('This file is not plain text.')
  }
  text = text.replace(/\r\n?/g, '\n').trim().slice(0, MAX_TEXT)
  if (text.length < 20) throw new Error('No readable text was found. Scanned PDFs need OCR before attaching.')
  return text
}

export async function readReferenceText(ctx: AppContext, guide: Guide, maxChars = 8_000): Promise<string> {
  const store = getStore(ctx)
  const sections: string[] = []
  for (const reference of guide.references ?? []) {
    const text = await store.readBytes(['references', guide.id, `${reference.id}.txt`], MAX_TEXT * 4).then((b) => b.toString('utf8')).catch(() => '')
    if (text) sections.push(`${reference.name}:\n${text}`)
    if (sections.join('\n\n').length >= maxChars) break
  }
  return sections.join('\n\n').slice(0, maxChars)
}

/** Fail closed if cloud-sharing privacy settings are missing or malformed. */
export async function mayShareGuide(ctx: AppContext, guide: Guide): Promise<boolean> {
  const raw = await getStore(ctx).read<Partial<PrivacyConfig>>(['config', 'privacy.json']).catch(() => null)
  if (!raw || !Array.isArray(raw.local_only_apps) || !raw.local_only_apps.every((key) => typeof key === 'string')) return false
  const localOnly = new Set(raw.local_only_apps.map((key) => key.toLowerCase()))
  const keys = guide.app_keys?.length ? guide.app_keys : [guide.app]
  return keys.every((key) => key && !localOnly.has(key.toLowerCase()) && !localOnly.has(key.toLowerCase().replace(/^browser:/, '')))
}
