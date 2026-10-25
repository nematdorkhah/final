import html2canvas from 'html2canvas'
import { toPersianDigits } from './persianNumbers'
import { sanitizeFileName } from '../useJalaliDate'

/**
 * Format questions for WhatsApp poster:
 * Rule: NO question marks ('؟' or '?') allowed under any circumstances.
 * Uses '=' or clean line/space for solving.
 */
export function cleanQuestionForPoster(raw: string): string {
  if (!raw) return ''
  let text = raw.trim()

  // 1. Remove all question marks (both Persian '؟' and English '?')
  text = text.replace(/=\s*[\?؟]+/g, '=')
  text = text.replace(/[\?؟]+/g, '')
  text = text.trim()

  // 2. If it is an arithmetic / algebraic expression (e.g., 2/3 + 1/4 or 5 × 8), ensure it ends with '='
  const isDirectMathExpr = /^[0-9۰-۹\s+\-×÷/*=()\/.,]+$/.test(text)
  if (isDirectMathExpr && !text.endsWith('=')) {
    text = `${text} =`
  }

  return text
}

/**
 * Capture DOM element and download as high-res PNG
 * Uses scale: 2 for crisp mobile / WhatsApp display
 */
export async function exportWhatsappCardToPng(
  element: HTMLElement,
  fileTitle: string
): Promise<string> {
  if (!element) throw new Error('المان تصویر یافت نشد.')

  // Save current scroll position
  const originalScrollY = window.scrollY

  try {
    const canvas = await html2canvas(element, {
      scale: 2, // High DPI resolution for mobile/WhatsApp
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      logging: false,
      windowWidth: element.scrollWidth,
      windowHeight: element.scrollHeight,
      onclone: (clonedDoc) => {
        // Ensure fonts and direction are applied cleanly in cloned DOM
        const target = clonedDoc.querySelector('[data-whatsapp-card]') as HTMLElement
        if (target) {
          target.style.boxShadow = 'none'
          target.style.margin = '0 auto'
        }
      },
    })

    const dataUrl = canvas.toDataURL('image/png', 1.0)

    // Trigger download
    const cleanName = sanitizeFileName(fileTitle || 'whatsapp-poster')
    const link = document.createElement('a')
    link.download = `${cleanName}.png`
    link.href = dataUrl
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)

    return dataUrl
  } finally {
    window.scrollTo(0, originalScrollY)
  }
}

/**
 * Format date nicely for poster footer
 */
export function formatPosterDate(dateStr?: string | null): string {
  if (!dateStr) {
    return toPersianDigits(new Date().toLocaleDateString('fa-IR'))
  }
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return toPersianDigits(dateStr)
    return toPersianDigits(
      d.toLocaleDateString('fa-IR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    )
  } catch {
    return toPersianDigits(dateStr)
  }
}
