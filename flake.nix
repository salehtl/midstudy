{
  # midstudy: see furniture in a photo of your room before you buy it (PLAN.md).
  # Dev shells only for now; the packaging track adds packages and nixosModules.default (PLAN.md §9),
  # using nix/ (copied from nook) as the reference.
  description = "midstudy: place real-size 3D furniture on a phone photo of a room";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # Tools come from here: `nix develop -c <cmd>` from the repo root (CLAUDE.md).
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.python312
            pkgs.uv
            pkgs.nodejs_22
            pkgs.git
          ];
          # uv uses the shell's Python 3.12 instead of downloading one.
          UV_PYTHON = "${pkgs.python312}/bin/python3.12";
          UV_PYTHON_DOWNLOADS = "never";
        };
      });
    };
}
