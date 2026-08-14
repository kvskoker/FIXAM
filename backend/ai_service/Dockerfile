FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app


COPY requirements.txt .

# Two separate installs, each against ONE index.
#
# torch and torchaudio come from PyTorch's CPU index (the PyPI builds pull in
# ~2.5 GB of CUDA libraries this deployment never uses). Everything else comes
# from PyPI alone.
#
# The second install must NOT carry --extra-index-url: with both indexes in
# play, pip can read a wheel's metadata from one and fetch the artifact from
# the other, and the install dies on "THESE PACKAGES DO NOT MATCH THE HASHES
# FROM THE REQUIREMENTS FILE" ~50 minutes in. NeMo's large dependency tree
# makes that collision very likely. torch is already satisfied by the first
# install, so pip does not go looking for it again.
# torchvision is required by transformers' AutoImageProcessor, which the age
# classifier goes through -- without it the model fails to load with an
# ImportError whose message is empty in the log.
RUN pip install --no-cache-dir --timeout 300 --retries 10 \
        --index-url https://download.pytorch.org/whl/cpu \
        torch torchaudio torchvision

# Retried as a whole. pip's own --retries covers a failed download, but not a
# truncated index page or an SSL drop mid-resolve, which kill the run outright
# -- and losing a ~50 minute build to one bad response is expensive on the kind
# of connection this is deployed over. The trailing test makes a genuine
# failure after all attempts fail the build rather than pass silently.
RUN n=0; until [ $n -ge 3 ]; do \
        pip install --no-cache-dir --timeout 300 --retries 10 -r requirements.txt && break; \
        n=$((n+1)); echo "pip attempt $n failed; retrying in 20s"; sleep 20; \
    done; [ $n -lt 3 ]

# Runtime media tooling. librosa decodes uploads through ffmpeg for anything
# libsndfile cannot read directly (WhatsApp voice notes are ogg/opus), and
# /check-duration calls ffprobe -- without these, transcription fails for every
# audio format and the duration guard silently reports 0 seconds.
#
# Deliberately after the pip layers: it is not a build dependency, and keeping
# it here means changing it does not invalidate the cached install above.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Every model this service downloads at runtime -- Parakeet (speech), SigLIP2
# (age), MiniLM (intent embeddings) -- goes through huggingface_hub, which
# caches under HF_HOME. Pinned explicitly rather than left to the default so the
# path cannot drift from the `model-cache` volume mounted at /root/.cache and
# quietly start re-downloading ~3.5 GB on every container recreate.
#
# NudeNet is the exception: its detector ships inside the pip package, so it is
# baked into the image and never downloaded.
ENV HF_HOME=/root/.cache/huggingface

COPY . .

EXPOSE 8000
CMD ["python", "main.py"]
