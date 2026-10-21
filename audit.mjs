/**
 * Pre-publish audit: scan exactly the files that will be committed for
 * secrets, personal identifiers, and machine-specific values.
 *
 * Run with `node audit.mjs`. Prints every hit with file:line, and exits
 * non-zero when a category that must be clean has any hit.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Token prefixes are assembled at runtime so that this scanner's own source
// does not contain them — otherwise it flags itself, and a scanner that cries
// wolf on its own file trains the reader to ignore it.
const TOKEN_PREFIXES = ['gh' + 'o_', 'gh' + 'p_', 'gh' + 's_', 'github' + '_pat_', 'sk' + '-', 'AK' + 'IA', 'xox' + '[baprs]-', 'AI' + 'za']

const PATTERNS = [
  {
    name: 'API keys / tokens',
    mustBeClean: true,
    re: new RegExp(`(?:${TOKEN_PREFIXES.join('|')})[A-Za-z0-9_-]{12,}`, 'g'),
  },
  {
    name: 'assigned secrets',
    mustBeClean: true,
    re: /(?:api[_-]?key|secret|password|passwd|token|credential|private[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/gi,
  },
  {
    name: 'private key blocks',
    mustBeClean: true,
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'personal home paths',
    mustBeClean: true,
    re: /(?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/)[A-Za-z0-9._-]+/g,
  },
  {
    name: 'email addresses',
    mustBeClean: true,
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    name: 'private IPv4 ranges',
    mustBeClean: true,
    re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
  },
  // Informational: these are fine in a public repo, but listing them lets a
  // human confirm nothing unexpected slipped in.
  {
    name: 'bare C: / D: path mentions (informational)',
    mustBeClean: false,
    re: /\b[A-Z]:\\(?:[A-Za-z0-9_.-]+)/g,
  },
]

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .map(line => line.trim())
  .filter(line => line !== '')

let failures = 0
let scannedBytes = 0

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    console.log(`SKIP (binary or unreadable): ${file}`)
    continue
  }
  scannedBytes += Buffer.byteLength(text)
  const lines = text.split('\n')

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    for (let index = 0; index < lines.length; index += 1) {
      pattern.re.lastIndex = 0
      const match = pattern.re.exec(lines[index])
      if (match === null) continue
      const verdict = pattern.mustBeClean ? 'FAIL' : 'info'
      if (pattern.mustBeClean) failures += 1
      console.log(`${verdict}  ${file}:${index + 1}  [${pattern.name}]  ${JSON.stringify(match[0])}`)
    }
  }
}

console.log(`\nscanned ${files.length} files, ${(scannedBytes / 1024).toFixed(1)} KiB`)
console.log(files.map(file => `  ${file}`).join('\n'))

if (failures > 0) {
  console.error(`\nAUDIT FAILED: ${failures} blocking hit(s). Do not publish until cleared.`)
  process.exit(1)
}
console.log('\nAUDIT PASSED: no secrets, credentials, personal paths, emails, or private IPs.')
