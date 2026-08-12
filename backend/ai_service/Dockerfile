FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --timeout 300 --retries 10 \
        --index-url https://download.pytorch.org/whl/cpu \
        torch && \
    pip install --no-cache-dir --timeout 300 --retries 10 \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        -r requirements.txt

# Runtime media tooling. Whisper decodes every upload through ffmpeg (the
# transformers ASR pipeline shells out to it), and /check-duration calls
# ffprobe -- without these, transcription returns 500 for *all* audio formats
# and the duration guard silently reports 0 seconds.
#
# Deliberately after the pip layers: it is not a build dependency, and keeping
# it here means changing it does not invalidate the cached torch install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY . .

EXPOSE 8000
CMD ["python", "main.py"]
