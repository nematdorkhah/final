import { supabase } from './supabaseClient'

export async function getSignedFileUrl(path: string): Promise<string> {
  if (!path) return ''

  // If already an absolute HTTP URL, return as-is
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
    return path
  }

  try {
    // 1. Try public URL from submissions bucket
    const { data: subData } = supabase.storage.from('submissions').getPublicUrl(path)
    if (subData?.publicUrl) {
      return subData.publicUrl
    }

    // 2. Fallback to signed URL (valid for 1 hour)
    const { data: signedData, error } = await supabase.storage
      .from('submissions')
      .createSignedUrl(path, 3600)

    if (!error && signedData?.signedUrl) {
      return signedData.signedUrl
    }

    // 3. Try materials bucket as fallback
    const { data: matData } = supabase.storage.from('materials').getPublicUrl(path)
    if (matData?.publicUrl) {
      return matData.publicUrl
    }
  } catch (err) {
    console.warn('Failed getting signed URL for file:', path, err)
  }

  // Final fallback to relative path or empty
  return path
}
