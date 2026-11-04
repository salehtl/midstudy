# The MoGe-2 ViT-L weights midstudy-calib uses by default (`--model vitl`: Ruicheng/moge-2-vitl-normal, model.pt,
# 1.32 GB), as a fixed-output download from Hugging Face, laid out as a read-only Hugging Face hub cache. The
# midstudy-calib wrapper points HF_HUB_CACHE here with HF_HUB_OFFLINE=1 (both as defaults the environment can
# override), so `MoGeModel.from_pretrained("Ruicheng/moge-2-vitl-normal")` finds the snapshot without a network
# call: offline, huggingface_hub reads refs/main and returns snapshots/<rev>/model.pt. Only vitl is here; vitb and
# vits would need their own entries (or the writable cache described in docs/HANDOFF.md).
# The revision and hash are the ones the calib track measured with on 2026-11-04 (the hash is the file's SHA-256, the
# blob name Hugging Face gives it).
{
  lib,
  fetchurl,
  runCommand,
}:
let
  repo = "Ruicheng/moge-2-vitl-normal";
  rev = "cb0e8bbd6b1e243589717c78e750b1ba4c093acf";
  sha256hex = "280741fd09bc3f403ccff9967784c2a391b52d2c0742ae3efdb21d9f90cc1a01";
  model = fetchurl {
    name = "moge-2-vitl-normal-model.pt";
    url = "https://huggingface.co/${repo}/resolve/${rev}/model.pt";
    hash = "sha256-KAdB/Qm8P0A8z/mWd4TCo5G1LSwHQq4+/bIdn5DMGgE=";
  };
  folder = "models--" + lib.replaceStrings [ "/" ] [ "--" ] repo;
in
runCommand "moge-2-vitl-normal-hf-cache"
  {
    passthru = { inherit model repo rev; };
    meta = {
      description = "MoGe-2 ViT-L (normal) weights as a read-only Hugging Face hub cache";
      homepage = "https://huggingface.co/${repo}";
      license = lib.licenses.mit;
    };
  }
  ''
    d=$out/${folder}
    mkdir -p $d/blobs $d/refs $d/snapshots/${rev}
    ln -s ${model} $d/blobs/${sha256hex}
    # No trailing newline: huggingface_hub reads the commit from this file as is.
    printf '%s' ${rev} > $d/refs/main
    ln -s ../../blobs/${sha256hex} $d/snapshots/${rev}/model.pt
  ''
