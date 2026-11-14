import { describe, expect, it } from 'vitest'
import { foldSummary } from './fold'
import type { FoldDecision } from '@/types'

const fold = {
  active: true, reason: '旧的进入原因', action: { type: 'dahai', actor: 1, pai: '8p', tsumogiri: false },
  fallback: false, risk: 1,
  snapshot: { our_seat: 1, num_players: 4 },
  flush_threats: [{ seat: 3, suit: 'm', level: 'high', tenpai_reference: 68.2 }],
} as FoldDecision

describe('fold current flush explanation', () => {
  it('uses current threat and relative seat, without displaying a fake probability', () => {
    expect(foldSummary(fold, true)).toBe('建议弃和，危险度最低：8筒。防范：对家疑似万字染手。')
    expect(foldSummary(fold, true)).not.toContain('68.2')
    expect(foldSummary(fold, false)).toContain('P3 possible characters flush')
  })
  it('removes the warning when current evidence rules out the flush', () => {
    expect(foldSummary({ ...fold, flush_threats: [] }, true)).toBe('建议弃和，危险度最低：8筒。')
    expect(foldSummary({ ...fold, flush_threats: [{ ...fold.flush_threats![0], level: 'watch' }] }, true)).not.toContain('防范')
  })
  it('keeps current threat information during basic defence fallback', () => {
    const text = foldSummary({ ...fold, fallback: true }, true)
    expect(text).toContain('对家疑似万字染手')
    expect(text).toContain('当前使用基础防守')
  })
})
