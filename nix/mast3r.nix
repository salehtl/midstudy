# MASt3R (github.com/naver/mast3r), align-room's learned pose solver (contract §4.9, docs/ROOMS.md §2): its code with the
# dust3r and croco submodules, and its weights as a read-only Hugging Face hub cache, at the commit and revision
# calib/src/midstudy_calib/rooms/mast3r.py pins (COMMIT, WEIGHTS, REVISION). MASt3R isn't a Python package: the calib
# wrapper points MIDSTUDY_MAST3R_DIR at `code`, whose `.midstudy-ready` stamp stands in for the git checkout that
# ensure_code() otherwise clones, and HF_HUB_CACHE at a cache that holds these weights next to MoGe-2's.
# Licence: CC BY-NC-SA 4.0 (code and weights), non-commercial; accepted for this personal tool (docs/ROOMS.md §2).
{
  lib,
  fetchFromGitHub,
  fetchurl,
  runCommand,
}:
let
  commit = "f5209afc300cec36239a7ac992263f36847bbba0";
  repo = "naver/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric";
  rev = "06e7259f34c3060f322df5cb0c7b9094f57e41fc";
  # Hugging Face's blob names: the SHA-256 for an LFS file, the git blob id for a small one.
  files = {
    "model.safetensors" = {
      blob = "0a615eb05fa9db654050aa655945ee5696e7c6c1b7f93f1ee8c37249010f6feb";
      hash = "sha256-CmFesF+p22VAUKplWUXuVpbnxsG3+T8e6MNySQEPb+s=";
    };
    "config.json" = {
      blob = "e485617403af6e7900f6157a399a379176b61656";
      hash = "sha256-cY65PcT55DMrYMwAQa+WLXEsvTRtd3DONcWyLP9o6uQ=";
    };
  };
  folder = "models--" + lib.replaceStrings [ "/" ] [ "--" ] repo;
  src = fetchFromGitHub {
    owner = "naver";
    repo = "mast3r";
    rev = commit;
    fetchSubmodules = true;
    hash = "sha256-6QlSJj5POcw7GZg4gw1i/QhVCbW43OhU+1oPIeBXsp8=";
  };
in
{
  code =
    runCommand "mast3r-${builtins.substring 0 7 commit}" { meta.license = lib.licenses.cc-by-nc-sa-40; }
      ''
        cp -r ${src} $out
        chmod u+w $out
        printf '%s' ${commit} > $out/.midstudy-ready
      '';

  weights =
    runCommand "mast3r-vitl-hf-cache"
      {
        meta = {
          description = "MASt3R ViT-L weights as a read-only Hugging Face hub cache";
          homepage = "https://huggingface.co/${repo}";
          license = lib.licenses.cc-by-nc-sa-40;
        };
      }
      (
        ''
          d=$out/${folder}
          mkdir -p $d/blobs $d/refs $d/snapshots/${rev}
          printf '%s' ${rev} > $d/refs/main
        ''
        + lib.concatStrings (
          lib.mapAttrsToList (name: f: ''
            ln -s ${
              fetchurl {
                name = "mast3r-vitl-${name}";
                url = "https://huggingface.co/${repo}/resolve/${rev}/${name}";
                inherit (f) hash;
              }
            } $d/blobs/${f.blob}
            ln -s ../../blobs/${f.blob} $d/snapshots/${rev}/${name}
          '') files
        )
      );
}
