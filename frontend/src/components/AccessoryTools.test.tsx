import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessoryAnalysis, AccessoryHistory, AccessoryOverview } from './AccessoryTools'
import { useHistoryStore } from '@/stores/historyStore'
import { useGameStore } from '@/stores/gameStore'
import { useAnalysisStore } from '@/stores/analysisStore'
import { useBotStore } from '@/stores/botStore'
import { useCaptureStore } from '@/stores/captureStore'
import { useConfigStore } from '@/stores/configStore'
import type { GameRecord, GameStateSnapshot, AnalysisResult, AppConfig } from '@/types'
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
    useGameStore.setState({game:null})
    useAnalysisStore.setState({result:null})
    useConfigStore.setState({config:{autoplay:{enabled:true},capture:{chromium:{start_url:'https://game.maj-soul.com/1/'}}} as AppConfig})
    useBotStore.setState({status:{state:'ready',bot:'native-4p',actor_id:0}})
    useCaptureStore.setState({status:{state:'running',kind:'chromium',descriptor:'内嵌雀魂'}})
  })
  it('restores read-only model and connection information without model-management actions', () => {
    render(<AccessoryOverview />)
    expect(screen.getByText('native-4p')).toBeDefined()
    expect(screen.getByText('已连接')).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
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
  it('shows the original engine risk data without changing autoplay', () => {
    useGameStore.setState({game:{is_done:false,our_seat:0,num_players:4,players:[{tehai:['1m','9s']}]} as GameStateSnapshot})
    useAnalysisStore.setState({result:{seat:0,state:'discard14',hand13:null,hand14:null,best_attack_discard:null,best_defence_discard:null,shanten:2,turn:5,mixed_risk:Array.from({length:34},(_,i) => i === 0 ? 2 : 11),opponents:[{seat:1,is_riichi:true,tenpai_rate:100,risk:[]}]} as AnalysisResult})
    render(<AccessoryAnalysis />)
    expect(screen.getByText('2.0%')).toBeDefined()
    expect(screen.getByText('11.0%')).toBeDefined()
    expect(screen.getByText('立直')).toBeDefined()
    expect(useConfigStore.getState().config?.autoplay.enabled).toBe(true)
  })
})
