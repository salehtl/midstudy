#!/usr/bin/env bash
# The rooms solver spike's setup (docs/ROOMS.md §5 Phase A, docs/notes/rooms-calib.md): the spike's own venv, the
# three ML candidates' repos at pinned commits and their weights. Everything big lives outside midstudy:
#   repos   → $MIDSTUDY_SPIKE_REPOS (default ~/.cache/midstudy-spike/repos)
#   weights → the Hugging Face cache (~/.cache/huggingface, or HF_HOME / HF_HUB_CACHE)
# Run from anywhere inside `nix develop` (uv, git). `--no-weights` skips the downloads (Manhattan needs none).
set -euo pipefail
cd "$(dirname "$0")"
REPOS="${MIDSTUDY_SPIKE_REPOS:-$HOME/.cache/midstudy-spike/repos}"
mkdir -p "$REPOS"

clone() {  # name url commit [--recursive]
  local dir="$REPOS/$1"
  if [ ! -d "$dir/.git" ]; then git clone -q ${4:-} "$2" "$dir"; fi
  git -C "$dir" fetch -q origin "$3" 2>/dev/null || true
  git -C "$dir" checkout -q "$3"
  if [ "${4:-}" = "--recursive" ]; then git -C "$dir" submodule update -q --init --recursive; fi
  echo "$1 @ $(git -C "$dir" rev-parse --short HEAD)" >&2
}
clone solv3r https://github.com/ubc-vision/solv3r ef8da34f3736d6c241b3ba3cd074073c06e90b8f
clone vggt https://github.com/facebookresearch/vggt a288dd0f14786c93483e45524328726ab7b1b4ce
clone mast3r https://github.com/naver/mast3r f5209afc300cec36239a7ac992263f36847bbba0 --recursive

uv sync --quiet --extra ml
if [ "${1:-}" != "--no-weights" ]; then
  # The official weights, from Hugging Face (each repo's README names these).
  uv run --quiet python -I -c '
from huggingface_hub import hf_hub_download, snapshot_download
hf_hub_download("jgkwak/solv3r", "solv3r.safetensors")
hf_hub_download("facebook/VGGT-1B", "model.pt")
snapshot_download("naver/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric")
print("weights: cached")'
fi
