// Objects: spreads, optional fields, `as const` tuples, default parameters.
export interface Look {
  readonly exposure: number
  readonly warmth: number
  readonly ambient?: number
}

export function withExposure(l: Look, e: number): Look {
  return { ...l, exposure: e }
}

export function ambientOr(l: Look): number {
  return l.ambient ?? 1
}

export const MODES = ['place', 'adjust', 'render'] as const
export type Mode = (typeof MODES)[number]

export function nextMode(m: Mode): Mode {
  switch (m) {
    case 'place':
      return 'adjust'
    case 'adjust':
      return 'render'
    case 'render':
      return 'place'
  }
}

export function twice(n = 3): number {
  return n * 2
}
