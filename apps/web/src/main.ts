/** Browser entry for the Web client. */
import '@deepseek-ai/dsh-client-ui-theme/brand-font.css'
import { AppWebEntry, applyIndexInjections } from '@deepseek-ai/dsh-client-web'
import { embeddedTransport, isEmbeddedWeb } from './embedded-transport.ts'

interface DesktopBootGlobal {
  dshDesktopBoot?: {
    failed(message: string): Promise<void>
    ready(): Promise<{ injections: Parameters<typeof applyIndexInjections>[0]; streamBaseUrl: string }>
  }
}
const embedded = isEmbeddedWeb(new URL(location.href), window.parent !== window)
const desktop = embedded ? undefined : (globalThis as DesktopBootGlobal).dshDesktopBoot
const reportFailure = (reason: unknown): void => {
  if (desktop === undefined) throw reason
  void desktop.failed(reason instanceof Error ? reason.message : String(reason)).catch(console.error)
}

try {
  const el = document.getElementById('root')
  if (el === null) throw new Error('web app: missing #root')
  if (embedded) {
    // The same-origin parent supplies an address, never its live Connection or preload objects.
    const parent = window.parent as Window & { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }
    const transport = embeddedTransport(new URL(location.href), parent.__DSH_TRANSPORT__?.streamBaseUrl)
    if (transport !== undefined) {
      (globalThis as { __DSH_TRANSPORT__?: typeof transport }).__DSH_TRANSPORT__ = transport
    }
    // The child owns a Web document, not the native window's caption or keyboard bridge.
    document.documentElement.removeAttribute('data-platform')
    document.documentElement.removeAttribute('data-windows-titlebar')
    document.documentElement.removeAttribute('data-fullscreen')
  }
  const entry = new AppWebEntry(el)
  if (desktop !== undefined) {
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    if (gate === undefined) throw new Error('desktop web: boot readiness is missing')
    void desktop.ready().then(async ({ injections, streamBaseUrl }) => {
      const transport = globalThis as { __DSH_TRANSPORT__?: { ownsHost: boolean; streamBaseUrl: string } }
      transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
      await applyIndexInjections(injections, src => new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.onload = () => { resolve() }
        script.onerror = () => { reject(new Error(`desktop web: failed to load ${src}`)) }
        document.head.append(script)
      }))
      gate.resolve()
    }).catch((error: unknown) => { gate.reject(error) })
  }
  void entry.run(desktop === undefined ? undefined : reportFailure)
} catch (reason) {
  reportFailure(reason)
}
