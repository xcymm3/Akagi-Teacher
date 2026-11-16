import { useMemo, useState } from 'react'
import { ArrowUpRight, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GameDetailDialog } from '@/components/history/GameDetailDialog'
import { RankPieChart } from '@/components/history/RankPieChart'
import { CumulativePtChart } from '@/components/history/CumulativePtChart'
import { useConfigStore } from '@/stores/configStore'
import { useHistoryStore } from '@/stores/historyStore'
import { recordSummary, majsoulReplayUrl } from '@/lib/recordSummary'
import { copyText } from '@/lib/clipboard'
import { openExternal } from '@/lib/external'
import type { GameRecord } from '@/types'

export function ToolSection({title, children}: {title:string;children:React.ReactNode}) {
  return <section className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs"><h3 className="border-b border-border/60 px-4 py-3 text-sm font-medium">{title}</h3><div className="p-4">{children}</div></section>
}
function Metric({label,value}: {label:string;value:string}) {
  return <div className="min-w-0"><div className="mb-1 text-xs text-muted-foreground">{label}</div><div className="text-xl font-semibold tabular-nums tracking-tight">{value}</div></div>
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
