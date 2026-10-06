// 应急处置链路冒烟测试的运行器：先用 esbuild 把 TS 测试打到临时文件，再执行。
// 用法：npm run test:flow
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const dir = mkdtempSync(join(tmpdir(), 'flow-smoke-'))
const outfile = join(dir, 'flow.smoke.mjs')

try {
  await build({
    entryPoints: ['test/flow.smoke.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    alias: { '@': './src' },
    outfile,
    logLevel: 'silent',
  })
  await import(pathToFileURL(outfile).href)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
