"""
Fetch the speech-to-text model ahead of time, with visible progress.

The service downloads the model on first start anyway, but that happens in the
background behind a log stream: progress is hard to follow, and a failed
download leaves the container up and apparently healthy while /transcribe
returns 500. Running this first turns it into a foreground step you can watch
and retry.

    docker compose stop ai-engine
    docker compose run --rm ai-engine python download_model.py
    docker compose up -d ai-engine

Everything lands in /root/.cache, which is the `model-cache` volume, so it
survives rebuilds and container recreation. Re-running is cheap: already-cached
files are skipped, and a partial download resumes rather than starting over.
"""

import os
import sys
import time

MODEL_NAME = os.environ.get("PARAKEET_MODEL", "nvidia/parakeet-tdt-0.6b-v3")
ATTEMPTS = int(os.environ.get("DOWNLOAD_ATTEMPTS", "5"))
BACKOFF_SECONDS = 15


def main():
    print(f"Model:  {MODEL_NAME}")
    print(f"Cache:  /root/.cache  (docker volume 'model-cache')")
    print("First download is ~2.5 GB. Interrupting is safe -- it resumes.\n")

    # Imported after the banner: NeMo takes a few seconds to import and the
    # silence is otherwise confusing.
    import nemo.collections.asr as nemo_asr

    for attempt in range(1, ATTEMPTS + 1):
        try:
            print(f"--- attempt {attempt} of {ATTEMPTS} ---")
            started = time.time()

            # The same call the service makes, so whatever it needs at runtime
            # (the .nemo archive and anything NeMo extracts from it) is cached
            # by the time this returns.
            model = nemo_asr.models.ASRModel.from_pretrained(model_name=MODEL_NAME)
            model = model.cpu()
            model.eval()

            print(f"\nModel ready in {time.time() - started:.0f}s.")
            print("Cached for good -- later starts load from disk, no download.")
            print("\nNow run:  docker compose up -d ai-engine")
            return 0

        except KeyboardInterrupt:
            print("\nInterrupted. Progress is kept; re-run to resume.")
            return 130

        except Exception as err:
            # Hugging Face CDN drops mid-transfer are common on a poor link.
            print(f"\nAttempt {attempt} failed: {err}\n", file=sys.stderr)
            if attempt < ATTEMPTS:
                print(f"Retrying in {BACKOFF_SECONDS}s...\n")
                time.sleep(BACKOFF_SECONDS)

    print(
        f"\nGave up after {ATTEMPTS} attempts. Nothing downloaded so far is lost --\n"
        "re-run this command and it continues from where it stopped.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
