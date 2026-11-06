import Midstudy.Depth
import Midstudy.Item
import Midstudy.Clamp
import Midstudy.RoomModel

/-!
# Rooms: several photos, one frame (contract §4.9, docs/ROOMS.md §3.1), over ℝ

A room member's **pose** `{x_m, z_m, yaw_deg}` maps its scene frame (contract §4.1: camera at x = z = 0, yaw 0,
floor y = 0) into the room frame:

```
p_room  = Ry(yaw) · p_scene + (x_m, 0, z_m)
p_scene = Ry(−yaw) · (p_room − (x_m, 0, z_m))
item rotation_y_deg:  scene = wrapDeg(room − yaw),  room = wrapDeg(scene + yaw);  elevation unchanged
```

`Ry` is `Rotation.lean`'s (the item rotation's), angles in degrees through `rad` as everywhere else. The member's
**effective camera** is its scene camera with `height_m × scale`, clamped to 0.2–3.0.

Main results:
* `Pose.roomToScene_sceneToRoom`, `Pose.sceneToRoom_roomToScene`: the two maps are inverse both ways (`Pose.toEquiv`);
  both keep the height (`sceneToRoom_y`), so floor points stay on the floor, and distances (`sceneToRoom_dot_sub`).
* `roomToScene_sceneToRoom_other`: a point in photo A's frame lands in photo B's frame at
  `Ry(yaw_A − yaw_B) · q + Ry(−yaw_B) · (t_A − t_B)` (the relative pose).
* `roomProject_eq`, `roomR_eq`: drawing a room point in a photo by taking it into the photo's scene frame and
  projecting with §4.1 is exactly §4.9's three.js camera at `(x_m, height_m, z_m)` with
  `rotation.set(pitch, yaw, roll, 'YXZ')`.
* `placed_in_A_drawn_in_B` (and `placed_in_A_drawn_in_B_effective` with the effective cameras): a point placed from a
  pixel of photo A is on the room's floor, comes back to that pixel in A, and is drawn in photo B where §4.1 says,
  through the two poses.
* `rotationToRoom_rotationToScene`, `rotationToScene_rotationToRoom`, `roomToScene_item`, `sceneToRoom_item`,
  `sceneToRoom_x_toward_neg_z`: an item's rotation goes `scene = room − yaw` and back exactly (in (−180, 180]);
  carrying an item's every point with the pose is the same as carrying its position and setting its rotation to
  `room − yaw`, so the pose's yaw has the sign of `rotation_y_deg` (positive turns +X toward −Z).
* `effective_photoToFloor`, `effective_floorToPhoto`, `effective_depth`, `effective_occlusion`, `photoToFloor_y`:
  the effective camera finds `k` times the floor points (still on the floor), draws `k · p` at `p`'s pixel with `k`
  times its depth, `k = effective height / height` (= `scale` when `height_m × scale` is within range).
* `wrapYaw_eq_wrapDeg`, `wrapYaw_mem`, `clampPose_inRange`, `clampPose_idem`, `sceneToRoom_clampPose`: §4.9's pose
  clamp `((yaw + 180) mod 360) − 180` (floored mod, −180 written as 180) is engine.js `wrapDeg`, lands in
  (−180, 180], and moves no point when `x_m`, `z_m` are in range. `wrapYawJs_neg_270`: read with JavaScript's `%`
  instead of a floored mod, the formula would leave −270 at −270.
* `applyAnswer_sceneToRoom`, `applyAnswer_rebase`, `rebase_applyAnswer`: §4.9 Align's rule for putting an answer's
  pose into the room frame is the composition of the anchor's map with the answer's, and the align mock's
  re-expression relative to the first argument is its inverse.
* `sceneToRoomG_real`, `roomToSceneG_real`, `rotationG_real`, `rotationG_neg_real`: the generic formulas of
  `RoomModel.lean`, which `lake exe roommodel` runs over `Float` for the differential test, are these maps over ℝ.
-/

noncomputable section

open Real Matrix Set

namespace Midstudy

/-- A member's pose (contract §4.9, the generated `Pose` type): where its photo was taken, in the room frame. -/
@[ext] structure Pose where
  x_m : ℝ
  z_m : ℝ
  yaw_deg : ℝ

theorem rad_neg (d : ℝ) : rad (-d) = -rad d := by unfold rad; ring

theorem rad_sub (a b : ℝ) : rad (a - b) = rad a - rad b := by unfold rad; ring

theorem rad_add (a b : ℝ) : rad (a + b) = rad a + rad b := by unfold rad; ring

/-- `Ry`'s transpose is the opposite turn. -/
theorem Ry_transpose (t : ℝ) : (Ry t)ᵀ = Ry (-t) := by
  ext i j
  fin_cases i <;> fin_cases j <;> simp [Ry]

theorem Ry_mul_neg (t : ℝ) : Ry t * Ry (-t) = 1 := by
  rw [Ry_add, add_neg_cancel, Ry_zero]

/-- `Ry` keeps lengths. -/
theorem Ry_mulVec_dot (t : ℝ) (v : Vec3) : (Ry t *ᵥ v) ⬝ᵥ (Ry t *ᵥ v) = v ⬝ᵥ v := by
  simp [dotProduct, Fin.sum_univ_three]
  linear_combination (v 0 * v 0 + v 2 * v 2) * sin_sq_add_cos_sq t

