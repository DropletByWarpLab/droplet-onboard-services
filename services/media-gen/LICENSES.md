# Media runtime and model licenses

Weights are operator-provisioned and are not bundled or downloaded by this
service. Retain each selected snapshot's original license, notices, exact
revision and hashes with the deployment inventory. The model license is
separate from the runtime library license.

| Component | Upstream license/source |
|---|---|
| Torch | BSD-3-Clause; [PyTorch repository](https://github.com/pytorch/pytorch/blob/main/LICENSE) |
| Diffusers, Transformers, Accelerate, Safetensors | Apache-2.0; respective [Hugging Face repositories](https://github.com/huggingface) |
| Pillow | HPND/Pillow license; [Pillow license](https://github.com/python-pillow/Pillow/blob/main/LICENSE) |
| SentencePiece | Apache-2.0; [SentencePiece license](https://github.com/google/sentencepiece/blob/master/LICENSE) |
| Protobuf | BSD-3-Clause; [Protobuf license](https://github.com/protocolbuffers/protobuf/blob/main/LICENSE) |
| CUDA/NVIDIA libraries resolved by Torch | NVIDIA licenses; retain wheel notices and inventory from requirements.lock; [CUDA toolkit license](https://docs.nvidia.com/cuda/eula/index.html) |
| Distribution FFmpeg and libx264 | FFmpeg LGPL/GPL components, libx264 GPL; the distribution build determines the combined binary license. Retain notices and corresponding-source/distribution obligations; [FFmpeg legal](https://ffmpeg.org/legal.html), [x264](https://www.videolan.org/developers/x264.html). This fleet already uses FFmpeg in file-indexer; this service does not make it a permissive dependency. |
| SDXL base 1.0 weights | [CreativeML Open RAIL++-M](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md), with use restrictions and distribution terms |
| Default Wan2.1 T2V 1.3B Diffusers weights | [Official model card](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B-Diffusers), Apache-2.0. Preserve snapshot notices; no weights included here. |
| Optional LTX-Video weights | Version-dependent; [official model card](https://huggingface.co/Lightricks/LTX-Video) links each version's license. Current versions use [LTXV Open Weights License 0.X](https://huggingface.co/Lightricks/LTX-Video/blob/main/LTX-Video-Open-Weights-License-0.X.txt), including revenue-dependent commercial terms, use restrictions and downstream notices. LTX is an explicit operator option. |

The release SBOM must cover all transitive Python wheels, native packages and
model files; this short inventory does not replace their full license texts.
Dependency hash locking authenticates artifacts, not deployment license rights.
