import type { GameRecord } from '@/types'
import type { CumulativePoint } from '@/lib/ptCalc'
export function recordSummary(records: GameRecord[], numPlayers: 3 | 4) {
  const games = records.filter(r => r.platform === 'majsoul' && r.num_players === numPlayers && r.our_seat != null)
  const ranked = games.filter(r => r.our_rank != null)
  const known = games.filter(r => r.our_rank_points != null).toSorted((a,b) => a.started_at.localeCompare(b.started_at))
  const ranks = Array.from({length:numPlayers}, (_,i) => ranked.filter(r => r.our_rank === i+1).length)
  const sum = (key: 'round' | 'agari' | 'houjuu') => games.reduce((n,r) => n + (r.stats?.[key] ?? 0), 0)
  const rounds = sum('round')
  let cumulative = 0
  const series: CumulativePoint[] = known.map((record,index) => {
    const delta = record.our_rank_points!
    cumulative += delta
    return {index,delta,cumulative,record}
  })
  return { games, ranks, series, points:known.length ? cumulative : null, known:known.length,
    average:ranked.length ? ranked.reduce((n,r) => n + r.our_rank!,0)/ranked.length : null,
    win:rounds ? sum('agari')/rounds*100 : null, dealIn:rounds ? sum('houjuu')/rounds*100 : null }
}

export function majsoulReplayUrl(startUrl: string | undefined, replay: string) {
  let base = new URL('https://game.maj-soul.com/1/')
  try {
    const candidate = new URL(startUrl || base.toString())
    if (candidate.protocol === 'https:' && ['maj-soul.com','majsoul.com','mahjongsoul.com','mahjongsoul.game.yo-star.com'].some(host => candidate.hostname === host || candidate.hostname.endsWith(`.${host}`))) base = candidate
  } catch { /* use the default official server */ }
  base.search = new URLSearchParams({paipu:replay}).toString()
  base.hash = ''
  return base.toString()
}
