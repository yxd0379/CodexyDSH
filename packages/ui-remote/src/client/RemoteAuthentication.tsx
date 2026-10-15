/** Shell-owned SSH authentication for connections started anywhere in the window. */
import { useCallback, useId, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { IRemoteHosts } from '@codexydsh/remote/client'
import type { RemoteHostStatus } from '@codexydsh/remote/types'
import { Button, Input, Modal, StateDot } from '@codexydsh/ui-primitives'
import css from './RemoteSettings.module.css'

/** Authentication observes the Host catalog independently of Settings. */
export interface RemoteAuthenticationInjected {
  hooks: { remoteHosts: IRemoteHosts }
  respondAuthentication: IRemoteHosts['respondAuthentication']
}

type AuthenticationProps = PropsRuntime<'shell.overlay'> & PropsLocale<'remote'> & InjectFace<RemoteAuthenticationInjected>
type PendingHost = RemoteHostStatus & { authChallenge: { id: string; prompt: string } }

/** Show one current SSH challenge and discard its input when its identity changes. */
export function RemoteAuthentication({ useRemoteHosts, respondAuthentication, t }: AuthenticationProps) {
  const hosts = useRemoteHosts(value => value)
  const host = hosts.connected ? hosts.items?.find((item): item is PendingHost => item.phase === 'connecting' && item.authChallenge !== undefined) : undefined
  return host ? <AuthenticationDialog key={JSON.stringify([host.name, host.host, host.authChallenge.id, host.authChallenge.prompt])}
    host={host} respondAuthentication={respondAuthentication} t={t} /> : null
}

function AuthenticationDialog({ host, respondAuthentication, t }: {
  host: PendingHost
  respondAuthentication: IRemoteHosts['respondAuthentication']
  t: AuthenticationProps['t']
}) {
  const formId = useId()
  const input = useRef<HTMLInputElement | null>(null)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const bindInput = useCallback((node: HTMLInputElement | null): void => {
    // Ref detachment also clears the old DOM node on a challenge switch or unmount.
    if (input.current !== node && input.current) input.current.value = ''
    input.current = node
  }, [])
  const respond = (cancel: boolean): void => {
    if (pending.current) return
    const response = cancel ? null : input.current?.value ?? ''
    if (input.current) input.current.value = ''
    pending.current = true
    setBusy(true); setFailed(false)
    void respondAuthentication(host.name, host.authChallenge.id, response).catch(() => {
      // Error details must never reflect a credential supplied to another layer.
      pending.current = false; setBusy(false); setFailed(true)
    })
  }
  return <Modal open title={t('authenticationTitle')}
    description={t('authenticationHost', { name: host.name, host: host.host })}
    closeLabel={t('cancelConnection')} onClose={() => { respond(true) }}
    footer={<>
      <Button disabled={busy} onClick={() => { respond(true) }}>{t('cancelConnection')}</Button>
      <Button type="submit" form={formId} variant="primary" disabled={busy}>{busy && <StateDot state="ongoing" />}{t('authenticationSubmit')}</Button>
    </>}>
    <form id={formId} className={css.editor} onSubmit={event => { event.preventDefault(); respond(false) }}>
      <label className={css.field}>{host.authChallenge.prompt}
        <Input ref={bindInput} type="password" autoComplete="off" autoCapitalize="none" spellCheck={false}
          disabled={busy} data-modal-autofocus />
      </label>
      <p className={css.secondary}>{t('authenticationHint')}</p>
      {failed && <p className={css.error} role="alert">{t('authenticationFailed')}</p>}
    </form>
  </Modal>
}
