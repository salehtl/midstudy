# Kani 0.68.0 (Rust model checker; not in nixpkgs) from its aarch64-darwin release bundle, as a fixed-output fetch:
# kani-driver, kani-compiler, CBMC, kissat and Kani's std/core rlibs, all built against nightly-2026-08-21. Kani's own
# setup (`cargo kani setup`) would install that nightly with rustup into ~/.kani; here the bundle's `toolchain` link
# points at the same nightly from rust-overlay (kani-compiler loads librustc_driver through @loader_path/../toolchain/lib),
# and `cargo-kani` runs kani-driver the way Kani's proxy does (argv[0] cargo-kani, bundle and toolchain on PATH).
# cbmc-viewer (for --visualize only) is not included. aarch64-darwin only.
{ pkgs, rustNightly }:
let
  version = "0.68.0";
  bundle = pkgs.stdenv.mkDerivation {
    pname = "kani-bundle";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://github.com/model-checking/kani/releases/download/kani-${version}/kani-${version}-aarch64-apple-darwin.tar.gz";
      hash = "sha256-pdOaXV50glOlU6pi8pXGw5coeSeijl4yaR1/8u2gw5g=";
    };
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;
    installPhase = ''
      mkdir -p $out
      cp -R . $out/kani-${version}
      ln -s ${rustNightly} $out/kani-${version}/toolchain
    '';
  };
  wrap =
    name:
    pkgs.writeShellScriptBin name ''
      home=${bundle}/kani-${version}
      export PATH="$home/bin:${rustNightly}/bin:$PATH"
      export KANI_HOME=${bundle}
      exec -a ${name} "$home/bin/kani-driver" "$@"
    '';
in
pkgs.symlinkJoin {
  name = "kani-${version}";
  paths = [
    (wrap "cargo-kani")
    (wrap "kani")
  ];
  passthru = { inherit bundle version; };
}
