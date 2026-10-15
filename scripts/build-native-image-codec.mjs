/** Build the pinned, product-owned image codec without writing user tool homes. */
import { access, cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const compiler = '1.98.1'
const target = 'wasm32-unknown-unknown'
const expectedExports = ['allocate_input', 'memory', 'prepare_image', 'release_input', 'release_result']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const exists = async path => { try { await access(path); return true } catch { return false } }
const output = (file, argv, options = {}) => execFileSync(file, argv, { encoding: 'utf8', ...options }).trim()

// Seed an owned cache from already available archives; Cargo never downloads implicitly.
async function seedCache(destination, lock) {
  const source = process.env.CARGO_HOME ?? join(homedir(), '.cargo')
  if (resolve(source) === resolve(destination)) throw new Error('image codec Cargo home must be isolated')
  const registry = join(source, 'registry')
  if (!await exists(join(registry, 'index'))) return
  await mkdir(join(destination, 'registry'), { recursive: true })
  for (const index of await readdir(join(registry, 'index'))) {
    if (!index.startsWith('index.crates.io-')) continue
    await cp(join(registry, 'index', index), join(destination, 'registry/index', index), { recursive: true })
  }
  const packages = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\nsource = "registry\+[^\n]+"\nchecksum = "([a-f0-9]{64})"/g)]
  if (!await exists(join(registry, 'cache'))) return
  for (const index of await readdir(join(registry, 'cache'))) {
    if (!index.startsWith('index.crates.io-')) continue
    for (const [, name, version, checksum] of packages) {
      const archive = `${name}-${version}.crate`
      const from = join(registry, 'cache', index, archive)
      if (!await exists(from)) continue
      const bytes = await readFile(from)
      if (sha256(bytes) !== checksum) throw new Error(`cached crate checksum mismatch: ${archive}`)
      const to = join(destination, 'registry/cache', index, archive)
      await mkdir(dirname(to), { recursive: true })
      await writeFile(to, bytes)
    }
  }
}

