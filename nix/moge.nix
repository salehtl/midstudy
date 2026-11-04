# MoGe (github.com/microsoft/MoGe) at the commit calib/ pins: v2.0.0 (MoGe-2), the last code commit before the MoGe-3
# rewrite, which needs CUDA-only flex-gemm (docs/notes/calib.md). Not in nixpkgs.
# MoGe lists its demo, training and viewer dependencies as hard ones. midstudy-calib's inference path
# (moge.model.v2: torch, utils3d, huggingface_hub, cv2, scipy) needs none of them, so they're dropped, as calib/'s
# pyproject.toml does for uv. opencv-python becomes nixpkgs' opencv-python-headless (both are `cv2`).
# torch is passed in as torch-bin (PyTorch's own wheels: CUDA on Linux, MPS on macOS), never nixpkgs' source build.
{
  lib,
  buildPythonPackage,
  fetchFromGitHub,
  setuptools,
  wheel,
  torch-bin,
  utils3d,
  numpy,
  scipy,
  pillow,
  huggingface-hub,
  opencv-python-headless,
}:
buildPythonPackage {
  pname = "moge";
  version = "2.0.0";
  pyproject = true;

  src = fetchFromGitHub {
    owner = "microsoft";
    repo = "MoGe";
    rev = "07444410f1e33f402353b99d6ccd26bd31e469e8";
    hash = "sha256-yPMLnwTF+2QWjzqXLEgegQSW0JDnmxWVc4FcLwj703E=";
  };

  build-system = [
    setuptools
    wheel
  ];

  dependencies = [
    torch-bin
    utils3d
    numpy
    scipy
    pillow
    huggingface-hub
    opencv-python-headless
  ];

  pythonRemoveDeps = [
    "gradio"
    "pipeline"
    "opencv-python"
    "torchvision"
    "matplotlib"
    "trimesh"
    "click"
  ];

  # Imports torch, utils3d, huggingface_hub, cv2 and scipy: what midstudy-calib loads. Needs no GPU.
  pythonImportsCheck = [ "moge.model.v2" ];

  meta = {
    description = "MoGe-2: metric monocular geometry (point map, normals, intrinsics) from one image";
    homepage = "https://github.com/microsoft/MoGe";
    license = lib.licenses.mit;
  };
}
