import { readFileSync } from 'node:fs'

// Read package.json at module init via fs+URL so dev (tsx src/version.ts)
// and prod (node dist/cli.js) both resolve to the repo-root package.json.
// import attribute JSON imports would also work but require bundler-aware
// inlining; the fs path is bundler-agnostic and self-explanatory.
const pkgUrl = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version: string }

export const VERSION: string = pkg.version
