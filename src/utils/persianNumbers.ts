const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹']
const ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩']

export function toPersianDigits(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  return str.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d)
}

export function toEnglishDigits(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  let str = String(value)
  for (let i = 0; i < 10; i++) {
    str = str.replace(new RegExp(PERSIAN_DIGITS[i], 'g'), String(i))
    str = str.replace(new RegExp(ARABIC_DIGITS[i], 'g'), String(i))
  }
  return str
}
