import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const packageDirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(root, 'packages', entry.name))
  .filter((dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).private !== true
    } catch {
      return false
    }
  })

const manifests = new Map(
  packageDirs.map((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return [manifest.name, manifest]
  }),
)

const destination = mkdtempSync(join(tmpdir(), 'bettersync-pack-'))

try {
  for (const packageDir of packageDirs) {
    const before = new Set(readdirSync(destination))
    execFileSync('pnpm', ['pack', '--pack-destination', destination], {
      cwd: packageDir,
      stdio: 'pipe',
    })
    const tarball = readdirSync(destination)
      .find((entry) => entry.endsWith('.tgz') && !before.has(entry))
    if (!tarball) throw new Error(`No tarball produced for ${basename(packageDir)}`)

    const packed = JSON.parse(execFileSync('tar', ['-xOf', join(destination, tarball), 'package/package.json'], {
      encoding: 'utf8',
    }))
    for (const [name, version] of Object.entries(packed.dependencies ?? {})) {
      const local = manifests.get(name)
      if (!local) continue
      if (typeof version !== 'string' || version.startsWith('workspace:')) {
        throw new Error(`${packed.name} packed an unresolved ${name}@${String(version)}`)
      }
      if (version !== local.version) {
        throw new Error(
          `${packed.name} packs ${name}@${version}, expected local release ${local.version}`,
        )
      }
    }
    console.log(`ok ${packed.name}@${packed.version}`)
  }
} finally {
  rmSync(destination, { recursive: true, force: true })
}
