// Angles (v1: engine.js wrapDeg, lighting.js wrapAz; contract §4.1 projection).
export function wrapDeg(d: number): number {
  let x = ((((d + 180) % 360) + 360) % 360) - 180
  if (x === -180) x = 180
  return x
}

export function wrapDegConst(d: number): number {
  const x = ((((d + 180) % 360) + 360) % 360) - 180
  return x === -180 ? 180 : x
}

export function degToRad(d: number): number {
  return (d * Math.PI) / 180
}

export function degToRadLiteral(d: number): number {
  return d * 0.017453292519943295
}

export function horizonFraction(pitchDeg: number, fovDeg: number): number {
  return 0.5 - Math.tan(degToRadLiteral(pitchDeg)) / (2 * Math.tan(degToRadLiteral(fovDeg) / 2))
}

export function atan2Deg(y: number, x: number): number {
  return Math.atan2(y, x) * 57.29577951308232
}
