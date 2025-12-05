# AI Service (NudeNet + Whisper + Qwen)

This service combines NudeNet (image safety classification), Whisper (audio transcription), and Qwen (text analysis) into a single FastAPI application for better performance and resource management.

## Prerequisites

- Python 3.8+
- CUDA-capable GPU (recommended for Whisper) or CPU (will be slower)
- FFmpeg (required for audio processing)

## Setup

1. Navigate to this directory:
   ```powershell
   cd backend/ai_service
   ```

2. Create a virtual environment (optional but recommended):
   ```powershell
   python -m venv venv
   .\venv\Scripts\activate
   ```

3. Install dependencies:
   ```powershell
   pip install -r requirements.txt
   ```

4. Configure environment variables (optional):
   Create a `.env` file in the `backend` directory with the following variables:
   ```
   # Hugging Face token (required for gated models)
   HF_TOKEN=your_huggingface_token_here
   
   # Whisper model selection (optional, defaults to whisper-base)
   # Options:
   #   - openai/whisper-base (smallest, fastest, ~140MB, good for low-memory servers)
   #   - openai/whisper-small (balanced, ~460MB)
   #   - openai/whisper-large-v3-turbo (best quality, ~1.5GB, requires more RAM)
   WHISPER_MODEL=openai/whisper-base
   ```

## Running the Service

Run the server using the provided batch script or manually:

**Using Batch Script:**
```powershell
.\start_service.bat
```

**Manually:**
```powershell
python main.py
```

The service will start on `http://0.0.0.0:8000`.

## Endpoints

- **POST /classify-image**: Accepts an image file. Returns `{"status": "safe" | "nude", "detections": [...]}`.
- **POST /transcribe**: Accepts an audio file. Returns `{"text": "transcribed text", ...}`.
- **POST /analyze-issue**: Accepts `{"description": "string", "categories": "optional string"}`. Returns `{"summary": "5 word max", "category": "detected category", "urgency": "low|medium|high|critical"}`.

**Note:** The old `/analyze` and `/classify` endpoints using the embedding model have been removed in favor of the new Qwen-based `/analyze-issue` endpoint.

## Linux Server Setup (Systemd)

To run this service in the background on a Linux server:

1.  Make the setup script executable:
    ```bash
    chmod +x setup_service.sh
    ```
2.  Run the setup script:
    ```bash
    ./setup_service.sh
    ```
    This will install dependencies, create a virtual environment, and set up a systemd service named `fixam-ai-service`.

3.  Check status:
    ```bash
    sudo systemctl status fixam-ai-service
    ```

## Troubleshooting

### "Killed" Error on Linux Server

If you see a "Killed" message when the service starts, this indicates the process was terminated due to **out of memory (OOM)**. This commonly happens with the larger Whisper models.

**Solutions:**

1. **Use a smaller Whisper model** (recommended):
   Add to your `.env` file:
   ```
   WHISPER_MODEL=openai/whisper-base
   ```
   Or for slightly better quality:
   ```
   WHISPER_MODEL=openai/whisper-small
   ```

2. **Check available memory**:
   ```bash
   free -h
   ```
   The service requires at least:
   - `whisper-base`: ~500MB RAM
   - `whisper-small`: ~1GB RAM
   - `whisper-large-v3-turbo`: ~2.5GB RAM

3. **Monitor memory usage**:
   ```bash
   sudo journalctl -u fixam-ai-service -f
   ```

### Deprecation Warnings

If you see warnings about `forced_decoder_ids` or language detection, these have been fixed in the latest version. The service now explicitly sets:
- `language='en'` for English transcription
- `task='transcribe'` to avoid translation

### Service Won't Start

1. Check the service logs:
   ```bash
   sudo journalctl -u fixam-ai-service -n 50
   ```

2. Verify the HF_TOKEN is set correctly in your `.env` file

3. Ensure FFmpeg is installed:
   ```bash
   ffmpeg -version
   ```
