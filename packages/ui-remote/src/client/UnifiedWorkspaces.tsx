/** One workspace browser for local folders and SSH folders. */
import { useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  Button, Input, Menu, Modal, StateDot,
  IconArchiveOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconCloseOutlineRegular, IconEllipsisOutlineRegular, IconFolderCloseRegular,
  IconFolderOpenOutlineRegular, IconPinFillRegular, IconPlusOutlineRegular,
  IconSearchOutlineRegular, IconSlidersTwoOutlineRegular,
} from '@codexydsh/ui-primitives'
import css from './UnifiedWorkspaces.module.css'

export interface UnifiedWorkspaceSession {
  key: string
  id: string
  title: string
  running: boolean
  active: boolean
  pinned?: boolean
  archived?: boolean
  updatedAt?: number
  status?: 'approval' | 'question' | 'plan'
}
export interface UnifiedWorkspaceRow {
  key: string
  id: string
  title: string
  path: string
  host?: string
  sessions: UnifiedWorkspaceSession[]
  connected?: boolean
  error?: string
}
export interface UnifiedWorkspaceHost { name: string; label?: string }
export interface UnifiedWorkspaceSnapshot {
  items: UnifiedWorkspaceRow[]
  hosts: UnifiedWorkspaceHost[]
  loading?: boolean
  error?: string
}
export interface CreateUnifiedWorkspace { host?: string; path: string; newHost?: string }
type Operation = void | Promise<void>
/** Product actions route identities to their owning controller; presentation does not route RPCs. */
export interface UnifiedWorkspacesInjected {
  hooks: { unifiedWorkspaces: SnapshotStore<UnifiedWorkspaceSnapshot> }
  openWorkspace(row: UnifiedWorkspaceRow): Operation
  openSession(row: UnifiedWorkspaceRow, session: UnifiedWorkspaceSession): Operation
  newSession(row: UnifiedWorkspaceRow): Operation
  renameWorkspace(row: UnifiedWorkspaceRow, title: string): Operation
  removeWorkspace(row: UnifiedWorkspaceRow): Operation
  renameSession(row: UnifiedWorkspaceRow, session: UnifiedWorkspaceSession, title: string): Operation
  forkSession(row: UnifiedWorkspaceRow, session: UnifiedWorkspaceSession): Operation
  pinSession(row: UnifiedWorkspaceRow, session: UnifiedWorkspaceSession, pinned: boolean): Operation
  archiveSession(row: UnifiedWorkspaceRow, session: UnifiedWorkspaceSession, archived: boolean): Operation
  pickLocalDirectory(): Promise<string | null>
  createWorkspace(input: CreateUnifiedWorkspace): Promise<void>
}
export type UnifiedWorkspacesProps = PropsRuntime<'sidebar.workspaces'> & InjectFace<UnifiedWorkspacesInjected>
type EditTarget = { row: UnifiedWorkspaceRow; session?: UnifiedWorkspaceSession }
type SessionAction = 'rename' | 'fork' | 'pin' | 'archive'

/** Both local and remote sessions use this exact row and action menu. */
function SessionRow({ row, session, onOpen, onAction, flat }: {
  row: UnifiedWorkspaceRow
  session: UnifiedWorkspaceSession
  onOpen(): void
  onAction(action: SessionAction): void
  flat: boolean
}) {
  const [menu, setMenu] = useState(false)
  const status = session.status === 'approval' ? '等待审批' : session.status === 'plan' ? '等待计划确认' : session.status === 'question' ? '等待回答' : ''
  return <div className={css.sessionRow} data-testid="workspace-session" data-workspace={row.key} data-workspace-session={session.key} data-active={session.active || undefined} data-archived={session.archived || undefined}>
    <button type="button" className={css.sessionButton} aria-current={session.active ? 'page' : undefined}
      title={`${session.title || '未命名'}${flat ? ` · ${row.title}` : ''}${status ? ` · ${status}` : ''}`} disabled={session.archived}
      onClick={onOpen} onDoubleClick={() => { onAction('rename') }}>
      <span className={css.state}>{!session.archived && (status ? <StateDot state="warning" size={8} /> : session.running ? <StateDot state="ongoing" size={12} /> : session.pinned ? <IconPinFillRegular size={12} /> : null)}</span>
      <span className={css.sessionTitle}>{session.title || '未命名'}</span>
      {status && <span className={css.status}>{status === '等待审批' ? '审批' : status === '等待回答' ? '回答' : '计划'}</span>}
    </button>
    <div className={css.rowActions} data-menu-open={menu || undefined}>
      <Menu open={menu} portal align="end" compact onClose={() => { setMenu(false) }}
        anchor={<button type="button" className={css.iconButton} aria-label={`${session.title || '未命名'}的操作`} aria-expanded={menu} onClick={() => { setMenu(!menu) }}><IconEllipsisOutlineRegular size={16} /></button>}
        items={[
          ...session.archived ? [] : [{ id: 'pin', label: session.pinned ? '取消置顶' : '置顶' }],
          { id: 'rename', label: '重命名' }, { id: 'fork', label: '分支会话' },
          { type: 'separator', id: 'separator' }, { id: 'archive', label: session.archived ? '取消归档' : '归档' },
        ]} onSelect={id => { setMenu(false); onAction(id as SessionAction) }} />
      <button type="button" className={css.iconButton} aria-label={`${session.archived ? '取消归档' : '归档'} ${session.title || '未命名'}`} onClick={() => { onAction('archive') }}><IconArchiveOutlineRegular size={14} /></button>
    </div>
  </div>
}

