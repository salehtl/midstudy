// Discriminated unions (job states, contract §4.4).
export type Job =
  | { readonly kind: 'pending' }
  | { readonly kind: 'running'; readonly started: number }
  | { readonly kind: 'done'; readonly ok: boolean; readonly message: string }

export function label(j: Job): string {
  switch (j.kind) {
    case 'pending':
      return 'waiting'
    case 'running':
      return `running since ${j.started}`
    case 'done':
      return j.ok ? 'done' : `failed: ${j.message}`
  }
}

export function labelIf(j: Job): string {
  if (j.kind === 'pending') return 'waiting'
  if (j.kind === 'running') return 'running'
  return j.ok ? 'done' : 'failed'
}

export function assertNever(x: never): never {
  throw new Error(`unexpected value ${String(x)}`)
}

export function labelExhaustive(j: Job): string {
  switch (j.kind) {
    case 'pending':
      return 'a'
    case 'running':
      return 'b'
    case 'done':
      return 'c'
    default:
      return assertNever(j)
  }
}

export function isFinished(j: Job): j is { readonly kind: 'done'; readonly ok: boolean; readonly message: string } {
  return j.kind === 'done'
}
