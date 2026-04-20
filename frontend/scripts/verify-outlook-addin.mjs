/**
 * Ensures the Outlook add-in shipped under public/outlook-addin is present in the Vite dist output.
 * Run automatically after `npm run build` via postbuild.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const REQUIRED_DIST = [
  'manifest.xml',
  'manifest.local.xml',
  'taskpane.html',
  'taskpane.js',
  'canary-login.html',
  'styles.css',
]

const distAddin = path.join(root, 'dist', 'outlook-addin')

if (!fs.existsSync(path.join(root, 'dist'))) {
  console.error('[outlook-addin] dist/ missing — run npm run build first')
  process.exit(1)
}

let ok = true
for (const f of REQUIRED_DIST) {
  const p = path.join(distAddin, f)
  if (!fs.existsSync(p)) {
    console.error('[outlook-addin] missing build output:', p)
    ok = false
  }
}

if (!ok) process.exit(1)
console.log('[outlook-addin] verified:', REQUIRED_DIST.length, 'files in dist/outlook-addin/')