namespace Pose

variable (P : Pose)

/-- The pose's position on the floor, `(x_m, 0, z_m)`. -/
def offset : Vec3 := ![P.x_m, 0, P.z_m]

/-- `p_room = Ry(yaw) · p_scene + (x_m, 0, z_m)`. -/
def sceneToRoom (p : Vec3) : Vec3 := Ry (rad P.yaw_deg) *ᵥ p + P.offset

/-- `p_scene = Ry(−yaw) · (p_room − (x_m, 0, z_m))`. -/
def roomToScene (p : Vec3) : Vec3 := Ry (rad (-P.yaw_deg)) *ᵥ (p - P.offset)

@[simp] theorem offset_zero : P.offset 0 = P.x_m := rfl
@[simp] theorem offset_one : P.offset 1 = 0 := rfl
@[simp] theorem offset_two : P.offset 2 = P.z_m := rfl

/-! ### Inverse both ways -/

/-- **Scene → room → scene is the identity.** -/
theorem roomToScene_sceneToRoom (p : Vec3) : P.roomToScene (P.sceneToRoom p) = p := by
  rw [roomToScene, sceneToRoom, add_sub_cancel_right, mulVec_mulVec, rad_neg, Ry_add, neg_add_cancel, Ry_zero,
    one_mulVec]

/-- **Room → scene → room is the identity.** -/
theorem sceneToRoom_roomToScene (p : Vec3) : P.sceneToRoom (P.roomToScene p) = p := by
  rw [sceneToRoom, roomToScene, mulVec_mulVec, rad_neg, Ry_mul_neg, one_mulVec, sub_add_cancel]

/-- The pose as a bijection of space, scene frame to room frame. -/
def toEquiv : Vec3 ≃ Vec3 :=
  ⟨P.sceneToRoom, P.roomToScene, P.roomToScene_sceneToRoom, P.sceneToRoom_roomToScene⟩

theorem roomToScene_eq_iff {p q : Vec3} : P.roomToScene p = q ↔ p = P.sceneToRoom q := by
  constructor
  · rintro rfl
    rw [sceneToRoom_roomToScene]
  · rintro rfl
    rw [roomToScene_sceneToRoom]

theorem sceneToRoom_injective : Function.Injective P.sceneToRoom := P.toEquiv.injective

theorem roomToScene_injective : Function.Injective P.roomToScene := P.toEquiv.symm.injective

/-! ### Heights, the floor and distances -/

/-- **The height is the same in both frames** (an item's elevation, `position[1]`, is unchanged). -/
@[simp] theorem sceneToRoom_y (p : Vec3) : P.sceneToRoom p 1 = p 1 := by
  simp [sceneToRoom]

@[simp] theorem roomToScene_y (p : Vec3) : P.roomToScene p 1 = p 1 := by
  simp [roomToScene]

/-- Floor points stay on the floor, both ways, and nothing else lands on it. -/
theorem sceneToRoom_on_floor_iff (p : Vec3) : P.sceneToRoom p 1 = 0 ↔ p 1 = 0 := by simp

theorem roomToScene_on_floor_iff (p : Vec3) : P.roomToScene p 1 = 0 ↔ p 1 = 0 := by simp

theorem sceneToRoom_sub (p q : Vec3) : P.sceneToRoom p - P.sceneToRoom q = Ry (rad P.yaw_deg) *ᵥ (p - q) := by
  rw [sceneToRoom, sceneToRoom, add_sub_add_right_eq_sub, mulVec_sub]

/-- **A pose moves things rigidly**: squared distances are the same in both frames. -/
theorem sceneToRoom_dot_sub (p q : Vec3) :
    (P.sceneToRoom p - P.sceneToRoom q) ⬝ᵥ (P.sceneToRoom p - P.sceneToRoom q) = (p - q) ⬝ᵥ (p - q) := by
  rw [sceneToRoom_sub, Ry_mulVec_dot]

/-- The first member's pose `{0, 0, 0}` (`pose_source: origin`) makes the room frame its scene frame. -/
theorem origin_sceneToRoom (p : Vec3) : (⟨0, 0, 0⟩ : Pose).sceneToRoom p = p := by
  ext i
  fin_cases i <;> simp [sceneToRoom, offset, rad]

theorem origin_roomToScene (p : Vec3) : (⟨0, 0, 0⟩ : Pose).roomToScene p = p := by
  rw [roomToScene_eq_iff, origin_sceneToRoom]

/-- The photo's camera `(0, h, 0)` stands at `(x_m, h, z_m)` in the room. -/
theorem sceneToRoom_camera (h : ℝ) : P.sceneToRoom ![0, h, 0] = ![P.x_m, h, P.z_m] := by
  ext i
  fin_cases i <;> simp [sceneToRoom]

/-- The scene's −Z (yaw 0's view direction) is `(−sin yaw, 0, −cos yaw)` in the room. -/
theorem Ry_neg_z : Ry (rad P.yaw_deg) *ᵥ ![0, 0, -1] = ![-sin (rad P.yaw_deg), 0, -cos (rad P.yaw_deg)] := by
  ext i
  fin_cases i <;> simp

