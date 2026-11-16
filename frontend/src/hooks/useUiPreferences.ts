import { useEffect } from 'react'
import i18n from '@/i18n'
import { useThemeStore } from '@/stores/themeStore'
import { SCALE_DEFAULT, SCALE_MIN, SCALE_MAX, useUiPrefsStore } from '@/stores/uiPrefsStore'
import { useUpdaterStore } from '@/stores/updaterStore'

/** Both trusted windows share storage; apply changes without reloading the game. */
export function useUiPreferences() {
  const scale = useUiPrefsStore(s => s.scale)
  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * scale}px`
    return () => { document.documentElement.style.fontSize = '' }
  }, [scale])
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === 'akagi.theme') void useThemeStore.persist.rehydrate()
      if (event.key === 'akagi.updater') void useUpdaterStore.persist.rehydrate()
      if (event.key === 'akagi.ui.scale') {
        const value = Number(event.newValue ?? SCALE_DEFAULT)
        useUiPrefsStore.setState({ scale: Number.isFinite(value) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, value)) : SCALE_DEFAULT })
      }
      if (event.key === 'akagi.lang' && event.newValue && event.newValue !== i18n.language) void i18n.changeLanguage(event.newValue)
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
}
