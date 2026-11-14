import type { FoldDecision, MjaiEvent } from '@/types'

export function actionLabel(action: MjaiEvent, zh: boolean): string {
  if (action.type === 'dahai') {
    if (!zh) return action.pai
    const honors: Record<string, string> = { E: '东', S: '南', W: '西', N: '北', P: '白', F: '发', C: '中' }
    return honors[action.pai] ?? `${action.pai.endsWith('r') ? '赤' : ''}${action.pai[0]}${({ m: '万', p: '筒', s: '条' } as Record<string, string>)[action.pai[1]] ?? ''}`
  }
  const labels: Record<string, string> = { reach: '立直', chi: '吃', pon: '碰', none: '跳过', hora: '和牌', kita: '拔北', ryukyoku: '九种九牌流局' }
  return zh ? labels[action.type] ?? '杠' : action.type
}

export function foldSummary(fold: FoldDecision, zh: boolean): string {
  if (fold.action.type === 'dahai') {
    const tile = actionLabel(fold.action, zh)
    return zh ? `建议弃和，危险度最低：${tile}。${fold.fallback ? '当前使用基础防守。' : ''}`
      : `Fold; lowest risk: ${tile}.${fold.fallback ? ' Basic defence fallback.' : ''}`
  }
  if (fold.action.type === 'hora') return zh ? '合法和牌，接受和牌。' : 'Accept the legal win.'
  if (fold.fallback) return zh ? '弃和中：暂无法确定合法防守牌，暂不操作。' : 'Folding: no safe executable decision is available.'
  return zh ? '弃和中：跳过吃、碰、杠。' : 'Folding: decline calls and kans.'
}
