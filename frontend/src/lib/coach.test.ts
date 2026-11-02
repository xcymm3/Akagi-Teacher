import { describe, expect, it } from 'vitest'
import { formatCoach } from './coach'
import type { CandidateFacts, CoachFacts, HelperMetrics } from '@/types'
const candidate = (pai: string, shanten = 2, effective = 20): CandidateFacts => ({
  action: { type: 'dahai', actor: 0, pai, tsumogiri: false }, shanten,
  effective_tiles: effective, safe_against: [], isolated: false,
  keeps_dora: false, discards_dora: false, flush_suit: null,
})
const metric = (n: number): HelperMetrics => ({ shanten: 2, ukeire: n, next: 18, improve: n + 2,
  improve_tiles: [2, 3], speed: 40, win: 0, dama: 0, riichi: 0, round: 0, furiten: 0, yaku: [], part: false })
const facts = (): CoachFacts => ({ seat: 0, num_players: 4, best_shanten: 2, riichi_seats: [], closed_hand: true,
  candidates: [candidate('9p'), candidate('4s'), candidate('2m')],
  helper: { version: 'test', preferred_index: 0, reference_only: false, ranked: [],
    candidates: [metric(20), metric(20), metric(20)], followup: [-1, -1, -1], opponents: [] },
})
describe('Go teaching evidence renderer', () => {
  it('uses the upstream preference while preserving policy order and inputs', () => {
    const input = facts(), before = structuredClone(input)
    expect(formatCoach(input).summary).toBe('建议打9筒。')
    expect(formatCoach(input).labels).toEqual(['9筒', '4条', '2万'])
    expect(input).toEqual(before)
  })
  it('explains a preference difference using subsequent acceptance rather than maximum immediate ukeire', () => {
    const input = facts()
    input.helper!.preferred_index = 1
    input.helper!.candidates[1] = { ...metric(16), next: 28, speed: 65 }
    const text = formatCoach(input)
    expect(text.summary).toBe('模型首选9筒；4条后续进张与速度评分更高。')
    expect(text.reasons[1]).toContain('平均进张约28.0枚')
    expect(text.reasons.join('')).not.toMatch(/不是宝牌|按向听|模型思考|原排序/)
  })
  it('renders passed-tile defence against a specific player without greed badges', () => {
    const input = facts()
    input.helper!.opponents = [{ seat: 2, tenpai: 30, loss: 3000, risk: Array(34).fill(5),
      safe: Array(34).fill(false), passed: Array(34).fill(false) }]
    input.helper!.opponents[0].safe[17] = true
    input.helper!.opponents[0].passed[17] = true
    input.candidates[0].keeps_dora = true
    input.candidates[1].discards_dora = true
    const text = formatCoach(input)
    expect(text.markers[0]).toEqual(['守'])
    expect(text.reasons[0]).toContain('同巡安全：对家')
    expect(text.markers.flat()).not.toContain('贪')
    input.helper!.opponents[0].passed[17] = false
    input.helper!.opponents[0].safe[17] = false
    expect(formatCoach(input).markers[0]).toEqual([])
  })
  it('does not misname sanma seats or attach upstream shanten to unsupported shapes', () => {
    const input = facts()
    input.num_players = 3
    input.candidates[0].safe_against = [2]
    expect(formatCoach(input).reasons[0]).toContain('上家')
    input.candidates[0].shanten = 0
    expect(formatCoach(input).reasons[0]).toContain('听牌')
    expect(formatCoach(input).summary).toBe('')
  })
  it('describes the actual post-call discard and estimated value without generic filler', () => {
    const input = facts()
    input.candidates = [{ ...candidate('9p'), action: { type: 'pon', actor: 0, target: 1, pai: 'E', consumed: ['E', 'E'] }, shanten: null, effective_tiles: null }]
    input.helper!.candidates = [{ ...metric(8), shanten: 0, dama: 3900 }]
    input.helper!.followup = [17]
    const text = formatCoach(input)
    expect(text.reasons[0]).toContain('再打9筒后听牌')
    expect(text.reasons[0]).toContain('3900点')
    expect(text.reasons[0]).not.toMatch(/结合后续|失去门清|模型给出的/)
  })
  it('falls back to baseline on helper failure without inventing a ranking', () => {
    const input = facts()
    input.helper = null; input.helper_error = 'timeout'
    const text = formatCoach(input)
    expect(text.reasons[0]).toBe('2向听，进张20枚。')
    expect(text.summary).toContain('深入分析暂不可用')
    expect(text.summary).not.toContain('建议打')
  })
  it('reports furiten and no-yaku waits without asserting a future yaku is certain', () => {
    const input = facts()
    input.candidates[0].shanten = 0
    input.helper!.candidates[0] = { ...metric(4), shanten: 0, furiten: 1, riichi: 5200 }
    expect(formatCoach(input).reasons[0]).toContain('振听，只能自摸')
    expect(formatCoach(input, 'en').reasons[0]).toContain('Furiten')
  })
})
