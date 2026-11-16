import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { invoke, listen } from '@/lib/tauri'

/// Mirrors `crate::updater::check::UpdateInfo` on the Rust side. The
/// shape is fixed by the IPC contract — keep both ends in sync.
export type UpdateInfo = {
  current: string
  latest_tag: string
  latest_version: string
  body: string
  html_url: string
  asset_name: string
  asset_url: string
  asset_size: number
  asset_digest_sha256: string | null
  /** `.minisig` companion asset URL; null for unsigned (≤v3.5.0) releases. */
  sig_url: string | null
  /** Where the release metadata came from ('direct' GitHub or a 'mirror'). */
  meta_source: 'direct' | 'mirror'
}

/// Mirrors `crate::updater::error::UpdateError`. The `kind` tag is what
/// frontend code switches on to decide between a generic "Update failed"
/// toast and a fallback that opens the release page.
export type UpdateProgress = {
  stage: 'checking' | 'connecting' | 'downloading' | 'verifying' | 'installing' | 'restarting' | 'cancelling' | 'cancelled' | 'failed'
  downloaded: number
  total: number
}
export type UpdateError =
  | { kind: 'cancelled' }
  | { kind: 'unsupported_platform' }
  | { kind: 'read_only_install'; path: string }
  | { kind: 'digest_mismatch' }
  | { kind: 'signature_missing' }
  | { kind: 'signature_invalid' }
  | { kind: 'no_matching_asset' }
  | { kind: 'other'; message: string }

const CHECK_CACHE_MS = 6 * 60 * 60 * 1000

/// Frontend-only persisted state. The Rust side intentionally has no
/// knowledge of `skippedVersion` / `autoCheckEnabled` — they're user
/// preferences and don't gate any backend behavior.
type Persisted = {
  lastChecked: number | null
  skippedVersion: string | null
  autoCheckEnabled: boolean
}

type Ephemeral = {
  checkedThisSession: boolean
  lastError: string | null
  /// Result of the most recent `check_for_update`. NOT persisted — we
  /// always re-fetch on launch (subject to the 6h cache) so a release
  /// that was deleted / unpublished doesn't keep nagging.
  pendingUpdate: UpdateInfo | null
  /// `true` while `apply_update` is in flight. Used to disable the
  /// "Update now" button and show a spinner.
  applying: boolean
  progress: UpdateProgress | null
  applyStartedAt: number | null
  progressAt: number | null
  /// `true` after the auto-check toast has fired this session. Stops
  /// the toast from re-firing when `<UpdateNotifier />` re-mounts on
  /// a route change.
  toastShownThisSession: boolean
  /// Open state for the `<UpdateDialog />`. The sidebar red-dot and the
  /// toast's "View details" action both flip this to true.
  dialogOpen: boolean
  /// `true` while a `check_for_update` call is in flight. Used by the
  /// Settings page to disable the button + show a spinner.
  checking: boolean
}

type Actions = {
  checkNow: (force?: boolean) => Promise<void>
  applyUpdate: () => Promise<UpdateError | null>
  cancelUpdate: () => Promise<void>
  skip: (version: string) => void
  clearSkipped: () => void
  setAutoCheckEnabled: (enabled: boolean) => void
  openDialog: () => void
  closeDialog: () => void
  markToastShown: () => void
}

export type UpdaterStore = Persisted & Ephemeral & Actions

const initialEphemeral: Ephemeral = {
  checkedThisSession: false,
  lastError: null,
  pendingUpdate: null,
  applying: false,
  progress: null, applyStartedAt: null, progressAt: null,
  toastShownThisSession: false,
  dialogOpen: false,
  checking: false,
}

export const useUpdaterStore = create<UpdaterStore>()(
  persist(
    (set, get) => ({
      lastChecked: null,
      skippedVersion: null,
      autoCheckEnabled: true,
      ...initialEphemeral,

      checkNow: async (force = false) => {
        if (get().checking) return
        if (!force) {
          const last = get().lastChecked ?? 0
          if (get().checkedThisSession && Date.now() - last < CHECK_CACHE_MS) return
        }
        set({ checking: true, lastError: null })
        try {
          const info = await invoke<UpdateInfo | null>('check_for_update')
          set({ pendingUpdate: info, lastChecked: Date.now(), checkedThisSession: true })
        } catch (e) {
          // Network / parse failures: just log; the toast layer will
          // see `pendingUpdate === null` and stay quiet. Settings card
          // shows the error via its own try/catch wrapper.
          set({ lastError: String(e) })
          console.warn('check_for_update failed:', e)
        } finally {
          set({ checking: false })
        }
      },

      applyUpdate: async () => {
        const info = get().pendingUpdate
        if (!info || get().applying) return null
        set({ applying: true, lastError: null, applyStartedAt: Date.now(), progressAt: Date.now(),
          progress: { stage:'checking', downloaded:0, total:info.asset_size } })
        let unlisten: (() => void) | undefined
        try {
          // Subscribe before invoking, so an immediate first chunk isn't lost.
          unlisten = await listen<UpdateProgress>('update-progress', progress => {
            if (!get().applying) return
            if (get().progress?.stage === 'cancelling' && !['failed','cancelled'].includes(progress.stage)) return
            set({ progress, progressAt:Date.now() })
          })
          await invoke<void>('apply_update')
          return null
        } catch (e) {
          const error: UpdateError = typeof e === 'object' && e !== null && 'kind' in e
            ? e as UpdateError : { kind:'other', message:String(e) }
          set({ lastError:error.kind === 'cancelled' ? null : error.kind === 'other' ? error.message : '更新失败，请重试或手动下载。',
            progress:{stage:error.kind === 'cancelled' ? 'cancelled':'failed', downloaded:get().progress?.downloaded ?? 0,total:info.asset_size} })
          return error
        } finally {
          try { unlisten?.() } catch(e) { console.warn('update progress listener cleanup failed', e) } finally { set({applying:false}) }
        }
      },
      cancelUpdate: async () => {
        if (!get().applying) return
        try {
          const accepted = await invoke<boolean>('cancel_update')
          if (!get().applying) return
          if (accepted) {
            const current=get().progress
            set({progress:{stage:'cancelling',downloaded:current?.downloaded ?? 0,total:current?.total ?? 0}})
          } else { set({lastError:'当前已进入安装阶段或操作已结束，无法取消。'}) }
        } catch(e) { set({lastError:`取消更新失败：${String(e)}`}) }
      },

      skip: (version: string) =>
        set({ skippedVersion: version, dialogOpen: false }),
      clearSkipped: () => set({ skippedVersion: null }),
      setAutoCheckEnabled: (enabled: boolean) =>
        set({ autoCheckEnabled: enabled }),
      openDialog: () => set({ dialogOpen: true }),
      closeDialog: () => set({ dialogOpen: false }),
      markToastShown: () => set({ toastShownThisSession: true }),
    }),
    {
      name: 'akagi.updater',
      storage: createJSONStorage(() => localStorage),
      partialize: (state): Persisted => ({
        lastChecked: state.lastChecked,
        skippedVersion: state.skippedVersion,
        autoCheckEnabled: state.autoCheckEnabled,
      }),
    },
  ),
)

/// Derived: is there a notifiable update right now? Notifiable means
/// "we have a pending update AND it isn't the one the user explicitly
/// skipped." Used by the sidebar red-dot and the toast firing logic.
export function selectHasNotifiableUpdate(s: UpdaterStore): boolean {
  if (!s.pendingUpdate) return false
  return s.skippedVersion !== s.pendingUpdate.latest_tag
}
