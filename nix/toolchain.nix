# The v2 build and check tools of the dev shells (docs/REFACTOR.md §1 and §3, docs/notes/f-toolchain.md).
#
#   default   Rust 1.95.0 (rustfmt, clippy, rust-src, llvm-tools, wasm32-unknown-unknown), wasm-bindgen-cli 0.2.121
#             (every crate pins `wasm-bindgen = "=0.2.121"`), binaryen (wasm-opt), cargo-fuzz, Lean, pyright, ruff and
#             `tscert` (nix/tscert.nix).
#   nightly   the dated nightly that Kani 0.68.0 pins (nightly-2026-08-21, its rust-toolchain.toml) with miri, rust-src,
#             llvm-tools and rustc-dev: Miri, cargo-fuzz and Kani (nix/kani.nix, aarch64-darwin) run on it.
#
# Rust comes from rust-overlay (oxalica) as the official binary distributions, pinned by flake.lock; nothing goes
# through rustup, and nothing is installed into ~ (cargo keeps its registry cache in ~/.cargo as usual).
{
  pkgs,
  rust-overlay,
  lean,
}:
let
  rust-bin = rust-overlay.lib.mkRustBin { } pkgs;

  rustStable = rust-bin.stable."1.95.0".minimal.override {
    extensions = [
      "rust-src"
      "rustfmt"
      "clippy"
      "llvm-tools"
    ];
    targets = [ "wasm32-unknown-unknown" ];
  };

  nightlyDate = "2026-08-21";
  rustNightly = rust-bin.nightly.${nightlyDate}.minimal.override {
    extensions = [
      "miri"
      "rust-src"
      "llvm-tools"
      "rustc-dev"
      "rustfmt"
      "clippy"
    ];
  };

  tscert = import ./tscert.nix { inherit pkgs; };
  # Kani's release bundle exists for aarch64-darwin (and Linux); packaged for the Mac only (nix/kani.nix).
  kani = if pkgs.stdenv.hostPlatform.system == "aarch64-darwin" then import ./kani.nix { inherit pkgs rustNightly; } else null;

  # What every shell has: the v1 tools (CLAUDE.md) and git.
  base = [
    pkgs.python312
    pkgs.uv
    pkgs.nodejs_22
    pkgs.git
  ];
  uvEnv = {
    # uv uses the shell's Python 3.12 instead of downloading one.
    UV_PYTHON = "${pkgs.python312}/bin/python3.12";
    UV_PYTHON_DOWNLOADS = "never";
  };
in
{
  inherit
    rustStable
    rustNightly
    nightlyDate
    tscert
    kani
    ;

  default = pkgs.mkShell (
    uvEnv
    // {
      packages = base ++ [
        rustStable
        pkgs.wasm-bindgen-cli_0_2_121
        pkgs.binaryen
        pkgs.cargo-fuzz
        lean
        pkgs.pyright
        pkgs.ruff
        tscert.command
      ];
    }
  );

  nightly = pkgs.mkShell (
    uvEnv
    // {
      packages =
        base
        ++ [
          rustNightly
          pkgs.cargo-fuzz
        ]
        ++ pkgs.lib.optional (kani != null) kani;
      MIDSTUDY_RUST_NIGHTLY = nightlyDate;
    }
  );
}
