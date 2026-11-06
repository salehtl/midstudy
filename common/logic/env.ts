// The fal environment (contract §3.3): which settings turn mock mode, mock costs and the .env file on and off, and
// how a FAL_KEY line of .env is read. Pure (TScert); common/fal.ts reads the environment and the file.
import { pySplitlines, pyStrip } from './pyfmt.ts'

/** A flag v1 read as on unless it is unset, empty or `0` (`MIDSTUDY_FAL_MOCK_COST`, `MIDSTUDY_NO_DOTENV`). */
export function flagOn(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0'
}

/** v1's `fal_mock()`: any non-empty `MIDSTUDY_FAL_MOCK`. */
export function mockOn(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

function stripChars(s: string, chars: string): string {
  let start = 0
  let end = s.length
  while (start < end && chars.includes(s.charAt(start))) start += 1
  while (end > start && chars.includes(s.charAt(end - 1))) end -= 1
  return s.slice(start, end)
}

/** A key's value in the text of a .env file, as v1 read FAL_KEY: the first `KEY=…` line (an `export ` prefix
 *  allowed) whose value is non-empty once surrounding quotes are stripped; null without one. */
export function dotenvValue(text: string, key: string): string | null {
  for (const raw of pySplitlines(text)) {
    let line = pyStrip(raw)
    if (line.startsWith('export ')) line = line.slice('export '.length)
    line = pyStrip(line)
    const eq = line.indexOf('=')
    if (eq < 0) continue
    if (pyStrip(line.slice(0, eq)) !== key) continue
    const value = stripChars(pyStrip(line.slice(eq + 1)), '\'"')
    if (value !== '') return value
  }
  return null
}

/** The mock folder name of a fal endpoint (contract §3.3): without `fal-ai/`, `/` → `-` (`fal-ai/sam-3/3d-objects` →
 *  `sam-3-3d-objects`, `speridlabs/idol` → `speridlabs-idol`, `openrouter/router` → `openrouter-router`). */
export function mockSlug(endpoint: string): string {
  const rest = endpoint.startsWith('fal-ai/') ? endpoint.slice('fal-ai/'.length) : endpoint
  return rest.replace(/\//g, '-')
}
