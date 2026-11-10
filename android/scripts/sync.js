// Copies the shared code from the desktop app into the Android project:
// core.js -> worklet, index.html -> WebView (with the Android bridge script added).
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..', '..')
const main = path.join(__dirname, '..', 'app', 'src', 'main')
fs.mkdirSync(path.join(main, 'assets', 'www'), { recursive: true })
fs.copyFileSync(path.join(root, 'core.js'), path.join(main, 'js', 'core.js'))
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
// The UI's one inline <script> uses window.chat; bridge.js must define it first.
if (html.split('<script>').length !== 2) throw new Error('expected exactly one inline <script> in index.html')
html = html.replace('<script>', '<script src="bridge.js"></script>\n<script>')
// Pages load from file:// in the WebView, where 'self' may not cover bridge.js.
html = html.replace("script-src 'self'", "script-src 'self' file:")
if (!html.includes("script-src 'self' file:")) throw new Error('CSP script-src not found in index.html')
fs.writeFileSync(path.join(main, 'assets', 'www', 'index.html'), html)
console.log('synced core.js + index.html')
