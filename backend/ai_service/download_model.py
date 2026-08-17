"""
Fetch every AI model ahead of time, with visible progress.

The service downloads these on first start anyway, but that happens in the
background behind a log stream: progress is hard to follow, and a failed
download leaves the container up and apparently healthy while its endpoints
return 500. Running this first turns the download into a foreground step you can
watch and retry.

    docker compose stop ai-engine
    docker compose run --rm ai-engine python download_model.py
    docker compose up -d ai-engine

Everything lands in /root/.cache, which is the `model-cache` volume, so it
survives rebuilds and container recreation. Re-running is cheap: already-cached
files are skipped, and a partial download resumes rather than starting over.

This cannot be baked into the image build: the weights are ~3.5 GB and belong in
the volume, not the layer. This script is the post-build step that warms them.
"""

import os
import sys
import time

SPEECH_MODEL = os.environ.get("PARAKEET_MODEL", "nvidia/parakeet-tdt-0.6b-v3")
AGE_MODEL = os.environ.get("AGE_MODEL", "prithivMLmods/Age-Classification-SigLIP2")
INTENT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

ATTEMPTS = int(os.environ.get("DOWNLOAD_ATTEMPTS", "5"))
BACKOFF_SECONDS = 15


def _retry(label, fn):
    for attempt in range(1, ATTEMPTS + 1):
        try:
            print(f"--- {label}: attempt {attempt} of {ATTEMPTS} ---")
            started = time.time()
            fn()
            print(f"{label} ready in {time.time() - started:.0f}s.\n")
            return True
        except KeyboardInterrupt:
            print("\nInterrupted. Progress is kept; re-run to resume.")
            sys.exit(130)
        except Exception as err:
            # Hugging Face CDN drops mid-transfer are common on a poor link.
            print(f"{label} attempt {attempt} failed: {err}\n", file=sys.stderr)
            if attempt < ATTEMPTS:
                print(f"Retrying in {BACKOFF_SECONDS}s...\n")
                time.sleep(BACKOFF_SECONDS)
    return False


def main():
    print(f"Speech:  {SPEECH_MODEL}  (~2.5 GB)")
    print(f"Age:     {AGE_MODEL}")
    print(f"Intent:  {INTENT_MODEL}")
    print("Cache:   /root/.cache  (docker volume 'model-cache')")
    print("First run downloads ~3.5 GB in total. Interrupting is safe -- it resumes.\n")

    # Imports are inside each step on purpose: NeMo in particular takes several
    # seconds to import, and doing it behind a banner avoids a silent stall.

    def download_parakeet():
        import nemo.collections.asr as nemo_asr
        model = nemo_asr.models.ASRModel.from_pretrained(model_name=SPEECH_MODEL)
        model.cpu()
        model.eval()

    def download_intent():
        from sentence_transformers import SentenceTransformer
        SentenceTransformer(INTENT_MODEL)

    def download_age():
        from transformers import AutoImageProcessor, SiglipForImageClassification
        AutoImageProcessor.from_pretrained(AGE_MODEL)
        SiglipForImageClassification.from_pretrained(AGE_MODEL)

    results = [
        _retry("Speech (Parakeet)", download_parakeet),
        _retry("Intent (MiniLM)", download_intent),
        _retry("Age (SigLIP2)", download_age),
    ]

    if all(results):
        print("All models cached. Later starts load from disk, no download.")
        print("\nNow run:  docker compose up -d ai-engine")
        return 0

    print(
        "\nSome models failed to download after retries. Nothing downloaded so far "
        "is lost -- re-run this command and it continues from where it stopped.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
