/** Hidden Electron shell with the same secure dsh-app scheme and Host carrier as Desktop. */
const { app, BrowserWindow, protocol, net, session } = require('electron')
const local = new URL(process.env.CODEXY_REMOTE_BROWSER_URL)
app.setPath('userData', process.env.CODEXY_REMOTE_BROWSER_USER_DATA)
protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }])
app.whenReady().then(async () => {
  const authorization = await fetch(local.href, { redirect: 'manual' })
  if (authorization.status !== 303) throw new Error('Fixture local authentication failed')
  const cookie = authorization.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  protocol.handle('dsh-app', async request => {
    const address = new URL(request.url)
    if (address.hostname !== 'app') return new Response(null, { status: 404 })
    const headers = new Headers(request.headers)
    for (const header of ['origin', 'referer', 'host', 'cookie', 'sec-fetch-site']) headers.delete(header)
    headers.set('cookie', cookie)
    const url = new URL(address.pathname + address.search, local.origin)
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()
    const response = await net.fetch(url.href, { method: request.method, headers, body, redirect: 'manual' })
    if (address.pathname !== '/' || !response.headers.get('content-type')?.includes('text/html')) return response
    const source = await response.text()
    const outputHeaders = new Headers(response.headers)
    outputHeaders.delete('content-length'); outputHeaders.delete('content-encoding')
    const injection = `<script>globalThis.__DSH_TRANSPORT__={ownsHost:true,streamBaseUrl:${JSON.stringify(local.origin + '/')}};</script>`
    return new Response(source.replace('<head>', '<head>' + injection), { status: response.status, headers: outputHeaders })
  })
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*'] }, (details, callback) => {
    const url = new URL(details.url)
    if (url.host !== local.host) return callback({ requestHeaders: details.requestHeaders })
    callback({ requestHeaders: { ...details.requestHeaders, Cookie: cookie, Origin: local.origin } })
  })
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await window.loadURL('dsh-app://app/')
}).catch(error => { console.error(error.message); app.exit(1) })
app.on('window-all-closed', () => app.quit())
