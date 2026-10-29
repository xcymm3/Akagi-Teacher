// Mahgen tile sizing — port of frontend/js/app.js.
// See frontend/mahgen.md for the full background on why every "obvious"
// CSS-only approach fails. The TL;DR: mahgen renders into an open shadow
// root; setting host + inner <img> dimensions in pixels is the only path
// that survives the WebKitGTK + circular-containing-block constraints.

export type MahgenKind =
  | 'river' | 'hand' | 'melds' | 'dora' | 'rec' | 'bot-action' | 'bot-show'
  | 'overlay-show' | 'coach-show'
  | 'board-hand' | 'board-river' | 'board-meld' | 'hand-risk'

type SizeCtx =
  | { mode: 'river'; maxScale?: number; minScale?: number }
  | { mode: 'fit'; min?: number; max?: number }
  | { mode: 'fixed'; base: number }
  | { mode: 'linear'; base: number; ref: number; min: number; max: number }
  // The only height-driven mode. Every other one reads the container's *width*,
  // which is right inside a scrolling dashboard tile but wrong for a small
  // free-floating window: there, the height is the scarce axis, and a tile that
  // ignores it leaves a dead band under the last row no matter how tall the user
  // drags the window. `pad` is the breathing room left inside the row.
  | { mode: 'fill-height'; pad: number; min: number; max: number }

const SIZE_CTX: Record<MahgenKind, SizeCtx> = {
  river: { mode: 'river', maxScale: 0.65, minScale: 0.18 },
  hand:  { mode: 'fit',   min: 44, max: 100 },
  melds: { mode: 'linear', base: 34, ref: 230, min: 22, max: 56 },
  dora:  { mode: 'fixed',  base: 30 },
  rec:   { mode: 'linear', base: 38, ref: 340, min: 28, max: 56 },
  // bot-action: container ref is the BotActionTile's outer row, so cw is the
  // full tile width — pick base/ref so a typical lg tile (~580px) produces a
  // tile roughly matching the left-side glyph's drawn height.
  'bot-action': { mode: 'linear', base: 35, ref: 290, min: 28, max: 110 },
  // bot-show: per-row tile group inside the BotShowTile list. Smaller than
  // bot-action so the label/value columns stay readable; cap higher than
  // 'rec' for chi/pon melds.
  'bot-show': { mode: 'linear', base: 30, ref: 260, min: 22, max: 64 },
  // overlay-show: the same rows in the always-on-top overlay window. The
  // container here is the row itself (not the list), and the rows split the
  // window's height between them — so the tile grows with the window and the
  // list always reaches the bottom edge. `max` is generous on purpose: someone
  // who drags the overlay large wants big, legible tiles.
  // `min` is low enough that 5 rows in a window shrunk to `MIN_HEIGHT` still fit
  // rather than getting cropped by the row's overflow.
  // Fixed size breaks the row/scrollbar/width feedback loop in teaching overlays.
  'coach-show': { mode: 'fixed', base: 48 },
  'overlay-show': { mode: 'fill-height', pad: 8, min: 20, max: 120 },
  // board-*: compact tiles for the 2D table tile (BoardTile). Each seat's
  // mahgen container is a fraction of the square board, so these scale down
  // when the tile is small. `board-hand` uses linear so each tile keeps a
  // constant height (scaling only with the board) and the strip *width* grows
  // with the tile count — like `board-meld`. (Earlier 'fit' forced the hand to
  // fill its fixed-width container, so fewer hand tiles after melds blew each
  // tile up huge.) base/ref are tuned so hand tile height ≈ meld tile height
  // (meld is base 34 over a 44% container; hand here is over a 56% container)
  // and a full 13-tile hand still ≈ fills the container — refine visually in
  // the webview. River uses 'river' scaling with a high cap so it grows with
  // the board too; its smaller container width keeps river tiles smaller.
  'board-hand':  { mode: 'linear', base: 28, ref: 250, min: 16, max: 80 },
  'board-river': { mode: 'river',  maxScale: 1.0, minScale: 0.14 },
  'board-meld':  { mode: 'linear', base: 34, ref: 240, min: 16, max: 80 },
  // hand-risk: individual hand tiles in the RiskChartTile, each rendered as its
  // own <mah-gen> so a per-tile risk glow + badge can sit around it. Container
  // ref is the shared content row, so all tiles get the same height and the
  // strip wraps when the panel is narrow. Tuned for a ~13–14 tile hand; refine
  // visually in the webview.
  'hand-risk':   { mode: 'linear', base: 36, ref: 230, min: 26, max: 64 },
}

const RIVER_FULL_ROW_W = 420

