import { useEffect, useState } from 'react'
import { invoke } from '@/lib/tauri'
import type { CoachFacts, ShowMeta } from '@/types'

// Per-webview bounded cache also coalesces React StrictMode/double mounts.
const cache = new Map<string, Promise<CoachFacts | null>>()
export function useCoach(show: ShowMeta | null) {
  const request = show?.coach
  const key = request ? JSON.stringify(request) : ''
  const [result, setResult] = useState<{ key: string; facts: CoachFacts | null } | null>(null)
  useEffect(() => {
    if (!key) return
    let active = true
    let promise = cache.get(key)
    if (!promise) {
      promise = invoke<CoachFacts>('explain_bot_candidates', { request: JSON.parse(key) })
        .catch(() => null)
      cache.set(key, promise)
      if (cache.size > 24) cache.delete(cache.keys().next().value!)
    }
    void promise.then(facts => { if (active) setResult({ key, facts }) })
    return () => { active = false }
  }, [key])
  // Old completions never decorate a newer recommendation, even while loading.
  return { facts: result?.key === key ? result.facts : null,
    pending: Boolean(key && result?.key !== key), available: Boolean(key) }
}
