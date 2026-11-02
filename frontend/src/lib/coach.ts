import type { CoachFacts, HelperMetrics, MjaiEvent } from '@/types'

export type CoachText = { labels: string[]; reasons: string[]; markers: string[][]; summary: string; details: string[] }

// Pure rendering of independent analysis. Never change policy order/probability/actions.
export function formatCoach(facts: CoachFacts, language = 'zh-CN'): CoachText {
  const zh = language.startsWith('zh')
  const s = (cn: string, en: string) => zh ? cn : en
  const tile = (t: string) => {
    const honors: Record<string, string> = { E: '东', S: '南', W: '西', N: '北', P: '白', F: '发', C: '中' }
    if (!zh) return t
    if (honors[t]) return honors[t]
    const suit = ({ m: '万', p: '筒', s: '条' } as Record<string, string>)[t[1]]
    return suit ? `${t.endsWith('r') ? '赤' : ''}${t[0]}${suit}` : t
  }
  const tileId = (t: string) => {
    const h = ['E', 'S', 'W', 'N', 'P', 'F', 'C'].indexOf(t)
    return h >= 0 ? 27 + h : 'mps'.indexOf(t[1]) * 9 + Number(t[0]) - 1
  }
  const idTile = (id: number) => tile(id >= 27 ? ['E', 'S', 'W', 'N', 'P', 'F', 'C'][id - 27] : `${id % 9 + 1}${'mps'[Math.floor(id / 9)]}`)
  const position = (seat: number) => {
    const relative = (seat - facts.seat + facts.num_players) % facts.num_players
    return facts.num_players === 3
      ? [s('自己', 'you'), s('下家', 'next player'), s('上家', 'previous player')][relative]
      : [s('自己', 'you'), s('下家', 'next player'), s('对家', 'opposite player'), s('上家', 'previous player')][relative]
  }
  const state = (n: number) => n < 0 ? s('和牌形', 'complete') : n === 0 ? s('听牌', 'tenpai') : s(`${n}向听`, `${n}-shanten`)
  const name = (a: MjaiEvent): string => {
    switch (a.type) {
      case 'dahai': return tile(a.pai)
      case 'reach': return s(`立直${a.pai ? `打${tile(a.pai)}` : ''}`, `riichi${a.pai ? ` / ${tile(a.pai)}` : ''}`)
      case 'chi': return s('吃', 'chi')
      case 'pon': return s('碰', 'pon')
      case 'none': return s('跳过', 'pass')
      case 'hora': return s('和牌', 'win')
      case 'kita': return s('拔北', 'kita')
      case 'ryukyoku': return s('九种九牌流局', 'nine-terminals abort')
      default: return s('杠', 'kan')
    }
  }
  const helper = facts.helper
  // Upstream excludes kokushi. Never attach mismatched metrics to that shape.
  const metric = (i: number): HelperMetrics | null => {
    const m = helper?.candidates[i]
    const c = facts.candidates[i]
    return m && (c.shanten === null || c.shanten === m.shanten) ? m : null
  }
  const metrics = facts.candidates.map((_, i) => metric(i))
  const safe = facts.candidates.map(c => {
    if (c.action.type !== 'dahai' && c.action.type !== 'reach') return { seats: [] as number[], passed: [] as number[] }
    const id = c.action.pai ? tileId(c.action.pai) : -1
    const passed = helper?.opponents.filter(o => o.passed[id]).map(o => o.seat) ?? []
    const seats = [...new Set([...c.safe_against, ...passed,
      ...(helper?.opponents.filter(o => o.safe[id] && (o.tenpai >= 50 || facts.riichi_seats.includes(o.seat))).map(o => o.seat) ?? []),
    ])]
    return { seats, passed }
  })
  const risk = (i: number) => {
    const a = facts.candidates[i].action
    if ((a.type !== 'dahai' && a.type !== 'reach') || !a.pai || !helper) return null
    const id = tileId(a.pai)
    return helper.opponents.reduce((sum, o) => sum + (o.risk[id] ?? 0) * o.tenpai / 100, 0)
  }
  const risks = facts.candidates.map((_, i) => risk(i))
  const reasons = facts.candidates.map((c, i) => {
    const m = metrics[i]
    const parts: string[] = []
    const follow = helper?.followup[i] ?? -1
    if (m) {
      const after = follow >= 0 ? s(`再打${idTile(follow)}后`, `After discarding ${idTile(follow)}, `) : ''
      parts.push(s(`${after}${state(m.shanten)}，进张${m.ukeire}枚。`, `${after}${state(m.shanten)}, ${m.ukeire} effective tiles.`))
    } else if (c.shanten !== null && c.effective_tiles !== null) {
      parts.push(s(`${state(c.shanten)}，进张${c.effective_tiles}枚。`, `${state(c.shanten)}, ${c.effective_tiles} effective tiles.`))
    }
    // At most two useful differentiators per row. No "not a dora"/generic filler.
    const extra: string[] = []
    if (safe[i].passed.length) {
      const permanent = safe[i].passed.every(seat => helper?.opponents.find(o => o.seat === seat)?.riichi)
      extra.push(s(`${permanent ? '立直后通过' : '同巡安全'}：${safe[i].passed.map(position).join('、')}。`, `Passed safely against: ${safe[i].passed.map(position).join(', ')}.`))
    }
    else if (safe[i].seats.length) extra.push(s(`现物：${safe[i].seats.map(position).join('、')}。`, `Genbutsu: ${safe[i].seats.map(position).join(', ')}.`))
    if (m?.furiten === 1) extra.push(s('振听，只能自摸。', 'Furiten; tsumo only.'))
    else if (m?.part) extra.push(s('部分待牌无役。', 'Some waits have no yaku.'))
    if (m) {
      const peers = metrics.filter((p): p is HelperMetrics => p !== null && p.shanten === m.shanten)
      if (m.shanten === 0) {
        if (m.riichi > 0 && (i === 0 || peers.some(p => Math.abs(p.riichi - m.riichi) >= 1000))) extra.push(s(`立直打点估算约${Math.round(m.riichi / 100) * 100}点。`, `Estimated riichi value: ${Math.round(m.riichi)} points.`))
        else if (m.dama > 0 && (i === 0 || peers.some(p => Math.abs(p.dama - m.dama) >= 1000))) extra.push(s(`打点估算约${Math.round(m.dama / 100) * 100}点。`, `Estimated value: ${Math.round(m.dama)} points.`))
        else if (!facts.closed_hand && m.dama === 0) extra.push(s('当前待牌无役。', 'Current waits have no yaku.'))
      } else if (m.next > 0 && peers.some(p => p.next > 0 && Math.abs(p.next - m.next) >= 1)) {
        extra.push(s(`前进一步后平均进张约${m.next.toFixed(1)}枚。`, `Average effective tiles after progress: ${m.next.toFixed(1)}.`))
      }
      if (m.improve_tiles.length && m.improve - m.ukeire >= 1 && peers.some(p => Math.abs(p.improve - m.improve) >= 1)) {
        extra.push(s(`摸${m.improve_tiles.slice(0, 2).map(idTile).join('、')}等可改良进张。`, `Draws such as ${m.improve_tiles.slice(0, 2).map(idTile).join(', ')} improve acceptance.`))
      }
      const r = risks[i]
      if (!safe[i].seats.length && r !== null && r > 0 && risks.some(p => p !== null && p > r + 1)) {
        extra.push(s('综合危险度较低。', 'Lower combined risk.'))
      }
      // Yaku names are a union of reachable branches, not a guaranteed final yaku.
      const yaku = m.yaku.filter(y => !/立直|平和|一发|門前|门前|断幺/.test(y)).slice(0, 1)
      if (yaku.length && peers.some(p => !p.yaku.includes(yaku[0]))) extra.push(s(`可观察${yaku[0].replaceAll('[', '').replaceAll(']', '')}方向。`, `Possible yaku direction: ${yaku[0]}.`))
    }
    if (!parts.length && (c.action.type === 'chi' || c.action.type === 'pon') && facts.closed_hand) extra.push(s('副露后失去门清。', 'Opening gives up menzen.'))
    return [...parts, ...extra.slice(0, 2)].join(zh ? '' : ' ')
  })
  let summary = ''
  const preferred = helper?.preferred_index ?? -1
  if (preferred >= 0 && preferred < metrics.length && metrics[0] && metrics[preferred]) {
    const a = metrics[0]!, b = metrics[preferred]!
    if (preferred === 0) {
      summary = s(`建议${facts.candidates[0].action.type === 'dahai' ? '打' : ''}${name(facts.candidates[0].action)}。`, `Prefer ${name(facts.candidates[0].action)}.`)
    } else {
      const alternative = name(facts.candidates[preferred].action)
      let why = s('综合牌理评分更高', 'a higher combined hand score')
      if (b.shanten < a.shanten) why = s(`出牌后为${state(b.shanten)}，向听更低`, `lower shanten: ${state(b.shanten)}`)
      else if (b.shanten === 0 && b.round > a.round + 100) why = s('和率与打点的综合收益估算更高', 'higher estimated return combining win rate and value')
      else if (b.shanten === 1 && b.round * b.ukeire > a.round * a.ukeire) why = s('听牌机会与收益的综合评分更高', 'a higher score combining acceptance and return')
      else if (b.speed > a.speed + 0.1) why = s('后续进张与速度评分更高', 'a higher speed score including subsequent acceptance')
      else if (b.ukeire > a.ukeire) why = s('即时进张更多', 'more immediate effective tiles')
      else if (b.improve > a.improve + 0.1) why = s('改良后的平均进张更高', 'higher average acceptance with improvements')
      summary = s(`模型首选${name(facts.candidates[0].action)}；${alternative}${why}。`, `The model prefers ${name(facts.candidates[0].action)}; ${alternative} has ${why}.`)
    }
  }
  if (!helper && facts.helper_error) summary = s('深入分析暂不可用，当前显示基础牌效。', 'Deeper analysis unavailable; showing basic efficiency.')
  const details = metrics.map((m, i) => m ? [
    s(`进张 ${m.ukeire}；改良参考 ${m.improve.toFixed(1)}；前进后 ${m.next.toFixed(1)}`, `Acceptance ${m.ukeire}; improvement ${m.improve.toFixed(1)}; next ${m.next.toFixed(1)}`),
    s(`速度评分 ${m.speed.toFixed(2)}；待牌和率参考 ${m.win.toFixed(1)}%`, `Speed score ${m.speed.toFixed(2)}; wait win-rate reference ${m.win.toFixed(1)}%`),
    s(`立直打点 ${Math.round(m.riichi)}；默听/副露打点 ${Math.round(m.dama)}；收支评分 ${Math.round(m.round)}`, `Riichi ${Math.round(m.riichi)}; dama/open ${Math.round(m.dama)}; return score ${Math.round(m.round)}`),
    s(`综合风险指数 ${(risks[i] ?? 0).toFixed(2)}（包含失点修正，非放铳率）`, `Combined risk index ${(risks[i] ?? 0).toFixed(2)} (loss-adjusted, not deal-in probability)`),
    ...(helper?.reference_only ? [s('三麻统计沿用参考估算。', 'Sanma statistics are reference estimates.')] : []),
  ].join('\n') : '')
  return { labels: facts.candidates.map(c => name(c.action)), reasons, details,
    markers: safe.map(v => v.seats.length ? [s('守', 'Defend')] : []), summary }
}
