# Bundled speech assets and dependencies

- Kokoro 82M v1.0 model and the selected English voice vectors: Apache License
  2.0. Authors: hexgrad and the Kokoro contributors.
  https://huggingface.co/hexgrad/Kokoro-82M
  Voice provenance: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
- Quantized ONNX conversion: ONNX Community / Xenova, Apache License 2.0.
  https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
  The exact immutable revision and file digests are recorded in
  `/app/models/assets.json` inside the image. The complete model license is
  included in `/app/models/LICENSE`.
- `kokoro-onnx`: MIT License, copyright thewh1teagle.
  https://github.com/thewh1teagle/kokoro-onnx
- ONNX Runtime: MIT License, copyright Microsoft and contributors.
  https://github.com/microsoft/onnxruntime
- Phonemizer: GNU GPL version 3 or later.
  https://github.com/bootphon/phonemizer
- eSpeak NG, bundled by `espeakng-loader`: GNU GPL version 3 or later.
  https://github.com/espeak-ng/espeak-ng
  https://github.com/thewh1teagle/espeakng-loader

These components are free to use commercially under their respective terms.
The Apache model license does not change the GPL obligations of the phonemizer
and eSpeak code. Retain package license files and provide their corresponding
source/license notices when distributing the appliance image. Installed Python
packages retain their license metadata in `/opt/venv/lib/python3.12/site-packages`;
Debian libraries retain their notices in `/usr/share/doc`.
