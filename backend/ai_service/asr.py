"""
Speech-to-text for the AI service: NVIDIA Parakeet TDT, on CPU.

The model is loaded once at startup and held for the life of the process --
loading it per request would add a minute to every voice note.

Replaces the previous Whisper pipeline. Same `/transcribe` contract, so nothing
on the Node side changes.
"""

import logging
import os
import time

logger = logging.getLogger("ai_service.asr")

# What the model expects; librosa resamples whatever the citizen sent.
TARGET_SAMPLE_RATE = 16000

DEFAULT_MODEL = "nvidia/parakeet-tdt-0.6b-v3"


class ParakeetTranscriber:
    def __init__(self, model_name=None):
        self.model_name = model_name or os.environ.get("PARAKEET_MODEL", DEFAULT_MODEL)
        self.model = None

    @property
    def name(self):
        return "parakeet"

    def load(self):
        # Imported here, not at module scope: NeMo is a large import and this
        # keeps the cost inside the startup step that reports on it.
        import nemo.collections.asr as nemo_asr

        logger.info(f"Loading Parakeet model '{self.model_name}' on CPU...")
        started = time.time()

        model = nemo_asr.models.ASRModel.from_pretrained(model_name=self.model_name)
        model = model.cpu()          # force CPU; no GPU is assumed anywhere
        model.eval()

        self.model = model
        logger.info(f"Parakeet loaded in {time.time() - started:.1f}s")

    def transcribe(self, audio_path):
        """Transcribe a file on disk. Returns the text, or '' if there is none."""
        import librosa

        # librosa decodes through soundfile/ffmpeg, so every format the bot
        # accepts (ogg/opus voice notes, mp3, m4a, wav) works, and resamples to
        # 16 kHz mono in one step.
        waveform, _ = librosa.load(audio_path, sr=TARGET_SAMPLE_RATE, mono=True)
        duration = len(waveform) / TARGET_SAMPLE_RATE

        if duration == 0:
            logger.warning(f"No audio decoded from {audio_path}")
            return ""

        started = time.time()
        output = self.model.transcribe([waveform], batch_size=1)
        elapsed = time.time() - started

        if not output:
            return ""

        first = output[0]
        text = first.text if hasattr(first, "text") else str(first)

        # RTF below 1.0 means transcription is faster than real time.
        rtf = elapsed / duration
        logger.info(f"Transcribed {duration:.1f}s of audio in {elapsed:.2f}s (RTF {rtf:.3f})")

        return (text or "").strip()


def create_engine():
    return ParakeetTranscriber()
