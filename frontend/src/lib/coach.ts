import type { CandidateFacts, CoachFacts, MjaiEvent } from '@/types'

export type CoachText = { labels: string[]; reasons: string[]; summary: string }

/** Evidence-based descriptions, not an alleged neural-network thought process.
 * Does not normalize probabilities, reorder candidates, or produce game actions.
 */
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
  const position = (seat: number) => {
    const relative = (seat - facts.seat + facts.num_players) % facts.num_players
    // Sanma has no opposite seat: relative 1/2 are the other two players.
    const names = facts.num_players === 3
      ? [s('自己', 'you'), s('下家', 'next player'), s('上家', 'previous player')]
      : [s('自己', 'you'), s('下家', 'next player'), s('对家', 'opposite player'), s('上家', 'previous player')]
    return names[relative]
  }
  const state = (n: number) => n < 0 ? s('和牌形', 'a complete shape')
    : n === 0 ? s('听牌', 'tenpai') : s(`${n}向听`, `${n}-shanten`)
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
  const discards = facts.candidates.filter(c => c.action.type === 'dahai' && c.shanten !== null)
  const attack = [...discards].sort((a, b) => a.shanten! - b.shanten! || (b.effective_tiles ?? 0) - (a.effective_tiles ?? 0))[0]
  const defence = [...discards].filter(c => c.safe_against.length > 0)
    .sort((a, b) => b.safe_against.length - a.safe_against.length)[0]
  const far = facts.best_shanten >= 2
  const threat = facts.riichi_seats.map(position).join(s('、', ', '))
  const reasons = facts.candidates.map((c: CandidateFacts) => {
    const parts: string[] = []
    if (c.shanten !== null && c.effective_tiles !== null) {
      parts.push(s(`打出后为${state(c.shanten)}，有效进张约${c.effective_tiles}枚（未见牌口径）。`,
        `Leaves ${state(c.shanten)}, with about ${c.effective_tiles} unseen effective tiles.`))
      if (c.shanten > facts.best_shanten) parts.push(s('比当前可选出牌多退向听，牺牲进攻速度。', 'Gives up shanten compared with an available discard.'))
      else if (c === attack && discards.length > 1) {
        const dominated = discards.some(other => other.shanten! > c.shanten! ||
          (other.shanten === c.shanten && other.effective_tiles! < c.effective_tiles!))
        if (dominated) parts.push(s('在展示的切牌候选中，向听与进张比较偏向速度。', 'Favors speed by shanten and ukeire among the displayed discards.'))
      } else if (attack && c.action.type === 'dahai' && c.shanten === attack.shanten && c.effective_tiles < attack.effective_tiles!) {
        const difference = attack.effective_tiles! - c.effective_tiles
        parts.push(s(`同向听下，比牌效候选少约${difference}枚有效进张，推进较慢。`,
          `At the same shanten, has about ${difference} fewer effective tiles than the efficiency candidate.`))
      }
      if (c.safe_against.length) {
        const opponents = c.safe_against.map(position).join(s('、', ', '))
        parts.push(s(`是已立直${opponents}的现物，偏向防守；不代表对其他家安全。`,
          `Genbutsu against ${opponents} in riichi; supports defence, not safety against everyone.`))
      } else if (facts.riichi_seats.length) {
        parts.push(s(`${threat}已立直；这张牌未被确认为其现物。`, `${threat} in riichi; this tile is not confirmed genbutsu against them.`))
      }
      if (c.isolated) parts.push(s('当前为孤张，但孤张本身不等于应该先打。', 'Currently isolated; isolation alone does not make it the best discard.'))
      if (c.discards_dora) parts.push(s('会打出宝牌或赤宝牌，需要付出打点代价。', 'Discards a dora or red five, giving up potential hand value.'))
      else if (c.keeps_dora) parts.push(s('保留手中的宝牌价值。', 'Keeps dora value in hand.'))
      if (c.flush_suit !== null) {
        const suit = ['万', '筒', '条'][c.flush_suit]
        parts.push(s(`保留较集中的${suit}子结构，可观察染手方向；尚未确认成役或打点。`,
          'Keeps a concentrated suit that may develop toward a flush; no yaku or value is guaranteed.'))
      }
    }
    switch (c.action.type) {
      case 'reach': parts.push(s('宣告立直，获得立直役，但之后通常只能摸切，防守自由度降低。', 'Declares riichi, adding its yaku but restricting later discard choices.')); break
      case 'chi': case 'pon': parts.push(s(`组成副露${facts.closed_hand ? '，会失去门清' : ''}；是否加速及最终有役需结合后续舍牌判断。`, 'Forms an open meld; speed and final yaku depend on the subsequent discard.')); break
      case 'ankan': parts.push(s('暗杠并等待岭上摸牌；最终收益取决于新宝牌和后续局面。', 'Declares a concealed kan and awaits the replacement draw; value depends on new dora and play.')); break
      case 'daiminkan': case 'kakan': parts.push(s('增加杠子并等待岭上摸牌，也会增加宝牌变化，不能视为必然增益。', 'Makes a kan with a replacement draw and changing dora; a benefit is not guaranteed.')); break
      case 'none': parts.push(s('放过本次响应机会，维持当前手牌；不等同于已经决定弃和。', 'Declines this response and preserves the hand; it does not by itself mean folding.')); break
      case 'hora': parts.push(s('接受当前合法和牌机会，结束本手；不是未来和牌率预测。', 'Accepts the current legal win, not a prediction of future win rate.')); break
      case 'kita': parts.push(s('将北作为拔北宝牌移出手牌并补牌，可能影响原有结构。', 'Extracts North for kita and a replacement tile, possibly changing the hand structure.')); break
      case 'ryukyoku': parts.push(s('选择九种九牌流局，放弃继续本手。', 'Chooses the nine-terminals abort rather than continuing this hand.')); break
    }
    return parts.join(' ') || s('模型给出的合法候选，当前依据不足以确定主要理由。', 'A legal model candidate; available evidence does not establish its main rationale.')
  })
  let summary: string
  if (attack && defence && attack !== defence) {
    summary = s(`按向听与进张追求速度可选${name(attack.action)}；优先对已立直的${defence.safe_against.map(position).join('、')}防守可选${name(defence.action)}。`,
      `For speed by shanten/ukeire, consider ${name(attack.action)}; for genbutsu defence against ${defence.safe_against.map(position).join(', ')}, consider ${name(defence.action)}.`)
  } else if (attack && defence) {
    summary = s(`${name(attack.action)}兼顾展示候选中的牌效率和对已立直者的现物防守。`,
      `${name(attack.action)} combines displayed hand-efficiency evidence with genbutsu defence.`)
  } else if (attack) {
    summary = s(`按向听与进张比较，${name(attack.action)}偏向推进手牌。`, `By shanten/ukeire, ${name(attack.action)} favors hand progress.`)
    if (threat) summary += s(`${threat}已立直，展示候选中没有已确认的立直现物，不能据此给出安全出牌。`, `${threat} in riichi; none of the displayed discards is confirmed genbutsu, so no safe discard is established.`)
  } else {
    summary = s('按原模型排序比较这些操作；鸣牌后的效率和收益尚未做完整分支评估。', 'Compare these actions in the original model order; post-call efficiency and value have not been fully evaluated.')
  }
  if (far && threat && attack) summary = s(`当前最佳出牌仍为${state(facts.best_shanten)}，距离听牌较远。`, `The best available discard still leaves ${state(facts.best_shanten)}. `) + summary
  return { labels: facts.candidates.map(c => name(c.action)), reasons, summary }
}
