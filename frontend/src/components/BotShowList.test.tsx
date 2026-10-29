import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CoachFacts, ShowItem, ShowMeta } from '@/types'
import { BotShowList } from './BotShowList'

const { useCoach } = vi.hoisted(() => ({ useCoach: vi.fn() }))
vi.mock('@/hooks/useCoach', () => ({ useCoach }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'zh-CN' } }) }))
vi.mock('@/components/Mahgen', () => ({ Mahgen: ({ seq }: { seq: string }) => <span>{seq}</span> }))

const items: ShowItem[] = ['9p', '4s', '2m'].map((pai, i) => ({ label: 'Discard', pais: [pai], value: ['40%', '40%', '20%'][i] }))
const facts: CoachFacts = {
  seat: 0, num_players: 4, best_shanten: 2, riichi_seats: [2], closed_hand: true,
  candidates: ['9p', '4s', '2m'].map((pai, i) => ({
    action: { type: 'dahai', actor: 0, pai, tsumogiri: false }, shanten: i === 1 ? 3 : 2,
    effective_tiles: [24, 12, 16][i], safe_against: i === 1 ? [2] : [],
    isolated: false, keeps_dora: false, discards_dora: false, flush_suit: null,
  })),
}

describe('shared dashboard/overlay coaching view', () => {
  it('keeps model percentages and attaches each reason to its own candidate', () => {
    useCoach.mockReturnValue({ available: true, pending: false, facts })
    render(<BotShowList items={items} show={{ items } as ShowMeta} variant="overlay" />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('9筒')).toBeDefined()
    expect(within(rows[1]).getByText('4条')).toBeDefined()
    expect(within(rows[1]).getByText(/对家.*现物/)).toBeDefined()
    const marker = within(rows[1]).getByText('守')
    expect(marker.parentElement?.parentElement?.textContent).toBe('40%守')
    expect(within(rows[2]).getByText('20%')).toBeDefined()
    expect(screen.getAllByText('40%')).toHaveLength(2)
    expect(screen.queryByText(/进张按未见牌估算/)).toBeNull()
    expect(screen.getByRole('note').textContent).toContain('建议打9筒。')
  })
  it('retains the original recommendation when analysis fails', () => {
    useCoach.mockReturnValue({ available: true, pending: false, facts: null })
    render(<BotShowList items={items.slice(0, 1)} />)
    expect(screen.getByText('40%')).toBeDefined()
    expect(screen.getByText(/暂无法取得解释/)).toBeDefined()
    expect(screen.queryByRole('note')).toBeNull()
  })
})
