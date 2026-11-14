import { pickShow } from './botShow'
import type { BotResponse, MjaiEvent, ShowMeta } from '@/types'

export function roomShow(responses: Array<BotResponse & { _seq: number }>, events: Array<MjaiEvent & { _seq: number }>): ShowMeta | null {
  const start = events.findLast(e => ['start_game', 'start_kyoku', 'end_game'].includes(e.type))?._seq ?? 0
  const end = events.findLast(e => e.type === 'end_kyoku')?._seq ?? 0
  for (let i = responses.length - 1; i >= 0; i--) {
    if (responses[i]._seq < start) break
    const show = pickShow(responses[i].meta)
    if (!show) continue
    if (responses[i]._seq < end && !show.fold?.active) return null
    return show
  }
  return null
}
