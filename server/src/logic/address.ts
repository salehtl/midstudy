// §2.9 URL and page fetches: which addresses the server never connects to (v1 `BLOCKED_NETS`, `address_blocked`),
// and the evals' one exemption (`MIDSTUDY_FETCH_ALLOW`, v1 `fetch_allowed`). Addresses are parsed as Python's
// ipaddress module parses them. Pure (TScert).
import { hexDigits } from '../../../common/logic/pyfmt.ts'

/** A dotted-decimal IPv4 address as a number, or null (Python's rules: four decimal octets 0–255, no leading zero). */
export function parseIpv4(s: string): number | null {
  const octets = s.split('.')
  if (octets.length !== 4) return null
  let value = 0
  for (const o of octets) {
    if (!/^[0-9]{1,3}$/.test(o)) return null
    if (o.length > 1 && o.startsWith('0')) return null
    const n = parseInt(o, 10)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value
}

function hextet(s: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(s)) return null
  return parseInt(s, 16)
}

/** An IPv6 address as its eight 16-bit groups, or null. Python's ipaddress rules, step by step: an IPv4 tail becomes
 *  two groups, at most nine parts, one `::` at most, a leading or trailing `:` only as part of `::`, 1–4 hex digits a
 *  group. */
export function parseIpv6(text: string): readonly number[] | null {
  // A scope (`fe80::1%en0`) is allowed and ignored; an empty one, or a second `%`, is not.
  const pct = text.indexOf('%')
  if (pct >= 0 && (pct === text.length - 1 || text.slice(pct + 1).includes('%'))) return null
  const s = pct < 0 ? text : text.slice(0, pct)
  if (s === '') return null
  const parts = s.split(':')
  if (parts.length < 3) return null
  const last = parts.at(-1) ?? ''
  if (last.includes('.')) {
    const v4 = parseIpv4(last)
    if (v4 === null) return null
    parts.pop()
    parts.push(hexDigits(Math.floor(v4 / 65536), 1), hexDigits(v4 % 65536, 1))
  }
  if (parts.length > 9) return null
  let skip = -1
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] === '') {
      if (skip >= 0) return null
      skip = i
    }
  }
  let hi: number
  let lo: number
  let skipped: number
  if (skip >= 0) {
    hi = skip
    lo = parts.length - skip - 1
    if (parts[0] === '') {
      hi -= 1
      if (hi !== 0) return null
    }
    if (parts.at(-1) === '') {
      lo -= 1
      if (lo !== 0) return null
    }
    skipped = 8 - (hi + lo)
    if (skipped < 1) return null
  } else {
    if (parts.length !== 8 || parts[0] === '' || parts.at(-1) === '') return null
    hi = parts.length
    lo = 0
    skipped = 0
  }
  const out: number[] = []
  for (let i = 0; i < hi; i++) {
    const h = hextet(parts[i] ?? '')
    if (h === null) return null
    out.push(h)
  }
  for (let i = 0; i < skipped; i++) out.push(0)
  for (let i = parts.length - lo; i < parts.length; i++) {
    const h = hextet(parts[i] ?? '')
    if (h === null) return null
    out.push(h)
  }
  return out
}

interface Net4 {
  readonly base: number
  readonly bits: number
}

interface Net6 {
  readonly groups: readonly number[]
  readonly bits: number
}

const BLOCKED_V4: readonly Net4[] = [
  { base: 0, bits: 8 }, // 0.0.0.0/8
  { base: 127 * 16777216, bits: 8 }, // 127.0.0.0/8
  { base: 10 * 16777216, bits: 8 }, // 10.0.0.0/8
  { base: 172 * 16777216 + 16 * 65536, bits: 12 }, // 172.16.0.0/12
  { base: 192 * 16777216 + 168 * 65536, bits: 16 }, // 192.168.0.0/16
  { base: 169 * 16777216 + 254 * 65536, bits: 16 }, // 169.254.0.0/16
  { base: 100 * 16777216 + 64 * 65536, bits: 10 }, // 100.64.0.0/10 (CGNAT, tailnet)
  { base: 224 * 16777216, bits: 4 }, // 224.0.0.0/4 (multicast)
  { base: 240 * 16777216, bits: 4 }, // 240.0.0.0/4
]