end Pose

/-! ### Composition: from photo A to photo B -/

/-- **The relative pose**: a point of photo A's scene frame, put in the room by A's pose and taken out by B's, is
`Ry(yaw_A − yaw_B) · q + Ry(−yaw_B) · (t_A − t_B)` in photo B's scene frame. -/
theorem roomToScene_sceneToRoom_other (A B : Pose) (q : Vec3) :
    B.roomToScene (A.sceneToRoom q) =
      Ry (rad (A.yaw_deg - B.yaw_deg)) *ᵥ q + Ry (rad (-B.yaw_deg)) *ᵥ (A.offset - B.offset) := by
  rw [Pose.roomToScene, Pose.sceneToRoom, add_sub_assoc, mulVec_add, mulVec_mulVec, Ry_add]
  have : rad (-B.yaw_deg) + rad A.yaw_deg = rad (A.yaw_deg - B.yaw_deg) := by unfold rad; ring
  rw [this]

/-- The camera-to-room rotation of a member photo: §4.9's three.js camera, `rotation.set(pitch, yaw, roll, 'YXZ')`,
i.e. `Ry(yaw) · Rx(pitch) · Rz(roll)`. -/
def roomR (c : CameraBlock) (P : Pose) : Mat3 := Ry (rad P.yaw_deg) * Rx (rad c.pitch_deg) * Rz (rad c.roll_deg)

/-- That camera's position in the room, `(x_m, height_m, z_m)`. -/
def roomCenter (c : CameraBlock) (P : Pose) : Vec3 := ![P.x_m, c.height_m, P.z_m]

/-- A room point's camera coordinates for that camera. -/
def roomToCamera (c : CameraBlock) (P : Pose) (p : Vec3) : Vec3 := (roomR c P)ᵀ *ᵥ (p - roomCenter c P)

/-- `[px, py, d]` of a room point seen by the member's camera placed in the room (§4.1's formulas with §4.9's
camera). -/
def roomProject (c : CameraBlock) (ph : Photo) (P : Pose) (p : Vec3) : ℝ × ℝ × ℝ :=
  (ph.w / 2 + c.focalPx ph * roomToCamera c P p 0 / -roomToCamera c P p 2,
   ph.h / 2 - c.focalPx ph * roomToCamera c P p 1 / -roomToCamera c P p 2,
   -roomToCamera c P p 2)

/-- The room camera is the scene camera turned by the pose's yaw. -/
theorem roomR_eq (c : CameraBlock) (P : Pose) : roomR c P = Ry (rad P.yaw_deg) * c.R := by
  simp [roomR, CameraBlock.R, camR, mul_assoc]

/-- It is a rotation. -/
theorem roomR_mem_SO3 (c : CameraBlock) (P : Pose) : roomR c P ∈ specialOrthogonalGroup (Fin 3) ℝ := by
  rw [roomR_eq]
  exact Submonoid.mul_mem _ (Ry_mem_SO3 _) (c.R_mem_SO3)

/-- Its position is the scene camera's, carried by the pose. -/
theorem roomCenter_eq (c : CameraBlock) (P : Pose) : roomCenter c P = P.sceneToRoom c.center := by
  rw [roomCenter, CameraBlock.center, Pose.sceneToRoom_camera]

theorem roomCenter_sub (c : CameraBlock) (P : Pose) (p : Vec3) :
    Ry (rad (-P.yaw_deg)) *ᵥ (p - roomCenter c P) = P.roomToScene p - c.center := by
  have hc : roomCenter c P = P.offset + c.center := by
    ext i
    fin_cases i <;> simp [roomCenter, Pose.offset, CameraBlock.center]
  have hr : Ry (rad (-P.yaw_deg)) *ᵥ c.center = c.center := by
    ext i
    fin_cases i <;> simp [CameraBlock.center]
  rw [hc, ← sub_sub, mulVec_sub, hr, Pose.roomToScene]

/-- **The room camera sees a room point as the scene camera sees it in the photo's scene frame.** -/
theorem roomToCamera_eq (c : CameraBlock) (P : Pose) (p : Vec3) :
    roomToCamera c P p = c.toCamera (P.roomToScene p) := by
  rw [roomToCamera, roomR_eq, transpose_mul, ← mulVec_mulVec, Ry_transpose, ← rad_neg, roomCenter_sub,
    CameraBlock.toCamera]

