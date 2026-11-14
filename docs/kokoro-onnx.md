# Local Kokoro ONNX narration

Issue #17 adds Kokoro as an opt-in, local-only narration provider. It never
falls back to Gemini and does not make a network or paid-provider call.

Create a dedicated Python 3.10–3.13 environment and install the pinned bridge
dependencies:

```powershell
py -3.12 -m venv .venv-kokoro
.\.venv-kokoro\Scripts\python -m pip install -r requirements-kokoro.txt
```

Obtain a matching official Kokoro ONNX model and voices archive separately;
keep both outside Git and record their SHA-256 values in the local pilot report.
The selected model must expose duration output (`has_timings == True`) and the
voice must be `af_heart` for the validated English pilot. The bridge requires
24 kHz output and uses `create_timed`, not estimated or interpolated timings.

The returned phoneme timings are grouped at whitespace boundaries and labeled
with the exact approved transcript tokens. The persisted alignment includes the
raw phoneme evidence, provider/model/voice metadata, transcript hash, audio
hash and duration. A provider change invalidates alignment, captions, render
and release-QA metadata while leaving existing media untouched.
