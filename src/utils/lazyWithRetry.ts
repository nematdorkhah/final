import { lazy, ComponentType } from 'react'

/**
 * Resilient lazy loader for code-split components.
 * Retries failed chunk downloads (useful for unstable mobile/IR networks)
 * and reloads the page once if a deployment updated asset hashes.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  retries = 2,
  interval = 800
) {
  return lazy(() =>
    new Promise<{ default: T }>((resolve, reject) => {
      const attempt = (remaining: number) => {
        factory()
          .then(resolve)
          .catch((error) => {
            if (remaining > 0) {
              setTimeout(() => attempt(remaining - 1), interval)
            } else {
              const msg = error?.message || ''
              const isChunkError =
                error?.name === 'ChunkLoadError' ||
                /failed to fetch dynamically imported module/i.test(msg) ||
                /loading.*chunk/i.test(msg) ||
                /importing.*failed/i.test(msg)

              if (isChunkError && typeof window !== 'undefined') {
                const reloadKey = 'app_chunk_reload_attempted'
                const alreadyReloaded = sessionStorage.getItem(reloadKey)
                if (!alreadyReloaded) {
                  sessionStorage.setItem(reloadKey, String(Date.now()))
                  window.location.reload()
                  return
                }
              }
              reject(error)
            }
          })
      }
      attempt(retries)
    })
  )
}
