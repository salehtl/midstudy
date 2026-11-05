# The official Lean 4.29.1 release for aarch64-darwin, as a fixed-output fetch (proofs track; docs/notes/proofs.md).
#
# Why not nixpkgs' lean4: proofs/ uses Mathlib v4.29.1, whose lean-toolchain is leanprover/lean4:v4.29.1, and gets
# Mathlib's compiled .olean files with `lake exe cache get` instead of building Mathlib from source. Those files only
# load in a Lean whose githash is the release's own commit. nixpkgs' lean4 4.29.1 (the flake's pinned nixpkgs) is
# built from source with GIT_SHA1 set to the tag name, "v4.29.1", so Mathlib's cache doesn't load in it and Lake would
# rebuild all of Mathlib. This is that same Lean version, as released, with nothing changed (no strip, no fixup: the
# macOS binaries are signed).
#
# Standalone:  nix build -f nix/lean.nix          (or: nix shell -f nix/lean.nix -c lean --version)
# From a flake: pkgs.callPackage ./nix/lean.nix { }
{
  pkgs ? (builtins.getFlake "github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c")
    .legacyPackages.${builtins.currentSystem},
  lib ? pkgs.lib,
  stdenvNoCC ? pkgs.stdenvNoCC,
  fetchurl ? pkgs.fetchurl,
  zstd ? pkgs.zstd,
}:

let
  version = "4.29.1";
  releases = {
    aarch64-darwin = {
      platform = "darwin_aarch64";
      hash = "sha256-c7zLOSyn2Ks9YqHjKLt9BXgV8Ijb2/tldPGUrlBXl68=";
    };
  };
  system = stdenvNoCC.hostPlatform.system;
  release =
    releases.${system}
      or (throw "nix/lean.nix: no official Lean ${version} release is pinned for ${system} (only aarch64-darwin)");
in
stdenvNoCC.mkDerivation {
  pname = "lean";
  inherit version;

  src = fetchurl {
    url = "https://github.com/leanprover/lean4/releases/download/v${version}/lean-${version}-${release.platform}.tar.zst";
    inherit (release) hash;
  };

  nativeBuildInputs = [ zstd ];

  dontConfigure = true;
  dontBuild = true;
  # The release's binaries are used exactly as published (stripping or rewriting them would break their signatures).
  dontFixup = true;

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
