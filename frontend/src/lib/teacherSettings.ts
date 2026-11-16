import type { AutoplaySessionConfig, DelayModelConfig, MajsoulAutoplayConfig } from '@/types'

export type TimingSettings = { majsoul: MajsoulAutoplayConfig; delay: DelayModelConfig }
export type TeacherSettings = { session: AutoplaySessionConfig; timing: TimingSettings; defaults: TimingSettings }
export type SettingsPatch = { session?: AutoplaySessionConfig; timing?: TimingSettings }
export const sameSettings = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export function settingsPatch(initial: TeacherSettings, draft: TeacherSettings): SettingsPatch {
  return {
    ...(!sameSettings(initial.session, draft.session) ? { session: draft.session } : {}),
    ...(!sameSettings(initial.timing, draft.timing) ? { timing: draft.timing } : {}),
  }
}
