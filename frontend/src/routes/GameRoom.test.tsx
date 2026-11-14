import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GameRoom } from './GameRoom'
import { useNotifyStore } from '@/stores/notifyStore'
import { useHistoryStore } from '@/stores/historyStore'
import { useConfigStore } from '@/stores/configStore'
import type { AppConfig, GameRecord } from '@/types'

const { invoke } = vi.hoisted(() => ({ invoke:vi.fn() }))
vi.mock('@/lib/tauri', () => ({ invoke }))
vi.mock('@/hooks/useEmbeddedGame', () => ({ useEmbeddedGame: () => '' }))
vi.mock('@/components/BotShowList', () => ({ BotShowList: ({items}:{items:unknown[]}) => <p>原始候选：{items.length}</p> }))
vi.mock('@/components/history/GameDetailDialog', () => ({ GameDetailDialog: ({record}:{record:GameRecord|null}) => record ? <p>记录详情：{record.id}</p> : null }))

describe('single-window game room', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined)
    useConfigStore.setState({config:{autoplay:{enabled:false}} as AppConfig})
    useNotifyStore.setState({events:[],responses:[]})
    useHistoryStore.setState({records:[],loading:false})
  })
  it('shows at most three original choices and provides settings/history access', () => {
    useNotifyStore.getState().pushResponse({type:'none',meta:{show:{items:[1,2,3,4].map(i=>({label:`${i}`,value:'25%'}))}}})
    render(<MemoryRouter><GameRoom /></MemoryRouter>)
    expect(screen.getByRole('region',{name:'雀魂游戏'})).toBeDefined()
    expect(screen.getByText('原始候选：3')).toBeDefined()
    expect(screen.getByRole('link',{name:'设置'}).getAttribute('href')).toBe('/settings')
    expect(screen.getByRole('link',{name:'全部记录'}).getAttribute('href')).toBe('/history')
  })
  it('opens a recorded game and toggles autoplay without changing other settings', async () => {
    useHistoryStore.setState({records:[{id:'game-1',platform:'majsoul',started_at:'2026-11-14T12:00:00Z',num_players:4,kyoku_mode:'east_south',our_seat:0,our_rank:1,final_scores:[40000,25000,20000,15000],our_delta:15000} as GameRecord]})
    render(<MemoryRouter><GameRoom /></MemoryRouter>)
    fireEvent.click(screen.getByText('1位'))
    expect(screen.getByText('记录详情：game-1')).toBeDefined()
    fireEvent.click(screen.getByRole('switch',{name:'自动打牌'}))
    await waitFor(()=>expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
    expect(invoke).toHaveBeenCalledWith('set_autoplay_enabled',{enabled:true})
  })
})
