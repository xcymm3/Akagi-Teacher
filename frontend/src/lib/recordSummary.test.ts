import { describe, expect, it } from 'vitest'
import { recordSummary, majsoulReplayUrl } from './recordSummary'
import type { GameRecord } from '@/types'
const game = (id:string,points:number|null,rank:number,overrides:Partial<GameRecord> = {}) => ({id,platform:'majsoul',num_players:4,our_seat:0,our_rank:rank,our_rank_points:points,our_delta:15000,started_at:`2026-11-${id}T00:00:00Z`,stats:{round:4,agari:1,houjuu:1},...overrides} as GameRecord)
describe('actual settlement summary', () => {
  it('uses the configured official server for replay and encodes its identifier', () => {
    expect(majsoulReplayUrl('https://game.maj-soul.com/1/', 'uuid&x=1')).toBe('https://game.maj-soul.com/1/?paipu=uuid%26x%3D1')
    expect(new URL(majsoulReplayUrl('https://evil.test/', 'uuid')).hostname).toBe('game.maj-soul.com')
  })
  it('separates player counts and spectators, never substitutes table-score deltas for missing rank points', () => {
    const summary = recordSummary([game('01',150,1),game('02',null,2),game('03',-180,4),game('04',999,1,{num_players:3}),game('05',999,1,{our_seat:null}),game('06',999,1,{platform:'tenhou'})],4)
    expect(summary.games).toHaveLength(3)
    expect(summary.ranks).toEqual([1,1,0,1])
    expect(summary.known).toBe(2)
    expect(summary.points).toBe(-30)
    expect(summary.series.map(p => p.cumulative)).toEqual([150,-30])
    expect(summary.win).toBe(25)
    expect(summary.dealIn).toBe(25)
  })
  it('keeps real zero-point settlements and reports unknown totals honestly', () => {
    expect(recordSummary([game('01',0,2)],4).points).toBe(0)
    expect(recordSummary([game('01',null,2)],4).points).toBeNull()
    expect(recordSummary([],4).average).toBeNull()
  })
})
