# The official Lean 4.29.1 release, as a fixed-output fetch (proofs track; docs/notes/proofs.md).
#
# Why not nixpkgs' lean4: proofs/ uses Mathlib v4.29.1, whose lean-toolchain is leanprover/lean4:v4.29.1, and gets
# Mathlib's compiled .olean files with `lake exe cache get` instead of building Mathlib from source. Those files only
# load in a Lean whose githash is the release's own commit (f72c35b3…). nixpkgs' lean4 4.29.1 (the flake's pinned
# nixpkgs) is built from source with GIT_SHA1 set to the tag name, "v4.29.1", so Mathlib's cache doesn't load in it
# and Lake would rebuild all of Mathlib. This is that same Lean version, as released: on macOS nothing is changed (no
# strip, no fixup: the binaries are signed); on Linux the interpreter and RPATHs are patched (untested here: the Mac
# is the machine the proofs run on).
#
# Standalone:  nix build -f nix/lean.nix          (or: nix shell -f nix/lean.nix -c lean --version)
# From the flake: import ./nix/lean.nix { inherit pkgs; }   (or pkgs.callPackage ./nix/lean.nix { })
{
  pkgs ? (builtins.getFlake "github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c")
    .legacyPackages.${builtins.currentSystem},
  lib ? pkgs.lib,
  stdenv ? pkgs.stdenv,
  fetchurl ? pkgs.fetchurl,
  zstd ? pkgs.zstd,
  autoPatchelfHook ? pkgs.autoPatchelfHook,
  zlib ? pkgs.zlib,
}:

let
  version = "4.29.1";
  releases = {
    aarch64-darwin = {
      platform = "darwin_aarch64";
      hash = "sha256-c7zLOSyn2Ks9YqHjKLt9BXgV8Ijb2/tldPGUrlBXl68=";
    };
    x86_64-linux = {
      platform = "linux";
      hash = "sha256-vwYtKVVtZVaF+yh1Y8JJrWqP3jQ1LBi14yVopZXBrsE=";
    };
  };
  system = stdenv.hostPlatform.system;
  release =
    releases.${system} or (throw "nix/lean.nix: no official Lean ${version} release is pinned for ${system}");
  isLinux = stdenv.hostPlatform.isLinux;
in
stdenv.mkDerivation {
  pname = "lean";
  inherit version;

  src = fetchurl {
    url = "https://github.com/leanprover/lean4/releases/download/v${version}/lean-${version}-${release.platform}.tar.zst";
    inherit (release) hash;
  };

  nativeBuildInputs = [ zstd ] ++ lib.optionals isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals isLinux [
    stdenv.cc.cc.lib
    zlib
  ];

  dontConfigure = true;
  dontBuild = true;
  dontStrip = true;
  dontPatchShebangs = true;
  # macOS: the release's binaries exactly as published (rewriting them would break their signatures).
  dontFixup = !isLinux;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    runHook postInstall
  '';

  meta = {
    description = "Lean ${version}, the official release (the toolchain Mathlib v${version} needs)";
    homepage = "https://lean-lang.org";
    license = lib.licenses.asl20;
    platforms = builtins.attrNames releases;
    mainProgram = "lean";
  };
}