const BLOCKED_V6: readonly Net6[] = [
  { groups: [0, 0, 0, 0, 0, 0, 0, 1], bits: 128 }, // ::1/128
  { groups: [0, 0, 0, 0, 0, 0, 0, 0], bits: 128 }, // ::/128
  { groups: [0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0], bits: 48 }, // fd7a:115c:a1e0::/48 (tailnet)
  { groups: [0xfc00, 0, 0, 0, 0, 0, 0, 0], bits: 7 }, // fc00::/7
  { groups: [0xfe80, 0, 0, 0, 0, 0, 0, 0], bits: 10 }, // fe80::/10
  { groups: [0xff00, 0, 0, 0, 0, 0, 0, 0], bits: 8 }, // ff00::/8 (multicast)
  { groups: [0x64, 0xff9b, 1, 0, 0, 0, 0, 0], bits: 48 }, // 64:ff9b:1::/48 (NAT64 local use)
  { groups: [0, 0, 0, 0, 0xffff, 0, 0, 0], bits: 96 }, // ::ffff:0:0:0/96 (IPv4-translated)
  { groups: [0xfec0, 0, 0, 0, 0, 0, 0, 0], bits: 10 }, // fec0::/10 (old site-local)
]

function inNet4(ip: number, net: Net4): boolean {
  const size = 2 ** (32 - net.bits)
  return Math.floor(ip / size) === Math.floor(net.base / size)
}

function inNet6(ip: readonly number[], net: Net6): boolean {
  const full = Math.floor(net.bits / 16)
  for (let i = 0; i < full; i++) {
    if (ip[i] !== net.groups[i]) return false
  }
  const rest = net.bits % 16
  if (rest === 0) return true
  const size = 2 ** (16 - rest)
  return Math.floor((ip[full] ?? 0) / size) === Math.floor((net.groups[full] ?? 0) / size)
}

function blocked4(ip: number): boolean {
  return BLOCKED_V4.some((n) => inNet4(ip, n))
}

function group(g: readonly number[], i: number): number {
  return g[i] ?? 0
}

function zerosBefore(g: readonly number[], n: number): boolean {
  return g.slice(0, n).every((x) => x === 0)
}

/** The IPv4 address an IPv6 one stands for, as v1 converted them before checking: IPv4-mapped (`::ffff:a.b.c.d`),
 *  IPv4-compatible and `::`/`::1` (below 2^32), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`); else null. */
export function embeddedIpv4(g: readonly number[]): number | null {
  if (zerosBefore(g, 5) && group(g, 5) === 0xffff) return group(g, 6) * 65536 + group(g, 7)
  if (zerosBefore(g, 6)) return group(g, 6) * 65536 + group(g, 7)
  if (group(g, 0) === 0x64 && group(g, 1) === 0xff9b && group(g, 2) === 0 && group(g, 3) === 0 && group(g, 4) === 0 && group(g, 5) === 0) {
    return group(g, 6) * 65536 + group(g, 7)
  }
  if (group(g, 0) === 0x2002) return group(g, 1) * 65536 + group(g, 2)
  return null
}

/** v1 `address_blocked`: loopback, private, link-local, CGNAT and tailnet, ULA, multicast and reserved addresses, in
 *  any IPv4-in-IPv6 form; anything that doesn't parse is blocked too. A zone (`%en0`) is ignored. */
export function addressBlocked(addr: string): boolean {
  const pct = addr.indexOf('%')
  const s = pct < 0 ? addr : addr.slice(0, pct)
  const v4 = parseIpv4(s)
  if (v4 !== null) return blocked4(v4)
  const v6 = parseIpv6(s)
  if (v6 === null) return true
  const inner = embeddedIpv4(v6)
  if (inner !== null) return blocked4(inner)
  return BLOCKED_V6.some((n) => inNet6(v6, n))
}

/** v1 `fetch_allowed`: `MIDSTUDY_FETCH_ALLOW=<host>:<port>` (evals only) exempts exactly that URL host and port. */
export function fetchAllowed(allow: string, host: string, port: number): boolean {
  const colon = allow.lastIndexOf(':')
  if (colon < 0) return false
  const aport = allow.slice(colon + 1)
  if (!/^[0-9]+$/.test(aport) || parseInt(aport, 10) !== port) return false
  const ahost = allow.slice(0, colon).replace(/^[[\]]+/, '').replace(/[[\]]+$/, '')
  return ahost.toLowerCase() === host.toLowerCase()
}
