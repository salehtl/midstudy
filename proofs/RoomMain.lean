import Midstudy.RoomModel

/-!
`lake exe roommodel CORPUS`: the executable model of contract §4.9's maps (`Midstudy.RoomFloat`, the same expressions
`Midstudy/Room.lean` proves things about, over `Float`), for comparing with the TypeScript on the same inputs
(`proofs/diff/room/`). Every number is the 16 hex digits of an IEEE double's bits, so nothing is lost in printing.
Each CORPUS line is `id<TAB>op<TAB>a,b,c,...`; each output line is `id<TAB>op<TAB>r1,r2,...`:

* `s2r` `x,y,z,x_m,z_m,yaw_deg` → `sceneToRoom`'s three numbers;
* `r2s` `x,y,z,x_m,z_m,yaw_deg` → `roomToScene`'s three numbers;
* `rts` `room_deg,yaw_deg` → `rotationToScene`;
* `rtr` `scene_deg,yaw_deg` → `rotationToRoom`.
-/

open Midstudy

def hexDigit (c : Char) : Option UInt64 :=
  if '0' ≤ c ∧ c ≤ '9' then some (c.toNat - '0'.toNat).toUInt64
  else if 'a' ≤ c ∧ c ≤ 'f' then some (c.toNat - 'a'.toNat + 10).toUInt64
  else none

def parseBits (s : String) : Option Float :=
  if s.length != 16 then none
  else s.foldl (fun acc c => acc.bind fun a => (hexDigit c).map fun d => a * 16 + d) (some 0) |>.map Float.ofBits

def showBits (f : Float) : String :=
  let b := f.toBits
  String.ofList <| (List.range 16).reverse.map fun i =>
    let d := ((b >>> (4 * i).toUInt64) &&& 15).toNat
    if d < 10 then Char.ofNat ('0'.toNat + d) else Char.ofNat ('a'.toNat + d - 10)

def triple (r : Float × Float × Float) : List Float := [r.1, r.2.1, r.2.2]

def run (op : String) (xs : List Float) : Option (List Float) :=
  match op, xs with
  | "s2r", [x, y, z, px, pz, yaw] => some (triple (RoomFloat.sceneToRoom x y z px pz yaw))
  | "r2s", [x, y, z, px, pz, yaw] => some (triple (RoomFloat.roomToScene x y z px pz yaw))
  | "rts", [d, yaw] => some [RoomFloat.rotationToScene d yaw]
  | "rtr", [d, yaw] => some [RoomFloat.rotationToRoom d yaw]
  | _, _ => none

def main (args : List String) : IO UInt32 := do
  let [corpus] := args | IO.eprintln "usage: roommodel CORPUS"; return 2
  let out ← IO.getStdout
  for line in (← IO.FS.lines corpus) do
    if line.isEmpty then continue
    match line.splitOn "\t" with
    | [id, op, nums] =>
      match (nums.splitOn ",").mapM parseBits >>= run op with
      | some rs => out.putStrLn s!"{id}\t{op}\t{",".intercalate (rs.map showBits)}"
      | none => IO.eprintln s!"bad line: {line}"; return 1
    | _ => IO.eprintln s!"bad line: {line}"; return 1
  return 0
