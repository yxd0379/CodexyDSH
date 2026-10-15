/** Embedded pages retain their remote module graph and use the local streaming proxy. */
import vm from 'node:vm'
import { expect, it } from 'vitest'
import { transformEmbeddedIndex } from '../src/embedding.ts'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, getItem: key => values.get(String(key)) ?? null,
    setItem: (key, value) => { values.set(String(key), String(value)) }, removeItem: key => { values.delete(String(key)) },
    clear: () => { values.clear() }, key: index => [...values.keys()][index] ?? null }
}

function embeddedRealm(host: string, localStorage: Storage, sessionStorage: Storage) {
  const listeners: Array<(event: StorageEvent) => void> = []
  const context = { localStorage, sessionStorage, addEventListener: (_name: string, listener: (event: StorageEvent) => void) => { listeners.push(listener) } }
  const html = transformEmbeddedIndex('<head></head>', `http://127.0.0.1/codexy-remote/${host}/`)
  const script = /<script>(.*?)<\/script>/u.exec(html)?.[1]
  vm.runInNewContext(script!, context)
  return { ...context, receive(event: StorageEvent) { for (const listener of listeners) listener(event) } }
}

it('installs the streaming base ahead of bootstrap and preserves relative resources and transport fields', () => {
  const html = '<!doctype html><html><head><base href="./"><script>bootstrap()</script><script src="./plugins/code.js"></script></head></html>'
  const transformed = transformEmbeddedIndex(html, 'http://127.0.0.1:3080/codexy-remote/dev/')
  const script = /<script>(.*?)<\/script>/u.exec(transformed)?.[1]
  expect(script).toBeDefined()
  const priorFetch = (): void => {}
  const context = { __DSH_TRANSPORT__: { fetch: priorFetch, ownsHost: false, streamBaseUrl: 'http://old/' } }
  vm.runInNewContext(script!, context)
  expect(context.__DSH_TRANSPORT__).toEqual({ fetch: priorFetch, ownsHost: true, streamBaseUrl: 'http://127.0.0.1:3080/codexy-remote/dev/' })
  expect(transformed.indexOf('streamBaseUrl')).toBeLessThan(transformed.indexOf('bootstrap()'))
  expect(transformed).toContain('<base href="./">')
  expect(transformed).toContain('<script src="./plugins/code.js"></script>')
})

it('escapes script markup in a valid directory URL and accepts IPv6 HTTPS bases', () => {
  const transformed = transformEmbeddedIndex('<HEAD data-embedded="true"></HEAD>', 'https://[::1]:3080/codexy-remote/</script>/')
  expect(transformed.match(/<script>/gu)).toHaveLength(1)
  expect(transformed.match(/<\/script>/gu)).toHaveLength(1)
  expect(transformed).toContain('https://[::1]:3080/codexy-remote/%3C/script%3E/')
  const withAmpersand = transformEmbeddedIndex('<head></head>', 'http://127.0.0.1/codexy-remote/dev&tools/')
  const script = /<script>(.*?)<\/script>/u.exec(withAmpersand)?.[1]
  const context: { __DSH_TRANSPORT__?: { streamBaseUrl: string } } = {}
  vm.runInNewContext(script!, context)
  expect(context.__DSH_TRANSPORT__?.streamBaseUrl).toBe('http://127.0.0.1/codexy-remote/dev&tools/')
})

it('rejects non-HTTP carriers, credentials, non-directory bases, and incomplete indices', () => {
  for (const base of ['file:///tmp/', 'http://user:password@127.0.0.1/', 'http://127.0.0.1/dev',
    'http://127.0.0.1/?token=secret', 'http://127.0.0.1/#secret']) {
    expect(() => transformEmbeddedIndex('<head></head>', base)).toThrow('streaming base')
  }
  expect(() => transformEmbeddedIndex('<body>no index</body>', 'http://127.0.0.1/')).toThrow('head element')
})

it('isolates local and session storage by remote host, including property writes, enumeration, and clear', () => {
  const local = memoryStorage()
  const session = memoryStorage()
  local.setItem('dsh.conversation.same-session', 'local draft')
  session.setItem('current-session', 'local session')
  const dev = embeddedRealm('dev', local, session)
  const other = embeddedRealm('other', local, session)
  expect(dev.localStorage.getItem('dsh.conversation.same-session')).toBeNull()
  dev.localStorage.setItem('dsh.conversation.same-session', 'dev draft')
  other.localStorage.setItem('dsh.conversation.same-session', 'other draft')
  dev.sessionStorage.setItem('current-session', 'dev session')
  other.sessionStorage.setItem('current-session', 'other session')
  dev.localStorage.property = 'assigned'
  Object.defineProperty(dev.localStorage, 'defined', { value: 'defined value' })
  expect(dev.localStorage.property).toBe('assigned')
  expect(dev.localStorage.getItem('defined')).toBe('defined value')
  expect(dev.localStorage.length).toBe(3)
  expect(Object.keys(dev.localStorage)).toEqual(['dsh.conversation.same-session', 'property', 'defined'])
  expect(dev.localStorage.key(0)).toBe('dsh.conversation.same-session')
  expect(dev.localStorage.key(-1)).toBeNull()
  expect(dev.localStorage.key(99)).toBeNull()
  delete dev.localStorage.property
  expect(dev.localStorage.getItem('property')).toBeNull()
  const reloaded = embeddedRealm('dev', local, session)
  expect(reloaded.localStorage.getItem('dsh.conversation.same-session')).toBe('dev draft')
  expect(reloaded.sessionStorage.getItem('current-session')).toBe('dev session')
  dev.localStorage.clear(); dev.sessionStorage.clear()
  expect(dev.localStorage.length).toBe(0)
  expect(dev.sessionStorage.length).toBe(0)
  expect(other.localStorage.getItem('dsh.conversation.same-session')).toBe('other draft')
  expect(other.sessionStorage.getItem('current-session')).toBe('other session')
  expect(local.getItem('dsh.conversation.same-session')).toBe('local draft')
  expect(session.getItem('current-session')).toBe('local session')
})

it('suppresses foreign storage events and presents own events with scoped keys and storage areas', () => {
  const local = memoryStorage()
  const realm = embeddedRealm('dev', local, memoryStorage())
  const foreign = { key: 'codexy.remote:/codexy-remote/other/:dsh.keybindings.v1', storageArea: local,
    stopImmediatePropagation() { this.stopped = true }, stopped: false }
  realm.receive(foreign as unknown as StorageEvent)
  expect(foreign.stopped).toBe(true)
  const owned = { key: 'codexy.remote:/codexy-remote/dev/:dsh.keybindings.v1', storageArea: local,
    stopImmediatePropagation() { this.stopped = true }, stopped: false }
  realm.receive(owned as unknown as StorageEvent)
  expect(owned.stopped).toBe(false)
  expect(owned.key).toBe('dsh.keybindings.v1')
  expect(owned.storageArea).toBe(realm.localStorage)
})
