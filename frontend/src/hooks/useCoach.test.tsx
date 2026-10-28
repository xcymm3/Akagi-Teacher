import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoachFacts, ShowMeta } from '@/types'
import { useCoach } from './useCoach'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ invoke }))

const show = (id: number) => ({ items: [], coach: { snapshot: { turn_count: id }, actions: [] } }) as unknown as ShowMeta
const fact = (seat: number) => ({ seat }) as CoachFacts

describe('async coaching isolation', () => {
  beforeEach(() => invoke.mockReset())
  it('ignores an older completion when the displayed decision has changed', async () => {
    let first!: (v: CoachFacts) => void
    let second!: (v: CoachFacts) => void
    invoke.mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { second = resolve }))
    const a = show(9101), b = show(9102)
    const { result, rerender } = renderHook(({ value }) => useCoach(value), { initialProps: { value: a } })
    expect(result.current.pending).toBe(true)
    rerender({ value: b })
    await act(async () => { first(fact(1)) })
    expect(result.current.facts).toBeNull()
    await act(async () => { second(fact(2)) })
    expect(result.current.facts?.seat).toBe(2)
  })
  it('does not request analysis for external cards and tolerates IPC failure', async () => {
    const { result, rerender } = renderHook(({ value }) => useCoach(value), { initialProps: { value: null as ShowMeta | null } })
    expect(invoke).not.toHaveBeenCalled()
    invoke.mockRejectedValueOnce(new Error('unavailable'))
    rerender({ value: show(9103) })
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.facts).toBeNull()
    expect(result.current.available).toBe(true)
  })
})
