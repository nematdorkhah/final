export function sanitizeTeacherFeedback(text: string | null | undefined): string {
  if (!text) return ''
  let cleaned = String(text).trim()

  // Remove code blocks and JSON artifacts
  cleaned = cleaned.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim()
  cleaned = cleaned.replace(/^\{[\s\S]*"teacherSummaryNote"\s*:\s*"([^"]+)"[\s\S]*\}$/i, '$1')

  // Remove AI / prompt meta instructions if any leaked
  cleaned = cleaned.replace(/^نکته:|^توجه:|^پاسخ هوش مصنوعی:|^بازخورد:/gi, '').trim()

  return cleaned
}