type MahgenImg = HTMLImageElement & { _akagiOnLoad?: boolean }
type MahgenEl = HTMLElement & { shadowRoot: ShadowRoot | null }

type Entry = {
  kind: MahgenKind
  container: HTMLElement | null
  retries: number
}

const registry = new Map<MahgenEl, Entry>()

export function applyMahgenSize(el: MahgenEl): void {
  const entry = registry.get(el)
  if (!entry) return

  if (!el.isConnected) {
    entry.retries += 1
    if (entry.retries > 6) {
      registry.delete(el)
      return
    }
    requestAnimationFrame(() => applyMahgenSize(el))
    return
  }
  entry.retries = 0

  const root = el.shadowRoot
  if (!root) {
    requestAnimationFrame(() => applyMahgenSize(el))
    return
  }

  const img = root.querySelector('img') as MahgenImg | null
  if (!img) {
    requestAnimationFrame(() => applyMahgenSize(el))
    return
  }

  if (!img._akagiOnLoad) {
    img._akagiOnLoad = true
    img.addEventListener('load', () => applyMahgenSize(el))
  }

  const seq = el.getAttribute('data-seq')
  if (!seq) {
    el.style.display = 'none'
    return
  }
  el.style.display = ''

  const cfg = SIZE_CTX[entry.kind]
  const cw = entry.container?.clientWidth ?? ('ref' in cfg ? cfg.ref : 200)
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  const aspectKnown = nw > 0 && nh > 0

  let w: number
  let h: number

  if (cfg.mode === 'river') {
    if (aspectKnown) {
      let scale = cw / RIVER_FULL_ROW_W
      if (cfg.maxScale) scale = Math.min(scale, cfg.maxScale)
      if (cfg.minScale) scale = Math.max(scale, cfg.minScale)
      w = nw * scale
      h = nh * scale
    } else {
      w = cw
      h = (cw / RIVER_FULL_ROW_W) * 100
    }
  } else if (cfg.mode === 'fit') {
    if (aspectKnown) {
      w = cw
      h = (cw * nh) / nw
      if (cfg.max && h > cfg.max) {
        h = cfg.max
        w = (h * nw) / nh
      }
      if (cfg.min && h < cfg.min) {
        h = cfg.min
        w = (h * nw) / nh
      }
    } else {
      w = cw
      h = cfg.max ?? 80
    }
  } else if (cfg.mode === 'fixed') {
    h = cfg.base
    w = aspectKnown ? (h * nw) / nh : cfg.base
  } else if (cfg.mode === 'fill-height') {
    // The row's height is set by the flex layout, not by this tile, so growing
    // the tile can't feed back into the measurement.
    const ch = entry.container?.clientHeight ?? cfg.min + cfg.pad
    h = Math.max(cfg.min, Math.min(cfg.max, ch - cfg.pad))
    w = aspectKnown ? (h * nw) / nh : h * 0.75
  } else {
    h = cfg.base * (cw / cfg.ref)
    h = Math.max(cfg.min, Math.min(cfg.max, h))
    w = aspectKnown ? (h * nw) / nh : cfg.base
  }

  el.style.width = `${w}px`
  el.style.height = `${h}px`
  el.style.flex = '0 0 auto'
  img.style.width = `${w}px`
  img.style.height = `${h}px`
  img.style.objectFit = 'contain'
  img.style.display = 'block'
}

const ro = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver((entries) => {
      const containers = new Set(entries.map((e) => e.target))
      for (const [el, ent] of registry) {
        if (ent.container && containers.has(ent.container)) applyMahgenSize(el)
      }
    })
  : null

const observedContainers = new WeakSet<Element>()

export function registerMahgen(el: MahgenEl, kind: MahgenKind, container: HTMLElement | null): void {
  registry.set(el, { kind, container, retries: 0 })
  if (container && ro && !observedContainers.has(container)) {
    ro.observe(container)
    observedContainers.add(container)
  }
  applyMahgenSize(el)
}

export function unregisterMahgen(el: MahgenEl): void {
  registry.delete(el)
}

let resizeRaf = 0
function scheduleResize(): void {
  if (resizeRaf) return
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0
    for (const el of registry.keys()) applyMahgenSize(el)
  })
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', scheduleResize)
}

export function setMahgenSeq(el: MahgenEl, seq: string): void {
  const next = seq ?? ''
  if ((el.getAttribute('data-seq') ?? '') === next) return
  el.style.opacity = '0'
  requestAnimationFrame(() => {
    el.setAttribute('data-seq', next)
    requestAnimationFrame(() => {
      el.style.opacity = '1'
      applyMahgenSize(el)
    })
  })
}
