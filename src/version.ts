import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Read package.json at module init via fs+URL so dev (tsx src/version.ts)
// and prod (node dist/cli.js) both resolve to the repo-root package.json.
// import attribute JSON imports would also work but require bundler-aware
// inlining; the fs path is bundler-agnostic and self-explanatory.
const pkgUrl = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version: string }

export const VERSION: string = pkg.version

// `package.json.version` only bumps on a tag (and our tags lag commits), so it
// can't tell a fresh build of `main` from one several commits behind — the
// startup banner showed `v0.3.2` for both. `getBuildId()` reads the git HEAD
// of the checkout the daemon was launched from (anchored to the repo root via
// import.meta.url, NOT cwd, so it works the same from `tsx src/cli.ts` and a
// bundled `dist/cli.js`) and appends `-dirty` when the working tree has
// uncommitted changes. Lazy + cached so only the banner paths pay the git
// spawn — version.ts is imported widely (incl. tests). Fail-soft to 'unknown'
// when git is absent or the checkout isn't a repo. NOTE: this is the HEAD at
// process start, a faithful proxy only when the deploy rebuilds before
// restart; a restart without rebuild would show the new HEAD over stale dist.
let buildIdCache: string | undefined
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function git(args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

export function getBuildId(): string {
  if (buildIdCache !== undefined) return buildIdCache
  try {
    const sha = git(['rev-parse', '--short=12', 'HEAD'])
    if (!sha) {
      buildIdCache = 'unknown'
      return buildIdCache
    }
    let dirty = ''
    try {
      if (git(['status', '--porcelain'])) dirty = '-dirty'
    } catch {
      // status probe failed — report the sha without a dirty marker
    }
    buildIdCache = `${sha}${dirty}`
  } catch {
    buildIdCache = 'unknown'
  }
  return buildIdCache
}
