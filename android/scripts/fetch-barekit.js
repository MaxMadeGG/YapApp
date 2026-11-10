// Downloads the Bare Kit Android prebuild into app/libs/bare-kit (not in git: ~250 MB).
// Usage: node scripts/fetch-barekit.js [path/to/prebuilds.zip]
// Needs `unzip` (Git Bash / Linux) or PowerShell's Expand-Archive on Windows.
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const VERSION = 'v2.5.5' // matches bare-pack ^1 / bare-link ^1 (--needs libbare-kit.so)
const URL = `https://github.com/holepunchto/bare-kit/releases/download/${VERSION}/prebuilds.zip`
const libs = path.join(__dirname, '..', 'app', 'libs')
const target = path.join(libs, 'bare-kit')

if (fs.existsSync(path.join(target, 'classes.jar'))) {
  console.log('bare-kit already present')
  process.exit(0)
}

let zip = process.argv[2]
if (!zip) {
  zip = path.join(os.tmpdir(), `bare-kit-${VERSION}-prebuilds.zip`)
  if (!fs.existsSync(zip)) {
    console.log('downloading', URL)
    execFileSync('curl', ['-fsSL', '-o', zip, URL], { stdio: 'inherit' })
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-kit-'))
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`], { stdio: 'inherit' })
} else {
  execFileSync('unzip', ['-q', zip, 'android/*', '-d', tmp], { stdio: 'inherit' })
}
fs.mkdirSync(libs, { recursive: true })
fs.cpSync(path.join(tmp, 'android', 'bare-kit'), target, { recursive: true })
fs.rmSync(tmp, { recursive: true, force: true })
console.log('bare-kit', VERSION, '->', target)
