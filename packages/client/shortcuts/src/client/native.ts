/** Desktop gestures use live focus, modal state, and verified embedding ownership. */
import { modalSelector } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DesktopKeyboardApi, ShortcutConfigSnapshot } from '../protocol.ts'
import type { ShortcutRegistry } from './registry.ts'
import type { ShortcutContext } from './types.ts'

/**
 * Resolve the input owner in this document, never in another Host's iframe.
 * @param window - the client document owning the command registry.
 * @returns current input target, region, and top modal.
 */
export function focusedShortcutContext(window: Window): ShortcutContext {
  let target = window.document.activeElement
  while (target?.shadowRoot?.activeElement != null && !target.matches('webview[data-sidebar-browser-frame]')) {
    target = target.shadowRoot.activeElement
  }
  const top = [...window.document.querySelectorAll<HTMLElement>(modalSelector)].at(-1)
  const region = target?.closest('.xterm') ? 'terminal' as const
    : target?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') ? 'editable' as const : 'page' as const
  return { target, region, modal: top?.dataset.shortcutModal ?? (top === undefined ? null : 'other') }
}

function remoteFrameOrigin(window: Window, target: Element | null): string | undefined {
  if (!(target instanceof HTMLIFrameElement) || !target.isConnected) return undefined
  const host = target.dataset.codexydshRemoteFrame
  if (!host || target.name !== `codexydsh-remote-${host}`) return undefined
  const parent = new URL(window.location.href)
  const child = new URL(target.src, parent)
  if (child.protocol !== parent.protocol || child.host !== parent.host
    || !child.pathname.startsWith(`/codexy-remote/${encodeURIComponent(host)}/`)
    || child.searchParams.get('codexydsh-embedded') !== '1') return undefined
  return child.protocol === 'dsh-app:' && child.hostname === 'app' ? '*'
    : child.protocol === 'http:' || child.protocol === 'https:' ? child.origin : undefined
}

/**
 * Route native menu, main-frame, and embedded-frame input through the shared command registry.
 * @param window - trusted product document.
 * @param keyboard - top-frame preload capability.
 * @param registry - window-local command owner.
 * @param snapshot - latest accepted configuration.
 * @param reset - clears pending fixed sequences when native input bypasses DOM delivery.
 * @returns disposer releasing native input.
 */
export function installNativeKeyboard(window: Window, keyboard: DesktopKeyboardApi, registry: ShortcutRegistry,
  snapshot: () => ShortcutConfigSnapshot, reset?: () => void): () => void {
  return keyboard.subscribe((input) => {
    if (input.revision !== snapshot().revision) return
    reset?.()
    const context = focusedShortcutContext(window)
    const { target } = context
    if (context.modal === null && target instanceof HTMLIFrameElement
      && target.hasAttribute('data-codexydsh-remote-frame')) {
      const origin = remoteFrameOrigin(window, target)
      if (input.kind === 'menu' && origin !== undefined) {
        target.contentWindow?.postMessage({ source: 'codexydsh-native-shortcut', commandId: input.commandId }, origin)
      }
      // A delayed outer-frame gesture must not act on the local session after focus enters Remote.
      return
    }
    if (input.kind === 'menu') {
      registry.invoke(input.commandId, context)
      return
    }
    if (input.kind === 'keyboard') {
      registry.dispatch({ ...input, composing: false, defaultPrevented: false }, context, () => {})
      return
    }
    // Renderer focus and embedding identity may change after preload verification.
    if (input.kind === 'webview') {
      if (target?.matches('webview[data-sidebar-browser-frame]') !== true || !target.isConnected
        || input.frameName === '' || target.getAttribute('name') !== input.frameName) return
      registry.dispatch({ ...input, composing: false, defaultPrevented: false }, { ...context, source: 'webview' }, () => {})
      return
    }
    if (!(target instanceof HTMLIFrameElement) || !target.isConnected
      || !target.matches('iframe[data-sidebar-browser-frame], iframe[data-html-preview]')
      || input.frameName === '' || target.name !== input.frameName) return
    registry.dispatch({ ...input, composing: false, defaultPrevented: false }, { ...context, source: 'iframe' }, () => {})
  })
}
