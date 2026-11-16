import type { ReactNode } from 'react'
import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {beforeEach,describe,expect,it,vi} from 'vitest'
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}))
vi.mock('@/lib/tauri',()=>({invoke,listen:vi.fn()}))
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}))
vi.mock('@/components/ui/dialog',()=>{
  const Part=({children}:{children:ReactNode})=><div>{children}</div>
  return {Dialog:({open,children}:{open:boolean;children:ReactNode})=>open?<div>{children}</div>:null,
    DialogContent:Part,DialogDescription:Part,DialogFooter:Part,DialogHeader:Part,DialogTitle:Part}
})
import {UpdateDialog} from './UpdateDialog'
import {useUpdaterStore,type UpdateInfo} from '@/stores/updaterStore'
describe('update progress display',()=>{
  beforeEach(()=>{
    invoke.mockReset().mockResolvedValue(true)
    useUpdaterStore.setState({dialogOpen:true,skippedVersion:null,applying:true,lastError:null,
      pendingUpdate:{latest_tag:'teacher-v3.7.2.15',latest_version:'3.7.2.15',body:'notes',asset_size:100*1024*1024,html_url:'https://github.com/xcymm3/Akagi-Teacher/releases/latest'} as UpdateInfo,
      progress:{stage:'downloading',downloaded:50*1024*1024,total:100*1024*1024},applyStartedAt:Date.now()-1000,progressAt:Date.now()})
  })
  it('shows real byte progress and keeps manual download available',()=>{
    render(<UpdateDialog />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    expect(screen.getByText(/50.0 \/ 100.0 MiB/)).toBeDefined()
    expect((screen.getByRole('button',{name:'updates.dialog.open_release'}) as HTMLButtonElement).disabled).toBe(false)
  })
  it('requests cancellation and disables cancel once installation begins',async()=>{
    render(<UpdateDialog />)
    fireEvent.click(screen.getByRole('button',{name:'取消下载'}))
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith('cancel_update'))
    expect(useUpdaterStore.getState().applying).toBe(true)
    useUpdaterStore.setState({progress:{stage:'installing',downloaded:100,total:100}})
    await waitFor(()=>expect((screen.getByRole('button',{name:'取消下载'}) as HTMLButtonElement).disabled).toBe(true))
  })
})
