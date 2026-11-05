// Prices (contract §2.6 renders, §2.8/§3.2 library adds): what a render or an add will cost, as v1 shows it before
// asking (engine.js RENDER_MODELS and renderPrice; data.js LIB_PRICE, estimateCost). Pure, for TScert.

export const RENDER_MODEL_NAMES = ['nano-banana', 'kontext', 'qwen'] as const
export type RenderModel = (typeof RENDER_MODEL_NAMES)[number]

/** The render models, the default first (Nano Banana takes the scene photo as a reference). */
export function isRenderModel(m: string): m is RenderModel {
  return m === 'nano-banana' || m === 'kontext' || m === 'qwen'
}

export function renderLabel(m: RenderModel): string {
  switch (m) {
    case 'nano-banana':
      return 'Nano Banana edit'
    case 'kontext':
      return 'FLUX.1 Kontext [pro]'
    case 'qwen':
      return 'Qwen Image Edit'
  }
}

/** A render's price in USD for an input of `megapixels` (qwen is priced by size; v1: 1 MP without a capture). */
export function renderModelPrice(m: RenderModel, megapixels: number): number {
  switch (m) {
    case 'nano-banana':
      return 0.0398
    case 'kontext':
      return 0.04
    case 'qwen':
      return 0.03 * megapixels
  }
}

/** The megapixels a capture of width × height sends (v1's renderPrice). */
export function megapixels(width: number, height: number): number {
  return (width * height) / 1e6
}

/** The image engines and what an add costs on each (contract §3.2); a model upload (glb) is free. */
export const IMAGE_ENGINES = ['idol', 'sam3d', 'trellis2', 'rug'] as const
export const DEFAULT_IMAGE_ENGINE = 'idol'

/** TRELLIS 2's price by resolution (512 by default and for any other value). */
export function trellisPrice(resolution: number): number {
  if (resolution === 1024) return 0.3
  if (resolution === 1536) return 0.35
  return 0.25
}

/** v1's estimateCost(meta, kind): $0 for a model file; else the engine's price (idol by default), TRELLIS 2 by
 * resolution (`resolution` is Number(meta.resolution), 0 when absent or not a number), 0 for an unknown engine. */
export function estimateCost(engine: string, resolution: number, kind: string): number {
  if (kind === 'model') return 0
  switch (engine || DEFAULT_IMAGE_ENGINE) {
    case 'glb':
    case 'rug':
      return 0
    case 'idol':
      return 0.1
    case 'sam3d':
      return 0.02
    case 'trellis2':
      return trellisPrice(resolution || 512)
    default:
      return 0
  }
}

/** File names that are 3D models (v1's MODEL_EXT): uploaded as kind "model". */
export function isModelName(name: string): boolean {
  return /\.(glb|zip|gltf|usdz|obj|fbx)$/i.test(name)
}
