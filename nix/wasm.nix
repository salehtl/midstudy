# The Rust kernels as WebAssembly: every core/crates/wasm-<name> crate into $out/wasm/<name>/ (web for the planner;
# node, pipeline and product for Node), exactly as `npm run build` makes build/wasm/ in a checkout: this runs
# `node scripts/build.mjs --wasm-only`, so cargo (release, wasm32-unknown-unknown with SIMD128 from
# core/.cargo/config.toml, --locked), wasm-bindgen 0.2.121 and wasm-opt -O3 run with the script's own flags. A new
# wasm-* crate is picked up without a change here. Rust is the dev shell's 1.95.0 from rust-overlay (nix/toolchain.nix);
# the crates come from core/Cargo.lock through importCargoLock (crates.io checksums, no hash to keep up to date).
{
  lib,
  stdenv,
  makeRustPlatform,
  nodejs_22,
  wasm-bindgen-cli_0_2_121,
  binaryen,
  rust,
}:
let
  rustPlatform = makeRustPlatform {
    cargo = rust;
    rustc = rust;
  };
  crates = lib.attrNames (
    lib.filterAttrs (_: type: type == "directory") (builtins.readDir ../core/crates)
  );
in
stdenv.mkDerivation {
  pname = "midstudy-wasm";
  version = "2.0.0";

  # The workspace without the fuzz targets (their corpora are most of core/'s files, and the build never reads them).
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../scripts/build.mjs
      ../core/Cargo.toml
      ../core/Cargo.lock
      ../core/.cargo
      (lib.fileset.difference ../core/crates (
        lib.fileset.unions (map (c: lib.fileset.maybeMissing (../core/crates + "/${c}/fuzz")) crates)
      ))
    ];
  };

  cargoDeps = rustPlatform.importCargoLock { lockFile = ../core/Cargo.lock; };
  cargoRoot = "core";

  nativeBuildInputs = [
    rust
    rustPlatform.cargoSetupHook
    nodejs_22
    wasm-bindgen-cli_0_2_121
    binaryen
  ];

  # The panic locations in the wasm name source files; the build folder's name differs between builds (and machines),
  # so it is written as /build, as Linux's sandbox names it anyway: the same sources give the same bytes. The flag joins
  # core/.cargo/config.toml's (cargo merges rustflags arrays across config files).
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR CARGO_HOME=$TMPDIR/cargo-home CARGO_NET_OFFLINE=true
    cat >> $NIX_BUILD_TOP/.cargo/config.toml <<EOF
    [target.wasm32-unknown-unknown]
    rustflags = ["--remap-path-prefix=$NIX_BUILD_TOP=/build"]
    EOF
    node scripts/build.mjs --wasm-only
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r build/wasm $out/wasm
    runHook postInstall
  '';

  meta = {
    description = "midstudy's Rust kernels compiled to WebAssembly (planner and Node builds)";
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
}
