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
        self.confidence_enabled = self._enable_confidence(model)
        logger.info(
            f"Parakeet loaded in {time.time() - started:.1f}s "
            f"(confidence scoring: {'on' if self.confidence_enabled else 'unavailable'})"
        )

    def _enable_confidence(self, model):
        """
        Ask the decoder to keep per-word confidence alongside the text.

        Off by default, and the exact config differs between NeMo releases, so
        this is attempted rather than assumed: a model that cannot report
        confidence should still transcribe, just without the badge.
        """
        try:
            from omegaconf import OmegaConf, open_dict

            decoding_cfg = model.cfg.decoding
            with open_dict(decoding_cfg):
                decoding_cfg.confidence_cfg = OmegaConf.create({
                    "preserve_frame_confidence": True,
                    "preserve_token_confidence": True,
                    "preserve_word_confidence": True,
                    "aggregation": "mean",
                    "method_cfg": {
                        "name": "entropy",
                        "entropy_type": "tsallis",
                        "alpha": 0.33,
                        "entropy_norm": "exp",
                    },
                })
            model.change_decoding_strategy(decoding_cfg)
            return True
        except Exception as err:
            logger.warning(f"Confidence scoring unavailable: {type(err).__name__}: {err}")
            return False

    def transcribe(self, audio_path):
        """
        Transcribe a file on disk.

        Returns { text, confidence, duration_sec }. `confidence` is 0..1, or
        None when the decoder could not report one -- which is not the same as
        zero and must not be displayed as "0% confident".
        """
        import librosa

        # librosa decodes through soundfile/ffmpeg, so every format the bot
        # accepts (ogg/opus voice notes, mp3, m4a, wav) works, and resamples to
        # 16 kHz mono in one step.
        waveform, _ = librosa.load(audio_path, sr=TARGET_SAMPLE_RATE, mono=True)
        duration = len(waveform) / TARGET_SAMPLE_RATE

        if duration == 0:
            logger.warning(f"No audio decoded from {audio_path}")
            return {"text": "", "confidence": None, "duration_sec": 0}

        started = time.time()
        output = self.model.transcribe(
            [waveform], batch_size=1, return_hypotheses=self.confidence_enabled
        )
        elapsed = time.time() - started

        if not output:
            return {"text": "", "confidence": None, "duration_sec": round(duration, 2)}

        first = output[0]
        # hasattr, not truthiness: a Hypothesis with no speech has text == '',
        # and `getattr(...) or str(first)` then falls through to stringifying the
        # whole object -- dumping tensors into the report description.
        text = (first.text if hasattr(first, "text") else str(first)).strip()
        confidence = self._extract_confidence(first) if text else None

        rtf = elapsed / duration
        logger.info(
            f"Transcribed {duration:.1f}s of audio in {elapsed:.2f}s (RTF {rtf:.3f})"
            + (f", confidence {confidence:.2f}" if confidence is not None else ", no confidence")
        )

        return {
            "text": text,
            "confidence": confidence,
            "duration_sec": round(duration, 2),
        }

    def _extract_confidence(self, hypothesis):
        """
        A single 0..1 score for the whole utterance.

        Word-level confidence is preferred over token-level: a reader is judging
        whether the words are trustworthy, and averaging over sub-word tokens
        flatters long words. Returns None rather than a guess when the decoder
        gave us nothing -- an absent score and a low score mean different
        things to whoever reads the badge.
        """
        for attr in ("word_confidence", "token_confidence"):
            values = getattr(hypothesis, attr, None)
            if values is not None and len(values) > 0:
                try:
                    numeric = [float(v) for v in values]
                except (TypeError, ValueError):
                    continue
                if not numeric:
                    continue
                mean = sum(numeric) / len(numeric)
                # Clamp: some methods can drift a hair outside [0, 1].
                return round(max(0.0, min(1.0, mean)), 4)

        return None


def create_engine():
    return ParakeetTranscriber()
