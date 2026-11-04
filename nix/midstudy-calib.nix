# midstudy-calib (calib/, contract §4.3): photo ingest, the MoGe-2 floor fit and keep-room alignment as one
# executable. planner/serve.py runs it for scene calibration (`run`, `fit`) and keep-room renders (`align`).
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
  py = pkgs.python3.withPackages (ps: [
    moge
    utils3d
    ps.torch-bin
    ps.numpy
    ps.pillow
    ps.pillow-heif
    ps.opencv-python-headless
    ps.huggingface-hub
    ps.scipy
  ]);
  # Every module the CLI imports lazily (ingest, fit, the MoGe runner, align) plus what they load, so a missing
  # dependency fails the build instead of the first calibration.
  imports = "midstudy_calib.cli, midstudy_calib.ingest, midstudy_calib.fit, midstudy_calib.floor, midstudy_calib.moge_runner, midstudy_calib.align, moge.model.v2, torch, cv2, pillow_heif, numpy, PIL.ImageCms";
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
      ${lib.optionalString withWeights "--set-default HF_HUB_CACHE ${weights} --set-default HF_HUB_OFFLINE 1"} \
      ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux "--prefix LD_LIBRARY_PATH : ${pkgs.addDriverRunpath.driverLink}/lib"}
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    $out/bin/midstudy-calib --help >/dev/null
    PYTHONPATH=$out/share/midstudy-calib/src ${py}/bin/python3 -P -c 'import ${imports}'
    runHook postInstallCheck
  '';

  passthru = {
    inherit
      moge
      utils3d
      weights
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
