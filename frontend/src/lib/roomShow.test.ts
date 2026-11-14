import { describe, expect, it } from 'vitest'
import { roomShow } from './roomShow'
import type { BotResponse, MjaiEvent } from '@/types'

const response = (seq: number, folding = false) => ({ _seq: seq, type: 'none', meta: { show: {
  items: [{ label: 'Discard', pais: ['9p'], value: '66%' }], fold: folding ? { active: true } : undefined,
} } }) as BotResponse & { _seq: number }
const event = (type: string, seq: number) => ({ type, _seq: seq }) as MjaiEvent & { _seq: number }

describe('embedded room recommendation lifecycle', () => {
  it('keeps the most recent actual show when a bare response arrives', () => {
    expect(roomShow([response(2), { _seq: 3, type:'none' }], [event('start_kyoku',1)])?.items[0].value).toBe('66%')
  })
  it('drops previous-hand suggestions, including fold mode, at the next hand', () => {
    expect(roomShow([response(2,true)], [event('start_kyoku',3)])).toBeNull()
    expect(roomShow([response(2)], [event('end_game',3)])).toBeNull()
  })
  it('keeps fold feedback at hand end but clears normal recommendations', () => {
    expect(roomShow([response(2,true)], [event('end_kyoku',3)])?.fold?.active).toBe(true)
    expect(roomShow([response(2)], [event('end_kyoku',3)])).toBeNull()
  })
})
