"""Differential test of midstudy-imaging against v1's own code (Pillow 13 + libjpeg-turbo 3 + numpy, through
pipeline/src/midstudy_pipeline): decode, encode, the engine input, the thumbnail, the rug texture and SAM 3D's mask.

Run from the repository root (v1's environment, so the comparison is with exactly what v1 runs):
  (cd core && cargo build --release --example difftool -p midstudy-imaging)
  uv run --project pipeline python core/crates/imaging/tests/diff_pillow.py [--seed 1] [--out evals/out/imaging-diff]

Prints one line per area and a summary; exits 1 on any unexpected difference. Bytes must be identical for everything
JPEG; PNG outputs (the alpha engine input, the mask) are compared by pixels (Pillow compresses with zlib-ng).
"""
import argparse
import io
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from midstudy_pipeline import cli, rug

REPO = Path(__file__).resolve().parents[4]
TOOL = REPO / "core/target/release/examples/difftool"


def photo(rng, w, h, mode="RGB"):
    """A photo-like picture: smooth gradients, blobs, a little noise."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    out = np.zeros((h, w, 3))
    for c in range(3):
        f = rng.uniform(0.01, 0.08, 4)
        out[..., c] = 128 + 60 * np.sin(x * f[0] + y * f[1] + c) + 40 * np.cos(x * f[2] - y * f[3])
    for _ in range(6):
        cx, cy, r = rng.uniform(0, w), rng.uniform(0, h), rng.uniform(2, max(3, min(w, h) / 3))
        out[(x - cx) ** 2 + (y - cy) ** 2 < r * r] = rng.uniform(0, 255, 3)
    out += rng.normal(0, 6, out.shape)
    im = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")
    return im.convert(mode) if mode != "RGB" else im


def jpeg(im, **kw):
    buf = io.BytesIO()
    im.save(buf, "JPEG", **kw)
    return buf.getvalue()


def exif_orientation(o):
    ex = Image.Exif()
    ex[0x0112] = o
    return ex.tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default=str(REPO / "evals/out/imaging-diff"))
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    out = Path(a.out)
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)

    cases = []  # (name, bytes)
    cases.append(("fixture-chair.jpg", (REPO / "fixtures/fal/sam-3-3d-objects/input.jpg").read_bytes()))
    # (360, 480) and (300, 502): portrait thumbnails, which Pillow 13 resamples vertical pass first
    sizes = [(1, 1), (7, 5), (17, 9), (16, 16), (33, 17), (100, 75), (349, 401), (640, 480), (360, 480), (300, 502)]
    if not a.quick:
        sizes += [(1001, 777), (13, 250)]
    k = 0
    for (w, h) in sizes:
        im = photo(rng, w, h)
        for q in (50, 75, 92):
            for sub in (0, 1, 2):
                cases.append((f"j{k}-{w}x{h}-q{q}-s{sub}.jpg", jpeg(im, quality=q, subsampling=sub)))
                k += 1
        cases.append((f"j{k}-{w}x{h}-prog.jpg", jpeg(im, quality=85, progressive=True)))
        k += 1
        cases.append((f"j{k}-{w}x{h}-prog444.jpg", jpeg(im, quality=95, progressive=True, subsampling=0)))
        k += 1
        cases.append((f"j{k}-{w}x{h}-opt.jpg", jpeg(im, quality=80, optimize=True)))
        k += 1
        cases.append((f"j{k}-{w}x{h}-rst.jpg", jpeg(im, quality=80, restart_marker_blocks=3)))
        k += 1
        cases.append((f"j{k}-{w}x{h}-grey.jpg", jpeg(im.convert("L"), quality=88)))
        k += 1
        cases.append((f"j{k}-{w}x{h}-cmyk.jpg", jpeg(im.convert("CMYK"), quality=90)))
        k += 1
    base = photo(rng, 120, 80)
    for o in range(1, 9):
        cases.append((f"o{o}.jpg", jpeg(base, quality=90, exif=exif_orientation(o))))
    icc = bytes(rng.integers(0, 256, 3000, dtype=np.uint8))
    cases.append(("icc.jpg", jpeg(base, quality=90, icc_profile=icc)))
    big_icc = bytes(rng.integers(0, 256, 70000, dtype=np.uint8))
    cases.append(("icc-big.jpg", jpeg(base, quality=90, icc_profile=big_icc)))
    for mode in ("RGB", "RGBA", "L", "LA", "P", "1"):
        im = photo(rng, 61, 43, "RGB")
        if mode == "RGBA" or mode == "LA":
            im = im.convert(mode)
            arr = np.array(im)
            arr[..., -1] = rng.integers(0, 256, arr.shape[:2])
            im = Image.fromarray(arr, mode)
        elif mode == "P":
            im = im.convert("P", palette=Image.Palette.ADAPTIVE, colors=40)
        else:
            im = im.convert(mode)
        buf = io.BytesIO()
        im.save(buf, "PNG")
        cases.append((f"p-{mode}.png", buf.getvalue()))
    im = photo(rng, 50, 30).convert("P", palette=Image.Palette.ADAPTIVE, colors=16)
    buf = io.BytesIO()
    im.save(buf, "PNG", transparency=bytes([0, 128, 255] + [255] * 13))
    cases.append(("p-P-trns.png", buf.getvalue()))
    arr16 = (np.array(photo(rng, 40, 30)).astype(np.uint16) * 257)
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(arr16[..., 0])).convert("I;16").save(buf, "PNG")
    cases.append(("p-I16.png", buf.getvalue()))
    for lossless in (False, True):
        buf = io.BytesIO()
        photo(rng, 77, 51).save(buf, "WEBP", lossless=lossless, quality=80)
        cases.append((f"w-{'ll' if lossless else 'lossy'}.webp", buf.getvalue()))
    wide = photo(rng, 4200, 60)
    cases.append(("wide-4200.jpg", jpeg(wide, quality=90)))
    tall = photo(rng, 500, 4400)  # its engine input shrinks vertical pass first
    cases.append(("tall-4400.jpg", jpeg(tall, quality=90)))
    # rug pictures (E8's and E17's)
    for name, size, rect, stripes in (("rug-e8", (800, 800), [250, 150, 549, 649], "h"), ("rug-e17", (800, 800), [150, 250, 649, 549], "v")):
        from PIL import ImageDraw
        im = Image.new("RGB", size, (255, 255, 255))
        d = ImageDraw.Draw(im)
        d.rectangle(rect, fill=(150, 90, 40) if stripes == "h" else (40, 70, 150))
        if stripes == "h":
            for yy in range(170, 640, 40):
                d.rectangle([270, yy, 529, yy + 15], fill=(230, 220, 200))
        else:
            for xx in range(170, 640, 40):
                d.rectangle([xx, 270, xx + 15, 529], fill=(230, 220, 200))
        buf = io.BytesIO()
        im.save(buf, quality=92, format="JPEG")
        cases.append((f"{name}.jpg", buf.getvalue()))
    cases.append(("rug-photo.jpg", jpeg(photo(rng, 300, 200), quality=90)))
    cases.append(("rug-big.jpg", jpeg(photo(rng, 2600, 1300), quality=85)))

    for name, data in cases:
        (out / name).write_bytes(data)
    jobs = []
    for name, _ in cases:
        p = out / name
        jobs.append(f"decode\t{p}\t{p}.dec")
        jobs.append(f"engine\t{p}\t{p}.engine")
        if name.startswith(("rug", "o", "fixture", "icc")) or not a.quick:
            jobs.append(f"thumb\t{p}.engine\t{p}.thumb")
        if name.startswith("rug"):
            jobs.append(f"rug\t{p}.engine\t160\t230\t{p}.rug160")
            jobs.append(f"rug\t{p}.engine\t230\t160\t{p}.rug230")
            jobs.append(f"mask\t{p}.engine\t{p}.mask")
        if name.startswith(("fixture", "j5")):
            jobs.append(f"mask\t{p}.engine\t{p}.mask")
    # encode: raw RGB of a few photos at several qualities
    for (w, h) in [(1, 1), (9, 7), (16, 16), (17, 33), (349, 401)]:
        raw = photo(rng, w, h).tobytes()
        (out / f"raw-{w}x{h}.rgb").write_bytes(raw)
        for q in (1, 30, 75, 88, 90, 92, 100):
            jobs.append(f"encode\t{out}/raw-{w}x{h}.rgb\t{w}\t{h}\t{q}\t{out}/raw-{w}x{h}-q{q}.jpg")
    # the engine inputs are made first (thumbs, rugs and masks read them): two passes
    first = [j for j in jobs if j.startswith(("decode", "engine", "encode"))]
    second = [j for j in jobs if not j.startswith(("decode", "engine", "encode"))]
    for part, lst in (("1", first), ("2", second)):
        (out / f"jobs{part}.txt").write_text("\n".join(lst) + "\n")
        r = subprocess.run([str(TOOL), str(out / f"jobs{part}.txt")], capture_output=True, text=True)
        if r.returncode != 0 or "0 failed" not in r.stdout:
            print(r.stdout[-3000:], r.stderr[-2000:])

    fails = {}

    def fail(area, msg):
        fails.setdefault(area, []).append(msg)

    counts = {}

    def count(area):
        counts[area] = counts.get(area, 0) + 1

    for name, data in cases:
        p = out / name
        # decode
        count("decode")
        with Image.open(p) as im:
            im.load()
            want = (im.size, im.mode, im.tobytes())
        dec = (out / f"{name}.dec")
        if not dec.exists():
            fail("decode", f"{name}: no output")
        else:
            raw = dec.read_bytes()
            head, _, px = raw.partition(b"\n")
            w, h, mode = head.decode().split()
            got_mode = mode
            if want[1] == "P" and got_mode == "P":
                with Image.open(p) as im:
                    ok_px = px == im.tobytes()
            elif want[1] in ("RGB", "RGBA", "L", "LA", "CMYK", "1", "I;16") and got_mode == want[1]:
                with Image.open(p) as im:
                    im.load()
                    if want[1] == "1":
                        ok_px = px == np.array(im, dtype=np.uint8).astype(np.uint8).tobytes().replace(b"\x01", b"\xff")
                    elif want[1] == "I;16":
                        ok_px = px == np.array(im, dtype="<u2").tobytes()
                    else:
                        ok_px = px == np.array(im).tobytes()
            else:
                ok_px = False
            if (int(w), int(h)) != want[0] or got_mode != want[1] or not ok_px:
                if got_mode == want[1] and (int(w), int(h)) == want[0]:
                    with Image.open(p) as im:
                        im.load()
                        ref = np.array(im).astype(int).ravel()
                    mine = np.frombuffer(px, dtype=np.uint8).astype(int)
                    if len(mine) == len(ref):
                        d = np.abs(mine - ref)
                        fail("decode", f"{name}: pixels differ (max {d.max()}, {np.count_nonzero(d)} of {d.size})")
                    else:
                        fail("decode", f"{name}: length {len(mine)} vs {len(ref)}")
                else:
                    fail("decode", f"{name}: {w}x{h} {got_mode} vs {want[0]} {want[1]}")
        # engine input: v1's own function
        count("engine")
        ref_dir = out / f"{name}.v1"
        ref_dir.mkdir(exist_ok=True)
        ref = cli.engine_input(p, ref_dir)
        mine = out / f"{name}.engine"
        if not mine.exists():
            fail("engine", f"{name}: no output")
        elif ref.suffix == ".png":
            with Image.open(ref) as r, Image.open(mine) as m:
                if r.size != m.size or r.mode != m.mode or r.tobytes() != m.tobytes() or r.info.get("icc_profile") != m.info.get("icc_profile"):
                    fail("engine", f"{name}: PNG pixels or ICC differ ({r.size} {r.mode} vs {m.size} {m.mode})")
        elif ref.read_bytes() != mine.read_bytes():
            with Image.open(ref) as r, Image.open(mine) as m:
                fail("engine", f"{name}: bytes differ ({len(ref.read_bytes())} vs {len(mine.read_bytes())}; {r.size} vs {m.size}; "
                     f"pixels max diff {np.abs(np.array(r).astype(int) - np.array(m).astype(int)).max() if r.size == m.size else 'n/a'})")
        # thumbnail of the engine input, as v1 makes it
        if (out / f"{name}.thumb").exists():
            count("thumb")
            tref = out / f"{name}.v1/thumb.jpg"
            cli.make_thumb(ref, tref)
            if tref.read_bytes() != (out / f"{name}.thumb").read_bytes():
                with Image.open(tref) as r, Image.open(out / f"{name}.thumb") as m:
                    fail("thumb", f"{name}: bytes differ; pixels max diff {np.abs(np.array(r).astype(int) - np.array(m).astype(int)).max()}")
        for wd in ((160, 230), (230, 160)):
            mine = out / f"{name}.rug{wd[0]}"
            if not mine.exists():
                continue
            count("rug")
            tex, notes = rug.prepare(ref, *wd)
            buf = io.BytesIO()
            tex.save(buf, "JPEG", quality=90)
            meta = json.loads((out / f"{name}.rug{wd[0]}.json").read_text())
            edge = [round(float(v), 4) for v in meta["edge"]]
            if buf.getvalue() != mine.read_bytes():
                fail("rug", f"{name} {wd}: texture bytes differ ({tex.size})")
            if edge + [1.0] != rug.edge_colour(tex):
                fail("rug", f"{name} {wd}: edge colour {edge} vs {rug.edge_colour(tex)}")
            crop_note = [n for n in notes if n.startswith("cropped")]
            if bool(crop_note) != (meta["crop"] is not None):
                fail("rug", f"{name} {wd}: crop {meta['crop']} vs {notes}")
            if any(n.startswith("turned") for n in notes) != meta["turned"]:
                fail("rug", f"{name} {wd}: turned {meta['turned']} vs {notes}")
        mine = out / f"{name}.mask"
        if mine.exists():
            count("mask")
            mref = out / f"{name}.v1/mask.png"
            how = rug.foreground_mask(ref, mref)
            meta = json.loads((out / f"{name}.mask.json").read_text())
            want_kind = "no-margin" if "no plain margin" in how else "no-piece" if "no piece" in how else "piece"
            with Image.open(mref) as r, Image.open(mine) as m:
                if r.tobytes() != m.tobytes() or r.size != m.size:
                    fail("mask", f"{name}: mask pixels differ")
            if want_kind != meta["kind"] or (want_kind == "piece" and f"{meta['share']:.0%}" not in how):
                fail("mask", f"{name}: {meta} vs {how}")
    for (w, h) in [(1, 1), (9, 7), (16, 16), (17, 33), (349, 401)]:
        raw = (out / f"raw-{w}x{h}.rgb").read_bytes()
        for q in (1, 30, 75, 88, 90, 92, 100):
            count("encode")
            want = jpeg(Image.frombytes("RGB", (w, h), raw), quality=q)
            got = (out / f"raw-{w}x{h}-q{q}.jpg").read_bytes()
            if want != got:
                first = next((i for i, (x, y) in enumerate(zip(want, got)) if x != y), min(len(want), len(got)))
                fail("encode", f"{w}x{h} q{q}: bytes differ at {first} ({len(want)} vs {len(got)})")
    bad = 0
    for area in ("decode", "encode", "engine", "thumb", "rug", "mask"):
        f = fails.get(area, [])
        bad += len(f)
        print(f"{'ok  ' if not f else 'FAIL'} {area}: {counts.get(area, 0) - len(f)}/{counts.get(area, 0)} identical")
        for m in f[:12]:
            print(f"       {m}")
    print(f"diff_pillow: {sum(counts.values()) - bad}/{sum(counts.values())} identical (seed {a.seed})")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
