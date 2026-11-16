import { useMemo, useState } from 'react'
import { Activity, ArrowUpRight, Copy, History, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GameDetailDialog } from '@/components/history/GameDetailDialog'
import { RankPieChart } from '@/components/history/RankPieChart'
import { CumulativePtChart } from '@/components/history/CumulativePtChart'
import { useBotStore } from '@/stores/botStore'
import { useCaptureStore } from '@/stores/captureStore'
import { useConfigStore } from '@/stores/configStore'
import { useAnalysisStore } from '@/stores/analysisStore'
import { useGameStore } from '@/stores/gameStore'
import { useHistoryStore } from '@/stores/historyStore'
import { recordSummary, majsoulReplayUrl } from '@/lib/recordSummary'
import { kyokuLabel, pct, relativeKind } from '@/lib/format'
import { tileIdx } from '@/lib/tileIdx'
import { copyText } from '@/lib/clipboard'
import { openExternal } from '@/lib/external'
import type { GameRecord } from '@/types'

export function ToolSection({title, children}: {title:string;children:React.ReactNode}) {
  return <section className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs"><h3 className="border-b border-border/60 px-4 py-3 text-sm font-medium">{title}</h3><div className="p-4">{children}</div></section>
}
function Metric({label,value}: {label:string;value:string}) {
  return <div className="min-w-0"><div className="mb-1 text-xs text-muted-foreground">{label}</div><div className="text-xl font-semibold tabular-nums tracking-tight">{value}</div></div>
}
export function AccessoryOverview() {
  const capture = useCaptureStore(s => s.status)
  const bot = useBotStore(s => s.status)
  const autoplay = useConfigStore(s => s.config?.autoplay.enabled ?? false)
  const game = useGameStore(s => s.game)
  const records = useHistoryStore(s => s.records)
  const summary = useMemo(() => recordSummary(records,4),[records])
  const labels: Record<string,string> = {ready:'就绪',running:'已连接',idle:'待命',loading:'加载中',starting:'连接中',error:'异常',stopped:'已停止'}
  return <div className="grid gap-5">
    <ToolSection title="运行状态"><dl className="grid gap-4 text-sm">
      <StatusRow icon={<Activity className="size-4" />} label="雀魂连接" value={labels[capture.state] ?? capture.state} good={capture.state === 'running'} />
      <StatusRow icon={<ShieldCheck className="size-4" />} label="推理引擎" value={labels[bot.state] ?? bot.state} good={bot.state === 'ready'} />
      <StatusRow icon={<History className="size-4" />} label="自动打牌" value={autoplay ? '开启' : '关闭'} good={autoplay} />
      {'bot' in bot && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">当前模型</dt><dd className="break-all text-right font-mono text-xs">{bot.bot}</dd></div>}
      {game && !game.is_done && <div className="flex justify-between"><dt className="text-muted-foreground">当前对局</dt><dd>{kyokuLabel(game.bakaze,game.kyoku)} · {game.honba}本场</dd></div>}
      {capture.state === 'error' && <p role="alert" className="break-words text-xs text-destructive">{capture.error}</p>}
      {bot.state === 'error' && <p role="alert" className="break-words text-xs text-destructive">{bot.error}</p>}
    </dl></ToolSection>
    <ToolSection title="四麻记录概况"><div className="grid grid-cols-3 gap-4"><Metric label="已记录场次" value={String(summary.games.length)} /><Metric label="平均名次" value={summary.average?.toFixed(2) ?? '—'} /><Metric label="已记录上分" value={signed(summary.points)} /></div>
      <p className="mt-4 text-xs text-muted-foreground">上分合计仅包含有结算数据的 {summary.known} 场。</p>
    </ToolSection>
  </div>
}
function StatusRow({icon,label,value,good}:{icon:React.ReactNode;label:string;value:string;good:boolean}) {
  return <div className="flex items-center justify-between gap-4"><dt className="flex items-center gap-2 text-muted-foreground">{icon}{label}</dt><dd className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${good ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />{value}</dd></div>
}
const SEATS = {self:'自己',shimocha:'下家',toimen:'对家',kamicha:'上家'}
const HONORS:Record<string,string> = {E:'东',S:'南',W:'西',N:'北',P:'白',F:'发',C:'中'}
function tileName(tile:string) { return HONORS[tile] ?? tile.replace('m','万').replace('p','筒').replace('s','条').replace('r','（赤）') }
export function AccessoryAnalysis() {
  const analysis = useAnalysisStore(s => s.result)
  const game = useGameStore(s => s.game)
  if (!game || game.is_done || !analysis) return <Empty text="进入对局后显示实时分析" />
  const tiles = game.our_seat == null ? [] : game.players[game.our_seat]?.tehai ?? []
  return <div className="grid gap-5">
    <ToolSection title="手牌概况"><div className="grid grid-cols-3 gap-4"><Metric label="当前向听" value={String(analysis.shanten)} /><Metric label="巡目" value={String(analysis.turn)} /><Metric label="手牌张数" value={String(tiles.length)} /></div></ToolSection>
    <ToolSection title="原分析引擎 · 手牌危险度"><div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
      {tiles.map((tile,i) => {const value = analysis.mixed_risk[tileIdx(tile)];return <div key={`${tile}-${i}`} className="rounded-lg border border-border/70 px-2 py-3 text-center"><div className="text-sm font-medium">{tileName(tile)}</div><div className={`mt-1 text-xs tabular-nums ${value >= 10 ? 'text-destructive' : 'text-muted-foreground'}`}>{pct(value)}</div></div>})}
    </div></ToolSection>
    <ToolSection title="对手威胁"><table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="pb-3 font-normal">位置</th><th className="pb-3 font-normal">状态</th><th className="pb-3 text-right font-normal">估计听牌率</th></tr></thead><tbody>
      {analysis.opponents.map(opponent => <tr key={opponent.seat} className="border-t border-border/60"><td className="py-3">{game.our_seat == null ? `座位 ${opponent.seat+1}` : SEATS[relativeKind(opponent.seat,game.our_seat,game.num_players)]}</td><td>{opponent.is_riichi ? '立直' : '未立直'}</td><td className="text-right tabular-nums">{pct(opponent.tenpai_rate)}</td></tr>)}
    </tbody></table></ToolSection>
  </div>
}
function signed(value:number|null|undefined) {return value == null ? '—' : `${value > 0 ? '+' : ''}${value.toLocaleString()}分`}
export function AccessoryHistory() {
  const records = useHistoryStore(s => s.records)
  const loading = useHistoryStore(s => s.loading)
  const startUrl = useConfigStore(s => s.config?.capture.chromium.start_url)
  const [mode,setMode] = useState<3|4>(4)
  const [limit,setLimit] = useState(20)
  const [selected,setSelected] = useState<GameRecord|null>(null)
  const [detailOpen,setDetailOpen] = useState(false)
  const [message,setMessage] = useState('')
  const summary = useMemo(() => recordSummary(records,mode),[records,mode])
  const sorted = summary.games.toSorted((a,b) => b.started_at.localeCompare(a.started_at))
  const replay = selected?.match_info?.platform === 'majsoul' ? selected.match_info.game_uuid : null
  const openReplay = () => {
    if (!replay) return
    openExternal(majsoulReplayUrl(startUrl,replay))
  }
  return <div className="grid gap-5">
    <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">共 {summary.games.length} 场</span><div className="flex rounded-lg bg-muted p-1">{([4,3] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} onClick={() => {setMode(value);setLimit(20)}} className={`rounded-md px-4 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring ${mode === value ? 'bg-background font-medium shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}>{value === 4 ? '四麻' : '三麻'}</button>)}</div></div>
    <ToolSection title="对局统计"><div className="grid grid-cols-3 gap-4"><Metric label="平均名次" value={summary.average?.toFixed(2) ?? '—'} /><Metric label="和牌率" value={summary.win == null ? '—' : `${summary.win.toFixed(1)}%`} /><Metric label="放铳率" value={summary.dealIn == null ? '—' : `${summary.dealIn.toFixed(1)}%`} /></div></ToolSection>
    {!!summary.games.length && <details className="rounded-xl border border-border/70 bg-card"><summary className="cursor-pointer px-4 py-3 text-sm font-medium">名次分布与上分走势</summary><div className="grid gap-4 px-4 pb-4"><RankPieChart counts={summary.ranks} /><p className="text-xs text-muted-foreground">上分合计 {signed(summary.points)}，仅统计有结算数据的 {summary.known} 场。</p><CumulativePtChart series={summary.series} label="累计段位分" /></div></details>}
    {!sorted.length ? <Empty text={loading ? '正在读取记录…' : '完成整场对局后自动保存记录'} /> : <ToolSection title="最近对局"><ol className="divide-y divide-border/60">{sorted.slice(0,limit).map(record => <li key={record.id}>
      <button type="button" className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => {setSelected(record);setDetailOpen(true);setMessage('')}}>
        <span className="w-12 shrink-0 text-sm font-medium">{record.our_rank ? `第${record.our_rank}名` : '—'}</span><span className="min-w-0 flex-1 text-xs text-muted-foreground">{new Date(record.started_at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}<span className="mt-1 block">{record.kyoku_mode === 'east_south' ? '半庄' : record.kyoku_mode === 'east_only' ? '东风' : '对局'}</span></span><span className={`text-sm tabular-nums ${record.our_rank_points == null ? 'text-muted-foreground' : record.our_rank_points >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>{record.our_rank_points == null ? '上分数据缺失' : signed(record.our_rank_points)}</span><ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
      </button></li>)}</ol>{limit < sorted.length && <Button className="mt-3 w-full" size="sm" variant="outline" onClick={() => setLimit(value => value+20)}>显示更多</Button>}</ToolSection>}
    {selected && <ToolSection title="所选牌谱"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!replay} onClick={() => {if(replay)void copyText(replay).then(() => setMessage('牌谱编号已复制')).catch(e => setMessage(String(e)))}}><Copy className="size-3.5" />复制牌谱编号</Button><Button size="sm" variant="outline" disabled={!replay} onClick={openReplay}><ArrowUpRight className="size-3.5" />打开雀魂牌谱</Button></div>{!replay && <p className="mt-2 text-xs text-muted-foreground">这场记录未保存牌谱编号</p>}{message && <p role="status" className="mt-2 break-words text-xs text-muted-foreground">{message}</p>}</ToolSection>}
    <GameDetailDialog record={detailOpen ? selected : null} localOnly onOpenChange={setDetailOpen} />
  </div>
}
function Empty({text}:{text:string}) {return <div className="rounded-xl border border-dashed border-border px-5 py-14 text-center text-sm text-muted-foreground">{text}</div>}
