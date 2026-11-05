// Slugs and paths (contract: ids are ^[a-z0-9][a-z0-9-]{0,63}$; serve.py: no dotfiles, scene assets).
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isSlug(s: string): boolean {
  return SLUG.test(s)
}

export function isSlugLiteral(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(s)
}

export function isSlugByHand(s: string): boolean {
  if (s.length === 0 || s.length > 64) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (i > 0 && c === 45)
    if (!ok) return false
  }
  return true
}

export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function hiddenPath(p: string): boolean {
  return p.split('/').some((part) => part.startsWith('.'))
}

export function hiddenPathLoop(p: string): boolean {
  for (const part of p.split('/')) if (part.startsWith('.')) return true
  return false
}

export interface SceneAsset {
  readonly scene: string
  readonly file: 'photo.jpg' | 'depth.png' | 'thumb.jpg'
}

export function sceneAsset(p: string): SceneAsset | null {
  const parts = p.split('/')
  if (parts.length !== 2) return null
  const scene = parts[0]
  const file = parts[1]
  if (scene === undefined || file === undefined || !isSlugByHand(scene)) return null
  if (file === 'photo.jpg' || file === 'depth.png' || file === 'thumb.jpg') return { scene, file }
  return null
}
