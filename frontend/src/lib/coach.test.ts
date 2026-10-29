import { describe, expect, it } from 'vitest'
import { formatCoach } from './coach'
import type { CandidateFacts, CoachFacts } from '@/types'

const candidate = (pai: string, shanten: number, effective: number, safe: number[] = []): CandidateFacts => ({
  action: { type: 'dahai', actor: 0, pai, tsumogiri: false }, shanten,
  effective_tiles: effective, safe_against: safe, isolated: false,
  keeps_dora: false, discards_dora: false, flush_suit: null,
})
const facts = (): CoachFacts => ({ seat: 0, num_players: 4, best_shanten: 2,
  riichi_seats: [2], closed_hand: true,
  candidates: [candidate('9p', 2, 24), candidate('4s', 3, 12, [2]), candidate('2m', 2, 16)],
})

describe('candidate teaching evidence', () => {
  it('compares speed and genbutsu without reordering or mutating the model output', () => {
    const input = facts()
    const before = structuredClone(input)
    const text = formatCoach(input)
    expect(text.reasons).toHaveLength(3)
    expect(text.reasons[0]).toContain('2向听')
    expect(text.reasons[1]).toContain('对家')
    expect(text.reasons[1]).not.toContain('九万')
    expect(text.reasons[2]).toContain('少约8枚')
    expect(text.summary).toBe('建议打9筒。')
    expect(text.markers[1]).toEqual(['守'])
    expect(text.reasons.join('')).not.toMatch(/未见牌口径|孤张本身|不等同于/)
    expect(input).toEqual(before)
  })
  it('does not manufacture a safe discard or claim pass means folding', () => {
    const input = facts()
    input.candidates.forEach(c => { c.safe_against = [] })
    expect(formatCoach(input).summary).toBe('建议打9筒。')
    input.candidates = [{ ...candidate('9p', 2, 24), action: { type: 'none' }, shanten: null, effective_tiles: null }]
    expect(formatCoach(input).reasons[0]).toContain('保留门清')
    expect(formatCoach(input).summary).not.toContain('最佳出牌')
  })
  it('does not make up flush value, and does not label sanma seats as opposite', () => {
    const input = facts()
    input.num_players = 3
    input.candidates[1].flush_suit = 1
    const text = formatCoach(input)
    expect(text.reasons[1]).toContain('上家')
    expect(text.reasons[1]).toContain('争取染手')
    expect(text.reasons.join('')).not.toContain('对家')
  })
  it('handles riichi with no predicted tile, calls, wins and fewer than three actions', () => {
    const input = facts()
    input.candidates = [{ ...candidate('9p', 2, 24), action: { type: 'reach', actor: 0 }, shanten: null, effective_tiles: null }]
    expect(formatCoach(input).reasons[0]).toContain('通常只能摸切')
    input.candidates[0].action = { type: 'pon', actor: 0, target: 1, pai: 'E', consumed: ['E', 'E'] }
    expect(formatCoach(input).reasons[0]).toContain('失去门清')
    input.candidates[0].action = { type: 'hora', actor: 0, target: 1 }
    expect(formatCoach(input).reasons[0]).toBe('')
    expect(formatCoach(input).summary).toBe('')
  })
  it('omits generic call commentary when the hand is already open', () => {
    const input = facts()
    input.closed_hand = false
    input.candidates = [{ ...candidate('9p', 2, 24), action: { type: 'chi', actor: 0, target: 3, pai: '3p', consumed: ['1p', '2p'] }, shanten: null, effective_tiles: null }]
    expect(formatCoach(input).reasons).toEqual([''])
    expect(formatCoach(input).summary).toBe('')
    input.closed_hand = true
    expect(formatCoach(input).reasons[0]).toBe('副露后失去门清。')
    expect(formatCoach(input).summary).not.toMatch(/按原模型|尚未做|结合后续/)
  })
  it('marks value only when supported by a comparative efficiency tradeoff', () => {
    const input = facts()
    input.candidates[0].discards_dora = true
    input.candidates[2].keeps_dora = true
    expect(formatCoach(input).markers[2]).toEqual(['贪'])
    input.candidates[0].discards_dora = false
    expect(formatCoach(input).markers[2]).toEqual([])
    input.candidates[2].flush_suit = 1
    expect(formatCoach(input).markers[2]).toEqual(['贪'])
    input.candidates[2].effective_tiles = 30
    expect(formatCoach(input).markers[2]).toEqual([])
  })
  it('reports the supplied example as a model preference versus an immediate-count difference', () => {
    const input = facts()
    input.best_shanten = 5
    input.riichi_seats = []
    input.candidates = [candidate('9s', 5, 69), candidate('8m', 5, 90), candidate('W', 5, 78)]
    const before = structuredClone(input)
    const text = formatCoach(input)
    expect(text.reasons).toEqual([
      '打出后为5向听，进张约69枚。同向听下少约21枚进张。',
      '打出后为5向听，进张约90枚，三个候选中最多。',
      '打出后为5向听，进张约78枚。同向听下少约12枚进张。',
    ])
    expect(text.summary).toBe('模型首选9条；但8万的即时进张更多。')
    expect(text.reasons.join('')).not.toMatch(/更快|更利于|推进较慢/)
    expect(text.markers).toEqual([[], [], []])
    expect(input).toEqual(before)
  })
  it('does not invent a disagreement for tied metrics or compare unlike actions', () => {
    const input = facts()
    input.candidates[1].shanten = 2
    input.candidates[1].effective_tiles = 24
    expect(formatCoach(input).summary).toBe('建议打9筒。')
    expect(formatCoach(input).reasons[0]).toContain('并列最多')
    input.candidates[0].shanten = 3
    expect(formatCoach(input).summary).toBe('模型首选9筒；但4条打出后为2向听，向听数更低。')
    input.candidates[0].shanten = null
    expect(formatCoach(input).summary).toBe('')
    input.candidates[0].action = { type: 'none' }
    expect(formatCoach(input).summary).toBe('')
  })
  it('falls back honestly for missing discard evidence', () => {
    const input = facts()
    input.candidates[0].shanten = null
    input.candidates[0].effective_tiles = null
    expect(formatCoach(input).reasons[0]).toBe('')
    expect(formatCoach(input, 'en').reasons[1]).toContain('Genbutsu')
  })
})
