/** External writer exercising the same portable lock protocol. */
import lockfile from 'proper-lockfile'
const release = await lockfile.lock(process.argv[2], { realpath: false, retries: 0, stale: 30000, update: 10000 })
process.send?.({ ready: true })
process.once('message', async () => { await release(); process.disconnect() })
