import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessoryHistory } from './AccessoryTools'
import { useHistoryStore } from '@/stores/historyStore'
import { useConfigStore } from '@/stores/configStore'
import type { GameRecord, AppConfig } from '@/types'
const { openExternal, copyText } = vi.hoisted(() => ({openExternal:vi.fn(),copyText:vi.fn().mockResolvedValue(undefined)}))
vi.mock('@/lib/external', () => ({openExternal}))
vi.mock('@/lib/clipboard', () => ({copyText}))
vi.mock('@/components/history/RankPieChart', () => ({RankPieChart: () => null}))
vi.mock('@/components/history/CumulativePtChart', () => ({CumulativePtChart: () => null}))
vi.mock('@/components/history/GameDetailDialog', () => ({GameDetailDialog: ({record,onOpenChange,localOnly}:{record:GameRecord|null;onOpenChange:(value:boolean)=>void;localOnly:boolean}) => record ? <button onClick={() => onOpenChange(false)}>关闭本地详情 {String(localOnly)}</button> : null}))
const record = {id:'one',platform:'majsoul',num_players:4,our_seat:0,our_rank:1,our_rank_points:150,started_at:'2026-11-01T00:00:00Z',kyoku_mode:'east_south',stats:{round:4,agari:1,houjuu:0},match_info:{platform:'majsoul',game_uuid:'replay-id'}} as GameRecord

describe('accessory tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useHistoryStore.setState({records:[],loading:false})
    useConfigStore.setState({config:{autoplay:{enabled:true},capture:{chromium:{start_url:'https://game.maj-soul.com/1/'}}} as AppConfig})
  })
  it('keeps the selected replay accessible after closing local detail', () => {
    useHistoryStore.setState({records:[record]})
    render(<AccessoryHistory />)
    fireEvent.click(screen.getByText('第1名'))
    fireEvent.click(screen.getByText('关闭本地详情 true'))
    fireEvent.click(screen.getByRole('button',{name:'打开雀魂牌谱'}))
    expect(openExternal).toHaveBeenCalledWith('https://game.maj-soul.com/1/?paipu=replay-id')
    fireEvent.click(screen.getByRole('button',{name:'复制牌谱编号'}))
    expect(copyText).toHaveBeenCalledWith('replay-id')
  })
})
