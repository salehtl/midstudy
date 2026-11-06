/-!
# The room maps of contract §4.9, written once for any number type

`sceneToRoomG`, `roomToSceneG` and `rotationG` are the formulas of contract §4.9 (docs/ROOMS.md §3.1) spelled out
component by component, for any type with `+ − ×` and negation and given `cos`, `sin` and the degrees-to-radians
map. Two instances use them:

* over ℝ (`Midstudy/Room.lean`): `sceneToRoomG_real`, `roomToSceneG_real` and `rotationG_real` show they are exactly
  `Pose.sceneToRoom`, `Pose.roomToScene` and `rotationToScene`/`rotationToRoom`, the maps every theorem there is
  about;
* over `Float` (below, and `RoomMain.lean`): the executable model the differential test (`proofs/diff/room/`)
  compares with the TypeScript (`planner/logic/room.ts`) on random inputs.

So the program and the proved maps are the same expressions; only the number type differs. This file uses Lean's
core only (no Mathlib), so `lake exe roommodel` builds in seconds.
-/

namespace Midstudy

section Generic

variable {α : Type} [Add α] [Sub α] [Mul α] [Neg α]

/-- `p_room = Ry(yaw) · p_scene + (x_m, 0, z_m)`, by components (`t` the yaw in radians). -/
def sceneToRoomG (cos sin rad : α → α) (x y z px pz yaw : α) : α × α × α :=
  let t := rad yaw
  (cos t * x + sin t * z + px, y, -(sin t) * x + cos t * z + pz)

/-- `p_scene = Ry(−yaw) · (p_room − (x_m, 0, z_m))`, by components (`cos(−t) = cos t`, `sin(−t) = −sin t`). -/
def roomToSceneG (cos sin rad : α → α) (x y z px pz yaw : α) : α × α × α :=
  let t := rad yaw
  let dx := x - px
  let dz := z - pz
  (cos t * dx - sin t * dz, y, sin t * dx + cos t * dz)

/-- An item's `rotation_y_deg` from the room frame into a scene frame: `wrap(room − yaw)`; back with `−yaw`. -/
def rotationG (wrap : α → α) (deg yaw : α) : α := wrap (deg - yaw)

end Generic

/-! ### The `Float` instance: the executable model -/

namespace RoomFloat

/-- The planner's `DEG = Math.PI / 180` (`Math.PI` is the double nearest π). -/
def deg : Float := 3.141592653589793 / 180

def rad (d : Float) : Float := d * deg

/-- JavaScript's `a % n` (fmod: truncated quotient), the operation engine.js `wrapDeg` uses. Computed as C's
`fmod` is: exactly, by reducing with `n · 2^k` (each step exact for finite doubles). -/
partial def jsRem (a n : Float) : Float :=
  if a.isNaN || n.isNaN || a.isInf || n == 0 then 0.0 / 0.0
  else
    let s := if a < 0 then -1.0 else 1.0
    let n := n.abs
    let rec go (r : Float) : Float :=
      if r < n then r
      else
        -- the largest n · 2^k ≤ r
        let rec big (m : Float) : Float := if m * 2 ≤ r then big (m * 2) else m
        go (r - big n)
    s * go a.abs

/-- engine.js `wrapDeg` (Midstudy.wrapDeg over ℝ): `((d + 180) % 360 + 360) % 360 − 180`, −180 written as 180. -/
def wrapDeg (d : Float) : Float :=
  let w := jsRem (jsRem (d + 180) 360 + 360) 360 - 180
  if w == -180 then 180 else w

def sceneToRoom (x y z px pz yaw : Float) : Float × Float × Float :=
  sceneToRoomG Float.cos Float.sin rad x y z px pz yaw

def roomToScene (x y z px pz yaw : Float) : Float × Float × Float :=
  roomToSceneG Float.cos Float.sin rad x y z px pz yaw

/-- `rotationToScene(roomDeg, pose)`: `wrapDeg(room − yaw)`. -/
def rotationToScene (roomDeg yaw : Float) : Float := rotationG wrapDeg roomDeg yaw

/-- `rotationToRoom(sceneDeg, pose)`: `wrapDeg(scene + yaw)` = `wrapDeg(scene − (−yaw))`. -/
def rotationToRoom (sceneDeg yaw : Float) : Float := rotationG wrapDeg sceneDeg (-yaw)

end RoomFloat

end Midstudy
