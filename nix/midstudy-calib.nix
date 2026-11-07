# midstudy-calib (calib/, contract §4.3): photo ingest, the MoGe-2 floor fit, the lighting fit and keep-room alignment
# as one executable. The server (server/src/main.ts) runs it for scene calibration and lighting through its warm worker
# (`midstudy-calib serve`, MoGe-2 loaded once; `run`, `fit` and `light` one-shot when the worker fails) and for
# keep-room renders (`align`, always one-shot).
#
# x86_64-linux (homeserver): torch-bin, PyTorch's CUDA 12.8 wheels; libcuda comes from the host driver
# (/run/opengl-driver/lib on NixOS). aarch64-darwin: torch-bin's macOS wheel (MPS), so the packaging can be built and
# run on the Mac where it was written.
#
# torch-bin and the CUDA libraries are unfree, so this imports its own nixpkgs instance that allows them: the flake's
# other packages and the host's nixpkgs config are unchanged. The instance is configured exactly as nook's
# nix/nook-gsplat.nix (allowUnfree, cudaCapabilities, the NVSHMEM overlay). On the same nixpkgs revision (flake.lock
# pins nook's), torch-bin is then the very store path nook already built on homeserver, so nothing CUDA is built twice.
# cudaCapabilities limits every CUDA build in that instance to the target GPU: 7.5 is homeserver's RTX 2060.
#
# The Python is nixpkgs' python3 (3.13), the one nook's torch-bin is built for. calib/pyproject.toml asks uv for
# 3.12; the code runs on 3.13 too (built and run on the Mac, docs/notes/packaging.md).
#
# Weights: by default the MoGe-2 ViT-L snapshot from nix/moge-weights.nix, a read-only Hugging Face cache in the
# store, with HF_HUB_OFFLINE=1. Both are wrapper defaults: a service that sets HF_HUB_CACHE and HF_HUB_OFFLINE=0
# gets a writable cache instead (docs/HANDOFF.md). `withWeights = false` leaves Hugging Face's own defaults.
{
  nixpkgs,
  system,
  cudaCapabilities ? [ "7.5" ],
  withWeights ? true,
}:
let
  pkgs = import nixpkgs {
    inherit system;
    config = {
      allowUnfree = true;
      inherit cudaCapabilities;
    };
    overlays = [
      (final: prev: {
        # Keep in step with nook's nix/nook-gsplat.nix: torch-bin links NVSHMEM, which nixpkgs builds from source
        # along with ~600 test and example programs that take hours of ptxas; only the library is needed.
        cudaPackages = prev.cudaPackages.overrideScope (
          cfinal: cprev: {
            libnvshmem = cprev.libnvshmem.overrideAttrs (old: {
              cmakeFlags = map (
                builtins.replaceStrings
                  [ "NVSHMEM_BUILD_TESTS:BOOL=TRUE" "NVSHMEM_BUILD_EXAMPLES:BOOL=TRUE" ]
                  [ "NVSHMEM_BUILD_TESTS:BOOL=FALSE" "NVSHMEM_BUILD_EXAMPLES:BOOL=FALSE" ]
              ) old.cmakeFlags;
            });
          }
        );
      })
    ];
  };
  inherit (pkgs) lib;
  ps = pkgs.python3Packages;
  utils3d = ps.callPackage ./utils3d.nix { };
  moge = ps.callPackage ./moge.nix { inherit utils3d; };
  weights = pkgs.callPackage ./moge-weights.nix { };
  # align-room's MASt3R (the `rooms` extra): its code and weights, and the Hugging Face cache the wrapper points at,
  # with MoGe-2's and MASt3R's snapshots side by side.
  mast3r = pkgs.callPackage ./mast3r.nix { };
  hfCache = pkgs.symlinkJoin {
    name = "midstudy-calib-hf-cache";
    paths = [
      weights
      mast3r.weights
    ];
  };
  py = pkgs.python3.withPackages (ps: [
    # the rooms extra (calib/pyproject.toml): what MASt3R imports beyond calib's own dependencies
    # roma's torch is nixpkgs' source build: give it torch-bin, so the env has one torch
    (ps.roma.override { torch = ps.torch-bin; })
    ps.einops
    # dust3r's image loading (torchvision.transforms); the wheel that matches torch-bin
    ps.torchvision-bin
    ps.safetensors
    ps.tqdm
    moge
    utils3d
    ps.torch-bin
    ps.numpy
    ps.pillow
    ps.pillow-heif
    ps.opencv-python-headless
    ps.huggingface-hub
    ps.scipy
    # v2 calib checks every file and result line against the contract's schemas at run time (validate.py, which the
    # CLI imports at start: without it even --help fails)
    ps.jsonschema
  ]);
  # Every module the CLI imports lazily (ingest, fit, the lighting fit, the MoGe runner, align, the worker) plus what
  # they load, so a missing dependency fails the build instead of the first calibration.
  imports = lib.concatStringsSep ", " [
    "midstudy_calib.cli"
    "midstudy_calib.ingest"
    "midstudy_calib.fit"
    "midstudy_calib.floor"
    "midstudy_calib.lighting"
    "midstudy_calib.moge_runner"
    "midstudy_calib.align"
    "midstudy_calib.worker"
    "midstudy_calib.validate"
    "midstudy_calib.contract_types"
    "midstudy_calib.records"
    "midstudy_calib.util"
    # align-room (contract §4.9): the command, Manhattan (numpy, scipy) and MASt3R (its own imports: mast3rCheck)
    "midstudy_calib.rooms.command"
    "midstudy_calib.rooms.photos"
    "midstudy_calib.rooms.geometry"
    "midstudy_calib.rooms.solver"
    "midstudy_calib.rooms.score"
    "midstudy_calib.rooms.manhattan"
    "midstudy_calib.rooms.mock"
    "midstudy_calib.rooms.mast3r"
    "scipy.spatial"
    "moge.model.v2"
    "torch"
    "cv2"
    "pillow_heif"
    "numpy"
    "PIL.ImageCms"
    "jsonschema"
  ];
  # validate.py reads the three schemas in src/midstudy_calib/schemas/ (copies of contract/'s, and calib-cli.schema.json)
  # through importlib.resources when it first checks something: an empty calib.json must fail its schema, which loads
  # them all. Without them every command would end in a contract error.
  schemaCheck = ''
    from midstudy_calib.validate import problems
    assert problems("calib", {}), "calib.schema.json accepted {}"
    assert not problems("request", {"id": "1", "cmd": "ingest", "args": ["a.jpg", "--out", "b"]}), "calib-cli.schema.json"
  '';
  # MASt3R's code is on sys.path only once loaded (rooms/mast3r.py _import), so its modules are checked from there.
  mast3rCheck = ''
    import importlib, os
    from midstudy_calib.rooms import mast3r
    assert mast3r.installed(), "the rooms extra"
    root = mast3r.ensure_code()
    assert str(root) == os.environ["MIDSTUDY_MAST3R_DIR"], root
    mast3r._import(root)
    for m in ("mast3r.model", "mast3r.cloud_opt.sparse_ga", "dust3r.image_pairs", "dust3r.utils.image"):
        importlib.import_module(m)
    assert mast3r.ensure_weights().joinpath("model.safetensors").is_file()
  '';
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "midstudy-calib";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../calib;
    fileset = lib.fileset.unions [
      ../calib/src
      ../calib/pyproject.toml
    ];
  };

  nativeBuildInputs = [ pkgs.makeWrapper ];
  dontBuild = true;

  # -P: never put the working directory on sys.path. The CLI's main() returns the exit code.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/midstudy-calib $out/bin
    cp -r src pyproject.toml $out/share/midstudy-calib/
    makeWrapper ${py}/bin/python3 $out/bin/midstudy-calib \
      --add-flags "-P -c 'import sys; from midstudy_calib.cli import main; sys.exit(main())'" \
      --set PYTHONPATH $out/share/midstudy-calib/src \
      --set-default MIDSTUDY_MAST3R_DIR ${mast3r.code} \
      ${lib.optionalString withWeights "--set-default HF_HUB_CACHE ${hfCache} --set-default HF_HUB_OFFLINE 1"} \
      ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux "--prefix LD_LIBRARY_PATH : ${pkgs.addDriverRunpath.driverLink}/lib"}
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    $out/bin/midstudy-calib --help >/dev/null
    $out/bin/midstudy-calib serve --help >/dev/null
    PYTHONPATH=$out/share/midstudy-calib/src ${py}/bin/python3 -P -c 'import ${imports}'
    PYTHONPATH=$out/share/midstudy-calib/src ${py}/bin/python3 -P -c ${lib.escapeShellArg schemaCheck}
    ${lib.optionalString withWeights ''
      MIDSTUDY_MAST3R_DIR=${mast3r.code} HF_HUB_CACHE=${hfCache} HF_HUB_OFFLINE=1 HOME=$TMPDIR \
        PYTHONPATH=$out/share/midstudy-calib/src ${py}/bin/python3 -P -c ${lib.escapeShellArg mast3rCheck}
    ''}
    runHook postInstallCheck
  '';

  passthru = {
    inherit
      moge
      utils3d
      weights
      mast3r
      hfCache
      py
      ;
    torch = ps.torch-bin;
  };

  meta = {
    description = "midstudy-calib: room photo ingest, MoGe-2 floor-plane camera fit and keep-room alignment";
    mainProgram = "midstudy-calib";
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
}