/** Common add flow owns location selection, folder choice, and recoverable errors. */
function CreateWorkspaceDialog({ hosts, onClose, pickLocalDirectory, createWorkspace }: {
  hosts: UnifiedWorkspaceHost[]
  onClose(): void
  pickLocalDirectory(): Promise<string | null>
  createWorkspace(input: CreateUnifiedWorkspace): Promise<void>
}) {
  const [location, setLocation] = useState('local')
  const [newHost, setNewHost] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const local = location === 'local'
  const close = (): void => { if (!busy) onClose() }
  const choose = async (): Promise<void> => {
    setBusy(true); setError('')
    try { const picked = await pickLocalDirectory(); if (picked) setPath(picked) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const submit = async (): Promise<void> => {
    const folder = path.trim()
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(folder)) { setError('请输入文件夹的绝对路径'); return }
    const address = newHost.trim()
    if (location === 'new' && (!address || /\s/.test(address) || address.startsWith('-'))) { setError('请输入 SSH 主机或 user@主机'); return }
    setBusy(true); setError('')
    try {
      await createWorkspace({ path: folder, ...local ? {} : location === 'new' ? { newHost: address } : { host: location.slice(5) } })
      onClose()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  return <Modal open title="添加工作区" closeLabel="关闭" onClose={close} className={css.dialog}>
    <form className={css.form} onSubmit={event => { event.preventDefault(); void submit() }}>
      <label className={css.field}>位置
        <select data-modal-autofocus aria-label="位置" value={location} disabled={busy} onChange={event => { setLocation(event.target.value); setPath(''); setError('') }}>
          <option value="local">本机</option>
          {hosts.map(host => <option key={host.name} value={`host:${host.name}`}>{host.label || host.name}</option>)}
          <option value="new">添加 SSH 主机…</option>
        </select>
      </label>
      {location === 'new' && <label className={css.field}>SSH 主机<Input aria-label="SSH 主机" required placeholder="user@host" value={newHost} disabled={busy} onChange={event => { setNewHost(event.target.value) }} /></label>}
      <label className={css.field}>文件夹
        <div className={css.folderField}><Input aria-label="文件夹" required placeholder={local ? '/Users/…' : '/home/…'} value={path} disabled={busy} onChange={event => { setPath(event.target.value) }} />
          {local && <Button variant="outline" disabled={busy} onClick={() => { void choose() }}>选择文件夹</Button>}</div>
      </label>
      {error && <p role="alert" className={css.error}>{error}</p>}
      <div className={css.dialogActions}><Button disabled={busy} onClick={close}>取消</Button><Button type="submit" variant="primary" disabled={busy}>{busy && <StateDot state="ongoing" />}添加</Button></div>
    </form>
  </Modal>
}

/** One section and one interaction model, with location carried by each workspace. */
export function UnifiedWorkspaces(props: UnifiedWorkspacesProps) {
  const { wide, expandSidebar, useUnifiedWorkspaces } = props
  const snapshot = useUnifiedWorkspaces(value => value)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState(false)
  const [viewMenu, setViewMenu] = useState(false)
  const [grouped, setGrouped] = useState(true)
  const [archives, setArchives] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({})
  const [workspaceMenu, setWorkspaceMenu] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<EditTarget>()
  const [title, setTitle] = useState('')
  const [removing, setRemoving] = useState<UnifiedWorkspaceRow>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const run = (operation: () => Operation): void => {
    setError('')
    void Promise.resolve().then(operation).catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) })
  }
  const rename = (target: EditTarget): void => { setEditing(target); setTitle(target.session?.title ?? target.row.title); setError('') }
  const sessionAction = (row: UnifiedWorkspaceRow, session: UnifiedWorkspaceSession, action: SessionAction): void => {
    if (action === 'rename') rename({ row, session })
    else if (action === 'fork') run(() => props.forkSession(row, session))
    else if (action === 'pin') run(() => props.pinSession(row, session, !session.pinned))
    else run(() => props.archiveSession(row, session, !session.archived))
  }
  const settle = async (operation: () => Operation, close: () => void): Promise<void> => {
    setBusy(true); setError('')
    try { await operation(); close() }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const needle = query.trim().toLocaleLowerCase()
  const filtered = snapshot.items.map(row => {
    const workspaceMatch = `${row.title} ${row.path} ${row.host ?? ''}`.toLocaleLowerCase().includes(needle)
    const sessions = row.sessions.filter(session => (archives || !session.archived) && (!needle || workspaceMatch || session.title.toLocaleLowerCase().includes(needle)))
      .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    return { row, sessions, workspaceMatch }
  }).filter(item => !needle || item.workspaceMatch || item.sessions.length > 0)
  const renderSession = (row: UnifiedWorkspaceRow, session: UnifiedWorkspaceSession, flat = false) => <SessionRow key={session.key} row={row} session={session} flat={flat}
    onOpen={() => { run(() => props.openSession(row, session)) }} onAction={action => { sessionAction(row, session, action) }} />
  if (!wide) return <div className={css.rail}><button type="button" className={css.iconButton} aria-label="工作区" onClick={expandSidebar}><IconFolderOpenOutlineRegular size={18} /></button></div>
  return <section className={css.root} aria-label="工作区" data-testid="unified-workspaces">
    <header className={css.header}>
      {search ? <div className={css.search}><IconSearchOutlineRegular size={14} /><input ref={searchRef} autoFocus aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={event => { setQuery(event.target.value) }} onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearch(false) } }} /><button type="button" className={css.iconButton} aria-label="关闭搜索" onClick={() => { setSearch(false); setQuery('') }}><IconCloseOutlineRegular size={14} /></button></div>
        : <><span className={css.heading}>工作区</span><button type="button" className={css.iconButton} title="搜索会话" aria-label="搜索会话" onClick={() => { setSearch(true) }}><IconSearchOutlineRegular size={14} /></button></>}
      <Menu open={viewMenu} portal align="end" compact onClose={() => { setViewMenu(false) }} selectedIds={[grouped ? 'grouped' : 'flat', ...archives ? ['archives'] : []]}
        anchor={<button type="button" className={css.iconButton} title="视图选项" aria-label="视图选项" aria-expanded={viewMenu} onClick={() => { setViewMenu(!viewMenu) }}><IconSlidersTwoOutlineRegular size={14} /></button>}
        items={[{ id: 'grouped', label: '按工作区分组' }, { id: 'flat', label: '所有会话' }, { type: 'separator', id: 'separator' }, { id: 'archives', label: '显示已归档' }]}
        onSelect={id => { if (id === 'archives') setArchives(!archives); else setGrouped(id === 'grouped'); setViewMenu(false) }} />
      <button type="button" className={css.iconButton} title="添加工作区" aria-label="添加工作区" onClick={() => { setAdding(true); setError('') }}><IconPlusOutlineRegular size={16} /></button>
    </header>
    <div className={css.list}>
      {snapshot.loading && <div className={css.loading} aria-label="正在加载工作区"><StateDot state="ongoing" /></div>}
      {grouped && !needle ? filtered.map(({ row, sessions }) => {
        const open = !collapsed[row.key]
        let idleCount = 0
        const shown = expandedSessions[row.key] ? sessions : sessions.filter(session => session.running || session.active || session.status || idleCount++ < 5)
        return <div className={css.group} key={row.key} data-testid="workspace-group" data-workspace={row.key}>
          <div className={css.workspaceRow}>
            <button type="button" className={css.disclosure} aria-label={`${open ? '收起' : '展开'} ${row.title}`} aria-expanded={open} onClick={() => { setCollapsed({ ...collapsed, [row.key]: open }) }}>
              <span className={css.folder}><IconFolderCloseRegular size={16} /></span><span className={css.chevron}>{open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}</span>
            </button>
            <button type="button" className={css.workspaceButton} title={`${row.host ? `${row.host}: ` : ''}${row.path}`} data-testid="workspace-open" onClick={() => { setCollapsed({ ...collapsed, [row.key]: false }); run(() => props.openWorkspace(row)) }}>
              <span className={css.workspaceTitle}>{row.title || row.path}</span>{row.host && <span className={css.host}>{row.host}</span>}
            </button>
            <div className={css.workspaceActions} data-menu-open={workspaceMenu === row.key || undefined}>
              <Menu open={workspaceMenu === row.key} portal align="end" compact onClose={() => { setWorkspaceMenu(undefined) }}
                anchor={<button type="button" className={css.iconButton} aria-label={`${row.title}的操作`} aria-expanded={workspaceMenu === row.key} onClick={() => { setWorkspaceMenu(workspaceMenu === row.key ? undefined : row.key) }}><IconEllipsisOutlineRegular size={15} /></button>}
                items={[{ id: 'open', label: '打开工作区' }, { id: 'rename', label: '重命名' }, { id: 'remove', label: '移除工作区' }]}
                onSelect={id => { setWorkspaceMenu(undefined); if (id === 'rename') rename({ row }); else if (id === 'remove') { setRemoving(row); setError('') } else run(() => props.openWorkspace(row)) }} />
              <button type="button" className={css.iconButton} title="新会话" aria-label={`新会话 ${row.title}`} onClick={() => { run(() => props.newSession(row)) }}><IconPlusOutlineRegular size={15} /></button>
            </div>
          </div>
          {row.error && <p className={css.error} role="alert">{row.error}</p>}
          {open && <div className={css.sessions}>{shown.map(session => renderSession(row, session))}
            {sessions.length > shown.length && <button type="button" className={css.showMore} onClick={() => { setExpandedSessions({ ...expandedSessions, [row.key]: true }) }}>展开其余 {sessions.length - shown.length} 个会话</button>}
            {expandedSessions[row.key] && sessions.length > 5 && <button type="button" className={css.showMore} onClick={() => { setExpandedSessions({ ...expandedSessions, [row.key]: false }) }}>收起</button>}
          </div>}
        </div>
      }) : filtered.flatMap(({ row, sessions }) => sessions.map(session => renderSession(row, session, true)))}
      {!snapshot.loading && (needle && filtered.every(item => item.sessions.length === 0) || !grouped && filtered.every(item => item.sessions.length === 0)) && <p className={css.empty}>暂无会话</p>}
      {(snapshot.error || error && !editing && !removing) && <p role="alert" className={css.error}>{snapshot.error || error}</p>}
    </div>
    {adding && <CreateWorkspaceDialog hosts={snapshot.hosts} onClose={() => { setAdding(false) }} pickLocalDirectory={props.pickLocalDirectory} createWorkspace={props.createWorkspace} />}
    <Modal open={editing !== undefined} title={editing?.session ? '重命名会话' : '重命名工作区'} closeLabel="关闭" onClose={() => { if (!busy) setEditing(undefined) }} className={css.dialog}>
      <form className={css.form} onSubmit={event => { event.preventDefault(); if (editing && title.trim()) void settle(() => editing.session ? props.renameSession(editing.row, editing.session, title.trim()) : props.renameWorkspace(editing.row, title.trim()), () => { setEditing(undefined) }) }}>
        <label className={css.field}>名称<Input data-modal-autofocus aria-label="名称" required value={title} disabled={busy} onChange={event => { setTitle(event.target.value) }} /></label>
        {error && <p role="alert" className={css.error}>{error}</p>}
        <div className={css.dialogActions}><Button disabled={busy} onClick={() => { setEditing(undefined) }}>取消</Button><Button type="submit" variant="primary" disabled={busy || !title.trim()}>保存</Button></div>
      </form>
    </Modal>
    <Modal open={removing !== undefined} title="移除工作区" closeLabel="关闭" onClose={() => { if (!busy) setRemoving(undefined) }} className={css.dialog}>
      <p className={css.confirmation}>移除“{removing?.title}”？文件夹和会话记录会保留。</p>
      {error && <p role="alert" className={css.error}>{error}</p>}
      <div className={css.dialogActions}><Button disabled={busy} onClick={() => { setRemoving(undefined) }}>取消</Button><Button variant="primary" disabled={busy} onClick={() => { if (removing) void settle(() => props.removeWorkspace(removing), () => { setRemoving(undefined) }) }}>移除</Button></div>
    </Modal>
  </section>
}
