import { create } from 'zustand'
import type { AppConfig, OverlayConfig } from '@/types'

type ConfigStore = {
  config: AppConfig | null
  logDir: string
  setConfig: (c: AppConfig) => void
  setLogDir: (p: string) => void
  /** Patch just the overlay section, leaving the rest of the config alone.
   *  Driven by the backend's `overlay-config` event, so the Game page's toggle
   *  still reflects reality after the overlay is closed from its own × button. */
  setOverlay: (o: OverlayConfig) => void
  setAutoplay: (enabled: boolean) => void
}

export const useConfigStore = create<ConfigStore>((set) => ({
  config: null,
  logDir: '',
  setConfig: (config) => set({ config }),
  setLogDir: (logDir) => set({ logDir }),
  setAutoplay: (enabled) => set((s) => s.config ? { config: { ...s.config, autoplay: { ...s.config.autoplay, enabled } } } : s),
  setOverlay: (overlay) =>
    set((s) => (s.config ? { config: { ...s.config, overlay } } : s)),
}))