export async function buildNativeImageCodec(root = fileURLToPath(new URL('../', import.meta.url))) {
  const crate = join(root, 'packages/models/native-image-codec')
  const lib = join(root, 'packages/models/lib')
  const sources = ['Cargo.toml', 'Cargo.lock', 'src/lib.rs', 'LICENSE-APACHE']
  const sourceBytes = await Promise.all(sources.map(file => readFile(join(crate, file))))
  const manifest = sourceBytes[0].toString('utf8')
  if (!manifest.includes(`rust-version = "${compiler}"`) || !manifest.includes(`target = "${target}"`)) throw new Error('image codec compiler or target pin changed')
  const lock = sourceBytes[1].toString('utf8')
  // WASM has no host imports, so a verified release codec also works on macOS.
  const cached = join(root, '.build/native-image-codec/prebuilt')
  const prebuilt = process.env.CODEXY_NATIVE_IMAGE_PREBUILT
    ?? (await exists(join(cached, 'native-image-codec.build.json')) ? cached : undefined)
  if (prebuilt) {
    const metadata = JSON.parse(await readFile(join(prebuilt, 'native-image-codec.build.json'), 'utf8'))
    const wasm = await readFile(join(prebuilt, 'native-image-codec.wasm'))
    if (metadata.format !== 1 || metadata.abi !== 1 || metadata.compiler !== compiler || metadata.target !== target
      || sources.some((file, index) => metadata.sources?.[file] !== sha256(sourceBytes[index]))
      || metadata.wasm?.sha256 !== sha256(wasm) || metadata.wasm?.bytes !== wasm.length) {
      throw new Error('prebuilt image codec does not match the pinned sources or artifact digest')
    }
    const module = await WebAssembly.compile(wasm)
    if (WebAssembly.Module.imports(module).length !== 0
      || JSON.stringify(WebAssembly.Module.exports(module).map(item => item.name).sort()) !== JSON.stringify(expectedExports)) {
      throw new Error('prebuilt image codec WASM ABI mismatch')
    }
    await mkdir(lib, { recursive: true })
    await writeFile(join(lib, 'native-image-codec.wasm'), wasm)
    await writeFile(join(lib, 'native-image-codec.build.json'), JSON.stringify(metadata, null, 2) + '\n')
    await mkdir(join(lib, 'native-image-codec'), { recursive: true })
    await cp(join(crate, 'LICENSE-APACHE'), join(lib, 'native-image-codec/LICENSE-APACHE'))
    process.stdout.write(JSON.stringify({ event: 'native-image-codec-reused', ...metadata }) + '\n')
    return metadata
  }
  const requestedRustc = process.env.CODEXY_NATIVE_IMAGE_RUSTC ?? 'rustc'
  const existingSysroot = output(requestedRustc, ['--print', 'sysroot'])
  const rustc = process.env.CODEXY_NATIVE_IMAGE_RUSTC ?? join(existingSysroot, 'bin/rustc')
  const cargo = process.env.CODEXY_NATIVE_IMAGE_CARGO ?? join(existingSysroot, 'bin/cargo')
  const rustcVersion = output(rustc, ['--version'])
  const cargoVersion = output(cargo, ['--version'])
  if (rustcVersion.split(' ')[1] !== compiler || cargoVersion.split(' ')[1] !== compiler) throw new Error(`image codec requires Rust and Cargo ${compiler}; found ${rustcVersion}; ${cargoVersion}`)
  const sysroot = process.env.CODEXY_NATIVE_IMAGE_SYSROOT ?? existingSysroot
  if (!await exists(join(sysroot, 'lib/rustlib', target, 'lib'))) throw new Error(`missing pinned ${target} standard library in image codec sysroot`)
  const ownedTools = join(root, '.build/native-image-codec')
  const cargoHome = process.env.CODEXY_NATIVE_IMAGE_CARGO_HOME ?? join(ownedTools, 'cargo-home')
  const rustupHome = process.env.CODEXY_NATIVE_IMAGE_RUSTUP_HOME ?? join(ownedTools, 'rustup-home')
  const targetDir = process.env.CODEXY_NATIVE_IMAGE_TARGET_DIR ?? join(ownedTools, 'target')
  for (const path of [cargoHome, rustupHome, targetDir]) {
    if (resolve(path) === resolve(join(homedir(), '.cargo')) || resolve(path) === resolve(join(homedir(), '.rustup'))) throw new Error('image codec tool homes must be isolated')
    await mkdir(path, { recursive: true })
  }
  if (process.env.CODEXY_NATIVE_IMAGE_CARGO_HOME === undefined) await seedCache(cargoHome, lock)
  const env = { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome,
    RUSTC: rustc, RUSTDOC: join(dirname(rustc), 'rustdoc'), CARGO_TARGET_DIR: targetDir,
    CARGO_NET_OFFLINE: 'true', CARGO_ENCODED_RUSTFLAGS: [`--sysroot=${sysroot}`,
      `--remap-path-prefix=${crate}=/codexydsh-native-image-codec`,
      `--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${sysroot}=/rust-sysroot`].join('\u001f') }
  for (const name of ['RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTC_BOOTSTRAP']) delete env[name]
  for (const name of Object.keys(env)) if (name.startsWith('CARGO_PROFILE_') || name.startsWith('CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_')) delete env[name]
  const argv = ['build', '--offline', '--locked', '--release', '--jobs', '4', '--target', target, '--lib', '--manifest-path', join(crate, 'Cargo.toml')]
  execFileSync(cargo, argv, { cwd: crate, env, stdio: 'inherit' })
  if (!(await readFile(join(crate, 'Cargo.lock'))).equals(sourceBytes[1])) throw new Error('image codec build mutated its pinned lock')
  const wasm = await readFile(join(targetDir, target, 'release/codexydsh_native_image_codec.wasm'))
  const module = await WebAssembly.compile(wasm)
  const imports = WebAssembly.Module.imports(module)
  const exports = WebAssembly.Module.exports(module)
  if (imports.length !== 0 || JSON.stringify(exports.map(item => item.name).sort()) !== JSON.stringify(expectedExports)) throw new Error('image codec WASM ABI mismatch')
  const metadata = { format: 1, abi: 1, compiler, target, rustcVersion, cargoVersion,
    wireProfile: 'codex-0.162.1', upstreamTag: 'rust-v0.162.1',
    upstreamSourceSha256: 'e0b791b2c834ec8407e9ce59bffdf047e0b1310a29b2339ff4e037cad4bd280a',
    upstreamLockSha256: '49fe417bcafe3f69f1f6636e23274f90d37e75e388127a76888c39001a4f8117',
    sources: Object.fromEntries(sources.map((file, index) => [file, sha256(sourceBytes[index])])),
    wasm: { file: 'native-image-codec.wasm', bytes: wasm.length, sha256: sha256(wasm), imports, exports } }
  await mkdir(lib, { recursive: true })
  await writeFile(join(lib, 'native-image-codec.wasm'), wasm)
  await writeFile(join(lib, 'native-image-codec.build.json'), JSON.stringify(metadata, null, 2) + '\n')
  await mkdir(join(lib, 'native-image-codec'), { recursive: true })
  await cp(join(crate, 'LICENSE-APACHE'), join(lib, 'native-image-codec/LICENSE-APACHE'))
  process.stdout.write(JSON.stringify({ event: 'native-image-codec-built', ...metadata }) + '\n')
  return metadata
}

if (process.argv[1] !== undefined && await realpath(process.argv[1]).catch(() => undefined) === await realpath(fileURLToPath(import.meta.url))) await buildNativeImageCodec()