/-- **Drawing a room point in a photo** (take it into the photo's scene frame, project with §4.1) is the same as
projecting it with §4.9's camera at `(x_m, height_m, z_m)` turned by `Ry(yaw) · Rx(pitch) · Rz(roll)`. -/
theorem roomProject_eq (c : CameraBlock) (ph : Photo) (P : Pose) (p : Vec3) :
    roomProject c ph P p = c.projectPhoto ph (P.roomToScene p) := by
  simp only [roomProject, roomToCamera_eq, CameraBlock.projectPhoto, CameraBlock.depth]

/-- **A point placed from photo A is drawn in photo B where §4.1 says.** Take a pixel of photo A below its horizon
(for a camera above the floor with a non-degenerate focal length). It has a floor point `q` in A's scene frame
(`photoToFloor`, §4.1 Inverse); placed in the room by A's pose it is `r = sceneToRoom_A q`, and

* `r` is on the room's floor;
* drawn back in photo A (through A's pose) it is at the pixel it was placed from, in front of A's camera;
* in photo B's scene frame it is at `Ry(yaw_A − yaw_B) · q + Ry(−yaw_B) · (t_A − t_B)`, on B's floor;
* B draws it (§4.1 in B's scene frame) exactly where §4.9's room camera of B projects it. -/
theorem placed_in_A_drawn_in_B {cA cB : CameraBlock} {phA phB : Photo} (A B : Pose) (hh : 0 < cA.height_m)
    (hf : cA.focalPx phA ≠ 0) {px py : ℝ} (hbelow : cA.photoRay phA px py 1 < 0) :
    ∃ q, cA.photoToFloor phA px py = some q ∧
      A.sceneToRoom q 1 = 0 ∧
      cA.floorToPhoto phA (A.roomToScene (A.sceneToRoom q)) = (px, py) ∧
      0 < cA.depth (A.roomToScene (A.sceneToRoom q)) ∧
      B.roomToScene (A.sceneToRoom q) =
        Ry (rad (A.yaw_deg - B.yaw_deg)) *ᵥ q + Ry (rad (-B.yaw_deg)) *ᵥ (A.offset - B.offset) ∧
      B.roomToScene (A.sceneToRoom q) 1 = 0 ∧
      cB.projectPhoto phB (B.roomToScene (A.sceneToRoom q)) = roomProject cB phB B (A.sceneToRoom q) := by
  obtain ⟨q, hq, hq1, hd, hpx⟩ := cA.floorToPhoto_photoToFloor hh hf hbelow
  refine ⟨q, hq, by simp [hq1], ?_, ?_, roomToScene_sceneToRoom_other A B q, by simp [hq1], ?_⟩
  · rw [Pose.roomToScene_sceneToRoom, hpx]
  · rw [Pose.roomToScene_sceneToRoom]; exact hd
  · rw [roomProject_eq]

/-! ### Item rotation: `scene = room − yaw` -/

/-- An item's `rotation_y_deg` in a photo's scene frame from the room frame: `wrapDeg(room − yaw)`. -/
def rotationToScene (roomDeg : ℝ) (P : Pose) : ℝ := wrapDeg (roomDeg - P.yaw_deg)

/-- An item's `rotation_y_deg` in the room frame from a photo's scene frame: `wrapDeg(scene + yaw)`. -/
def rotationToRoom (sceneDeg : ℝ) (P : Pose) : ℝ := wrapDeg (sceneDeg + P.yaw_deg)

theorem rotationToScene_mem (d : ℝ) (P : Pose) : rotationToScene d P ∈ Ioc (-180) 180 := wrapDeg_mem _

theorem rotationToRoom_mem (d : ℝ) (P : Pose) : rotationToRoom d P ∈ Ioc (-180) 180 := wrapDeg_mem _

/-- **Room → scene → room** gives back the angle (as `wrapDeg` keeps it). -/
theorem rotationToRoom_rotationToScene (d : ℝ) (P : Pose) :
    rotationToRoom (rotationToScene d P) P = wrapDeg d := by
  rw [rotationToRoom, rotationToScene, wrapDeg_wrapDeg_add, sub_add_cancel]

/-- **Scene → room → scene** gives back the angle. -/
theorem rotationToScene_rotationToRoom (d : ℝ) (P : Pose) :
    rotationToScene (rotationToRoom d P) P = wrapDeg d := by
  rw [rotationToRoom, rotationToScene, sub_eq_add_neg, wrapDeg_wrapDeg_add, add_neg_cancel_right]

/-- For a stored angle (in (−180, 180], as every writer keeps it) both round trips are exact. -/
theorem rotationToRoom_rotationToScene_of_mem {d : ℝ} (h : d ∈ Ioc (-180) 180) (P : Pose) :
    rotationToRoom (rotationToScene d P) P = d := by
  rw [rotationToRoom_rotationToScene, wrapDeg_of_mem h]

theorem rotationToScene_rotationToRoom_of_mem {d : ℝ} (h : d ∈ Ioc (-180) 180) (P : Pose) :
    rotationToScene (rotationToRoom d P) P = d := by
  rw [rotationToScene_rotationToRoom, wrapDeg_of_mem h]

/-- **`scene = room − yaw` is the rotation that agrees with the pose.** An item at room position `pos` turned by
`θ` (`rotation_y_deg` in the room) has its local point `v` at `Ry(θ) · v + pos`; taken into a photo's scene frame,
that is the item at `roomToScene pos` turned by `rotationToScene θ`. -/
theorem roomToScene_item (P : Pose) (θ : ℝ) (pos v : Vec3) :
    P.roomToScene (Ry (rad θ) *ᵥ v + pos) = Ry (rad (rotationToScene θ P)) *ᵥ v + P.roomToScene pos := by
  simp only [Pose.roomToScene, rotationToScene, Ry_rad_wrapDeg]
  rw [add_sub_assoc, mulVec_add, mulVec_mulVec, Ry_add]
  have : rad (-P.yaw_deg) + rad θ = rad (θ - P.yaw_deg) := by unfold rad; ring
  rw [this]

/-- The same from the scene frame into the room. -/
theorem sceneToRoom_item (P : Pose) (θ : ℝ) (pos v : Vec3) :
    P.sceneToRoom (Ry (rad θ) *ᵥ v + pos) = Ry (rad (rotationToRoom θ P)) *ᵥ v + P.sceneToRoom pos := by
  simp only [Pose.sceneToRoom, rotationToRoom, Ry_rad_wrapDeg]
  rw [mulVec_add, mulVec_mulVec, Ry_add, rad_add, add_comm (rad P.yaw_deg), add_assoc]

/-- **The pose's yaw has the sign of `rotation_y_deg`**: for a yaw strictly between 0 and 180 the scene's +X points
toward the room's −Z (counterclockwise seen from above, `Ry_ccw_from_above`). -/
theorem sceneToRoom_x_toward_neg_z (P : Pose) (h0 : 0 < P.yaw_deg) (h1 : P.yaw_deg < 180) :
    (P.sceneToRoom ![1, 0, 0] - P.sceneToRoom 0) 2 < 0 := by
  rw [Pose.sceneToRoom_sub, sub_zero]
  apply Ry_x_toward_neg_z
  · unfold rad; positivity
  · unfold rad
    have := pi_pos
    nlinarith

/-- A yaw of 90 takes the scene's +X exactly to the room's −Z (as `--yaw 90` does for an item). -/
theorem sceneToRoom_quarter (x z : ℝ) :
    (⟨x, z, 90⟩ : Pose).sceneToRoom ![1, 0, 0] - (⟨x, z, 90⟩ : Pose).sceneToRoom 0 = ![0, 0, -1] := by
  rw [Pose.sceneToRoom_sub, sub_zero, show rad 90 = π / 2 by unfold rad; ring, Ry_quarter_x]

/-! ### The effective camera: `height_m × scale`, clamped -/

/-- A member's effective camera: its scene camera with `height_m × scale`, clamped to 0.2–3.0 (§4.9 Scale). -/
def effectiveCamera (c : CameraBlock) (s : ℝ) : CameraBlock := c.withHeight (clamp 0.2 3 (c.height_m * s))

/-- The factor the effective camera actually scales the scene by: the effective height over the scene's. -/
def effectiveScale (c : CameraBlock) (s : ℝ) : ℝ := clamp 0.2 3 (c.height_m * s) / c.height_m

theorem effectiveCamera_eq (c : CameraBlock) (s : ℝ) (hh : 0 < c.height_m) :
    effectiveCamera c s = c.withHeight (effectiveScale c s * c.height_m) := by
  rw [effectiveCamera, effectiveScale, div_mul_cancel₀ _ hh.ne']

/-- Within the range, the factor is the member's `scale`. -/
theorem effectiveScale_of_mem (c : CameraBlock) {s : ℝ} (hh : 0 < c.height_m)
    (hs : c.height_m * s ∈ Icc 0.2 3) : effectiveScale c s = s := by
  rw [effectiveScale, clamp_of_mem hs]
  field_simp

theorem effectiveScale_pos (c : CameraBlock) (s : ℝ) (hh : 0 < c.height_m) : 0 < effectiveScale c s := by
  have := (clamp_mem (show (0.2 : ℝ) ≤ 3 by norm_num) (c.height_m * s)).1
  exact div_pos (by linarith) hh

/-- The effective camera is within §4.1's ranges whenever the scene's camera is. -/
theorem effectiveCamera_inRange {c : CameraBlock} (h : c.InRange) (s : ℝ) : (effectiveCamera c s).InRange :=
  { fov := h.fov, pitch := h.pitch, roll := h.roll,
    height := clamp_mem (show (0.2 : ℝ) ≤ 3 by norm_num) (c.height_m * s) }

/-- Every floor point a camera finds is on the floor. -/
theorem photoToFloor_y {c : CameraBlock} {ph : Photo} {px py : ℝ} {q : Vec3} (h : c.photoToFloor ph px py = some q) :
    q 1 = 0 := by
  unfold CameraBlock.photoToFloor floorHit at h
  split_ifs at h
  cases h
  simp

/-- **The effective camera finds `k` times the floor points** (`k = effectiveScale`), so the member's scene frame
is the scene's scaled by `k` about the floor point under the camera, and its floor points stay on the floor. -/
theorem effective_photoToFloor (c : CameraBlock) (ph : Photo) (s px py : ℝ) (hh : 0 < c.height_m) :
    (effectiveCamera c s).photoToFloor ph px py = (c.photoToFloor ph px py).map (effectiveScale c s • ·) := by
  rw [effectiveCamera_eq c s hh, CameraBlock.photoToFloor_withHeight]

/-- **Projections scale as the contract says**: `k · p` is drawn by the effective camera at `p`'s pixel... -/
theorem effective_floorToPhoto (c : CameraBlock) (ph : Photo) (s : ℝ) (hh : 0 < c.height_m) (p : Vec3) :
    (effectiveCamera c s).floorToPhoto ph (effectiveScale c s • p) = c.floorToPhoto ph p := by
  rw [effectiveCamera_eq c s hh, CameraBlock.floorToPhoto_withHeight_smul _ _ (effectiveScale_pos c s hh).ne']

/-- ... at `k` times its depth. -/
theorem effective_depth (c : CameraBlock) (s : ℝ) (hh : 0 < c.height_m) (p : Vec3) :
    (effectiveCamera c s).depth (effectiveScale c s • p) = effectiveScale c s * c.depth p := by
  rw [effectiveCamera_eq c s hh, CameraBlock.depth_withHeight_smul]

/-- **Occlusion follows the effective camera with no new rule**: §4.5's `depth × height_m / calib height_m`, with
the effective `height_m`, is the depth the effective camera sees at every pixel. -/
theorem effective_occlusion (c : CameraBlock) (ph : Photo) (s : ℝ) (hh : 0 < c.height_m) (q : Vec3) :
    (effectiveCamera c s).floorToPhoto ph (((effectiveCamera c s).height_m / c.height_m) • q) =
        c.floorToPhoto ph q ∧
      (effectiveCamera c s).depth (((effectiveCamera c s).height_m / c.height_m) • q) =
        (effectiveCamera c s).height_m / c.height_m * c.depth q := by
  have h1 : 0 < (effectiveCamera c s).height_m := by
    have := (clamp_mem (show (0.2 : ℝ) ≤ 3 by norm_num) (c.height_m * s)).1
    simp only [effectiveCamera, CameraBlock.withHeight_height]
    linarith
  exact c.occlusion_rescale ph hh _ h1 q

/-- A scaled floor point is on the floor, and only a floor point scales onto it. -/
theorem smul_on_floor_iff {k : ℝ} (hk : k ≠ 0) (p : Vec3) : (k • p) 1 = 0 ↔ p 1 = 0 := by
  simp [hk]

/-- **The whole chain with the effective cameras**: photo A (scale `sA`) places a pixel's floor point in the room;
photo B (scale `sB`) draws it where its effective room camera says, and it is on both floors. -/
theorem placed_in_A_drawn_in_B_effective {cA cB : CameraBlock} {phA phB : Photo} (A B : Pose) (sA sB : ℝ)
    (hh : 0 < cA.height_m) (hf : cA.focalPx phA ≠ 0) {px py : ℝ} (hbelow : cA.photoRay phA px py 1 < 0) :
    ∃ q, (effectiveCamera cA sA).photoToFloor phA px py = some (effectiveScale cA sA • q) ∧
      cA.photoToFloor phA px py = some q ∧
      A.sceneToRoom (effectiveScale cA sA • q) 1 = 0 ∧
      (effectiveCamera cA sA).floorToPhoto phA (A.roomToScene (A.sceneToRoom (effectiveScale cA sA • q))) =
        (px, py) ∧
      B.roomToScene (A.sceneToRoom (effectiveScale cA sA • q)) 1 = 0 ∧
      (effectiveCamera cB sB).projectPhoto phB (B.roomToScene (A.sceneToRoom (effectiveScale cA sA • q))) =
        roomProject (effectiveCamera cB sB) phB B (A.sceneToRoom (effectiveScale cA sA • q)) := by
  obtain ⟨q, hq, hq1, -, hpx⟩ := cA.floorToPhoto_photoToFloor hh hf hbelow
  refine ⟨q, ?_, hq, by simp [hq1], ?_, by simp [hq1], by rw [roomProject_eq]⟩
  · rw [effective_photoToFloor _ _ _ _ _ hh, hq, Option.map_some]
  · rw [Pose.roomToScene_sceneToRoom, effective_floorToPhoto _ _ _ hh, hpx]

/-! ### Pose clamps -/

/-- The floored `a mod n` (the result has the sign of `n`), as §4.9 writes the yaw clamp. -/
def floorMod (a n : ℝ) : ℝ := a - n * ⌊a / n⌋

/-- §4.9: `y = ((yaw + 180) mod 360) − 180`, then −180 becomes 180. -/
def wrapYaw (yaw : ℝ) : ℝ :=
  if floorMod (yaw + 180) 360 - 180 = -180 then 180 else floorMod (yaw + 180) 360 - 180

theorem floorMod_eq_toIcoMod (a : ℝ) : floorMod a 360 = toIcoMod h360 0 a := by
  symm
  rw [toIcoMod_eq_iff]
  have h1 := Int.floor_le (a / 360)
  have h2 := Int.lt_floor_add_one (a / 360)
  have e : a = 360 * (a / 360) := by field_simp
  refine ⟨⟨?_, ?_⟩, ⌊a / 360⌋, ?_⟩
  · simp only [floorMod]; nlinarith
  · simp only [floorMod, zero_add]; nlinarith
  · simp only [floorMod, zsmul_eq_mul]; ring

/-- **§4.9's yaw clamp is engine.js `wrapDeg`.** -/
theorem wrapYaw_eq_wrapDeg (yaw : ℝ) : wrapYaw yaw = wrapDeg yaw := by
  rw [wrapYaw, wrapDeg, jsRem_jsRem_add, floorMod_eq_toIcoMod]

/-- It lands in (−180, 180]... -/
theorem wrapYaw_mem (yaw : ℝ) : wrapYaw yaw ∈ Ioc (-180) 180 := by
  rw [wrapYaw_eq_wrapDeg]; exact wrapDeg_mem yaw

/-- ... changes nothing there... -/
theorem wrapYaw_of_mem {yaw : ℝ} (h : yaw ∈ Ioc (-180) 180) : wrapYaw yaw = yaw := by
  rw [wrapYaw_eq_wrapDeg]; exact wrapDeg_of_mem h

/-- ... and never turns anything. -/
theorem Ry_rad_wrapYaw (yaw : ℝ) : Ry (rad (wrapYaw yaw)) = Ry (rad yaw) := by
  rw [wrapYaw_eq_wrapDeg, Ry_rad_wrapDeg]

theorem Ry_rad_neg_wrapYaw (yaw : ℝ) : Ry (rad (-wrapYaw yaw)) = Ry (rad (-yaw)) := by
  rw [rad_neg, rad_neg, ← Ry_transpose, ← Ry_transpose, Ry_rad_wrapYaw]

/-- The same formula read with JavaScript's `%` (truncated, the sign of the dividend) instead of a floored mod. -/
def wrapYawJs (yaw : ℝ) : ℝ :=
  if jsRem (yaw + 180) 360 - 180 = -180 then 180 else jsRem (yaw + 180) 360 - 180

/-- **Read with JavaScript's `%`, §4.9's formula is wrong below −180**: −270 stays −270 (it should be 90). A writer
in TypeScript needs engine.js's `((… % 360) + 360) % 360` (or `wrapDeg`). -/
theorem wrapYawJs_neg_270 : wrapYawJs (-270) = -270 ∧ wrapYaw (-270) = 90 := by
  have hj : jsRem (-270 + 180) 360 = -90 := by
    have : jsTrunc ((-270 + 180 : ℝ) / 360) = 0 := by
      unfold jsTrunc
      rw [if_neg (by norm_num), Int.ceil_eq_iff]
      norm_num
    rw [jsRem, this]
    norm_num
  have hf : floorMod (-270 + 180) 360 = 270 := by
    have : ⌊(-270 + 180 : ℝ) / 360⌋ = -1 := by
      rw [Int.floor_eq_iff]
      norm_num
    rw [floorMod, this]
    norm_num
  constructor
  · rw [wrapYawJs, hj]; norm_num
  · rw [wrapYaw, hf]; norm_num

/-- A pose within §4.9's ranges. -/
structure Pose.InRange (P : Pose) : Prop where
  x : P.x_m ∈ Icc (-50) 50
  z : P.z_m ∈ Icc (-50) 50
  yaw : P.yaw_deg ∈ Ioc (-180) 180

/-- What every writer does to a pose (§4.9 Ranges). -/
def clampPose (P : Pose) : Pose := ⟨clamp (-50) 50 P.x_m, clamp (-50) 50 P.z_m, wrapYaw P.yaw_deg⟩

/-- A member's `scale`, clamped to 0.25–4. -/
def clampScale (s : ℝ) : ℝ := clamp 0.25 4 s

theorem clampPose_inRange (P : Pose) : (clampPose P).InRange :=
  ⟨clamp_mem (by norm_num) _, clamp_mem (by norm_num) _, wrapYaw_mem _⟩

theorem clampPose_of_inRange {P : Pose} (h : P.InRange) : clampPose P = P := by
  ext
  · exact clamp_of_mem h.x
  · exact clamp_of_mem h.z
  · exact wrapYaw_of_mem h.yaw

theorem clampPose_idem (P : Pose) : clampPose (clampPose P) = clampPose P :=
  clampPose_of_inRange (clampPose_inRange P)

theorem clampScale_mem (s : ℝ) : clampScale s ∈ Icc 0.25 4 := clamp_mem (by norm_num) s

theorem clampScale_idem (s : ℝ) : clampScale (clampScale s) = clampScale s := clamp_idem (by norm_num) s

/-- **Clamping a pose whose position is in range moves no point**: bringing the yaw into (−180, 180] changes
neither map. -/
theorem sceneToRoom_clampPose {P : Pose} (hx : P.x_m ∈ Icc (-50) 50) (hz : P.z_m ∈ Icc (-50) 50) :
    (clampPose P).sceneToRoom = P.sceneToRoom := by
  funext p
  simp only [Pose.sceneToRoom, Pose.offset, clampPose, clamp_of_mem hx, clamp_of_mem hz, Ry_rad_wrapYaw]

theorem roomToScene_clampPose {P : Pose} (hx : P.x_m ∈ Icc (-50) 50) (hz : P.z_m ∈ Icc (-50) 50) :
    (clampPose P).roomToScene = P.roomToScene := by
  funext p
  simp only [Pose.roomToScene, Pose.offset, clampPose, clamp_of_mem hx, clamp_of_mem hz, Ry_rad_neg_wrapYaw]

/-- And an item's rotation in a scene frame is the same for the clamped pose. -/
theorem rotationToScene_clampPose (d : ℝ) (P : Pose) : rotationToScene d (clampPose P) = rotationToScene d P := by
  simp only [rotationToScene, clampPose, wrapYaw_eq_wrapDeg]
  obtain ⟨k, hk⟩ := wrapDeg_modEq P.yaw_deg
  rw [hk, show d - (P.yaw_deg + 360 * (k : ℝ)) = d - P.yaw_deg + 360 * ((-k : ℤ) : ℝ) by push_cast; ring,
    wrapDeg_add_int_mul]

/-! ### Align: an answer's poses into the room frame, and the mock's re-expression -/

/-- §4.9 Align: an answer's pose `P_k` (relative to the anchor) in the room frame, given the anchor's room pose `A`
and scale `s_a`: `yaw = yaw_a + yaw_k`, `(x, z) = (x_a, z_a) + s_a · Ry(yaw_a) · (x_k, z_k)` (before clamping). -/
def applyAnswer (A : Pose) (sa : ℝ) (Pk : Pose) : Pose :=
  ⟨A.x_m + sa * (Ry (rad A.yaw_deg) *ᵥ Pk.offset) 0, A.z_m + sa * (Ry (rad A.yaw_deg) *ᵥ Pk.offset) 2,
    A.yaw_deg + Pk.yaw_deg⟩

/-- **The apply rule is the composition**: member `k`'s point `q` (its own scene frame), scaled by `s_k` into the
answer's frame of reference and placed by `P_k`, then scaled by the anchor's `s_a` and placed by the anchor's room
pose, is where the applied pose puts `q` scaled by the applied scale `s_a · s_k`. -/
theorem applyAnswer_sceneToRoom (A Pk : Pose) (sa sk : ℝ) (q : Vec3) :
    (applyAnswer A sa Pk).sceneToRoom ((sa * sk) • q) = A.sceneToRoom (sa • Pk.sceneToRoom (sk • q)) := by
  ext i
  fin_cases i <;> simp [Pose.sceneToRoom, applyAnswer, Pose.offset, rad_add, cos_add, sin_add] <;> ring

/-- The align mock's re-expression relative to the first argument `A` (scale `s_a`):
`yaw' = yaw − yaw_a`, `(x', z') = Ry(−yaw_a) · ((x, z) − (x_a, z_a)) / s_a` (before wrapping the yaw). -/
def rebase (A : Pose) (sa : ℝ) (P : Pose) : Pose :=
  ⟨(Ry (rad (-A.yaw_deg)) *ᵥ (P.offset - A.offset)) 0 / sa, (Ry (rad (-A.yaw_deg)) *ᵥ (P.offset - A.offset)) 2 / sa,
    P.yaw_deg - A.yaw_deg⟩

/-- **Applying a re-expressed pose gives the pose back** (the mock and the server's apply are inverse). -/
theorem applyAnswer_rebase (A P : Pose) {sa : ℝ} (hs : sa ≠ 0) : applyAnswer A sa (rebase A sa P) = P := by
  ext
  · simp [applyAnswer, rebase, rad_neg, Pose.offset]
    field_simp
    linear_combination (P.x_m - A.x_m) * sin_sq_add_cos_sq (rad A.yaw_deg)
  · simp [applyAnswer, rebase, rad_neg, Pose.offset]
    field_simp
    linear_combination (P.z_m - A.z_m) * sin_sq_add_cos_sq (rad A.yaw_deg)
  · simp [applyAnswer, rebase]

theorem rebase_applyAnswer (A P : Pose) {sa : ℝ} (hs : sa ≠ 0) : rebase A sa (applyAnswer A sa P) = P := by
  ext
  · simp [applyAnswer, rebase, rad_neg, Pose.offset]
    field_simp
    linear_combination P.x_m * sin_sq_add_cos_sq (rad A.yaw_deg)
  · simp [applyAnswer, rebase, rad_neg, Pose.offset]
    field_simp
    linear_combination P.z_m * sin_sq_add_cos_sq (rad A.yaw_deg)
  · simp [applyAnswer, rebase]

/-! ### The executable model is these maps -/

/-- `RoomModel.lean`'s `sceneToRoomG` over ℝ is `Pose.sceneToRoom`. -/
theorem sceneToRoomG_real (P : Pose) (p : Vec3) :
    sceneToRoomG Real.cos Real.sin rad (p 0) (p 1) (p 2) P.x_m P.z_m P.yaw_deg =
      (P.sceneToRoom p 0, P.sceneToRoom p 1, P.sceneToRoom p 2) := by
  simp [sceneToRoomG, Pose.sceneToRoom]

/-- `RoomModel.lean`'s `roomToSceneG` over ℝ is `Pose.roomToScene`. -/
theorem roomToSceneG_real (P : Pose) (p : Vec3) :
    roomToSceneG Real.cos Real.sin rad (p 0) (p 1) (p 2) P.x_m P.z_m P.yaw_deg =
      (P.roomToScene p 0, P.roomToScene p 1, P.roomToScene p 2) := by
  simp [roomToSceneG, Pose.roomToScene, rad_neg]
  ring

/-- `rotationG wrapDeg room yaw` is `rotationToScene`... -/
theorem rotationG_real (d : ℝ) (P : Pose) : rotationG wrapDeg d P.yaw_deg = rotationToScene d P := rfl

/-- ... and with `−yaw`, `rotationToRoom`. -/
theorem rotationG_neg_real (d : ℝ) (P : Pose) : rotationG wrapDeg d (-P.yaw_deg) = rotationToRoom d P := by
  simp [rotationG, rotationToRoom, sub_neg_eq_add]

end Midstudy
