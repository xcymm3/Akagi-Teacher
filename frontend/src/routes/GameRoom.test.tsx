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
    fireEvent.click(screen.getByRole('button',{name:'设置'}))
    expect(invoke).toHaveBeenCalledWith('open_settings', { tab: null })
    expect(screen.getByRole('region',{name:'雀魂游戏'})).toBeDefined()
    expect(invoke).not.toHaveBeenCalledWith('set_autoplay_enabled', expect.anything())
    fireEvent.click(screen.getByRole('button',{name:'全部记录'}))
    expect(invoke).toHaveBeenCalledWith('open_settings', {tab:'history'})
  })
  it('opens accessory settings while autoplay remains enabled and the game stays mounted', () => {
    useConfigStore.setState({config:{autoplay:{enabled:true}} as AppConfig})
    render(<MemoryRouter><GameRoom /></MemoryRouter>)
    const game = screen.getByRole('region',{name:'雀魂游戏'})
    fireEvent.click(screen.getByRole('button',{name:'设置'}))
    expect(screen.getByRole('region',{name:'雀魂游戏'})).toBe(game)
    expect(screen.getByRole('switch',{name:'自动打牌'}).getAttribute('aria-checked')).toBe('true')
    expect(invoke).not.toHaveBeenCalledWith('set_autoplay_enabled', expect.anything())
  })
  it('shows settings-open progress and surfaces failures without changing autoplay', async () => {
    let fail!: (reason: Error) => void
    invoke.mockImplementation((name: string) => name === 'open_settings' ? new Promise((_, reject) => { fail = reject }) : Promise.resolve(undefined))
    useConfigStore.setState({config:{autoplay:{enabled:true}} as AppConfig})
    render(<MemoryRouter><GameRoom /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button',{name:'设置'}))
    expect(screen.getByRole('button',{name:'设置'}).getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('button',{name:'设置'})).toHaveProperty('disabled',true)
    fail(new Error('无法创建窗口'))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','打开设置失败：Error: 无法创建窗口')
    expect(screen.getByRole('button',{name:'设置'})).toHaveProperty('disabled',false)
    expect(screen.getByRole('switch',{name:'自动打牌'}).getAttribute('aria-checked')).toBe('true')
  })
  it('shows the continuous-play phase while the master switch is enabled', async () => {
    invoke.mockImplementation((name: string) => Promise.resolve(name === 'get_autoplay_session_status' ? {phase:'running',message:'正在排队，等待匹配',completed:1} : undefined))
    useConfigStore.setState({config:{autoplay:{enabled:true}} as AppConfig})
    render(<MemoryRouter><GameRoom /></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('正在排队，等待匹配'))
  })
  it.each([[-180, '-180分'], [0, '0分'], [undefined, '上分数据缺失']])('renders rank-point change %s without falling back to table points', (points, label) => {
    useHistoryStore.setState({records:[{id:'points',platform:'majsoul',started_at:'2026-11-14T12:00:00Z',num_players:4,kyoku_mode:'east_south',our_seat:0,our_rank:4,final_scores:[40000],our_delta:15000,our_rank_points:points} as GameRecord]})
    render(<MemoryRouter><GameRoom /></MemoryRouter>)
    expect(screen.getByText(label as string)).toBeDefined()
    expect(screen.queryByText('+15,000')).toBeNull()
  })
  it('opens a recorded game and toggles autoplay without changing other settings', async () => {
    useHistoryStore.setState({records:[{id:'game-1',platform:'majsoul',started_at:'2026-11-14T12:00:00Z',num_players:4,kyoku_mode:'east_south',our_seat:0,our_rank:1,final_scores:[40000,25000,20000,15000],our_delta:15000,our_rank_points:150} as GameRecord]})
    render(<MemoryRouter><GameRoom /></MemoryRouter>)
    expect(screen.getByText('+150分')).toBeDefined()
    expect(screen.queryByText('40,000')).toBeNull()
    fireEvent.click(screen.getByText('第1名'))
    expect(screen.getByText('记录详情：game-1')).toBeDefined()
    fireEvent.click(screen.getByRole('switch',{name:'自动打牌'}))
    await waitFor(()=>expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
    expect(invoke).toHaveBeenCalledWith('set_autoplay_enabled',{enabled:true})
  })
})
