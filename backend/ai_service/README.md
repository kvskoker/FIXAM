# AI Service (NudeNet + Whisper)

This service combines NudeNet (image safety classification) and Whisper (audio transcription) into a single FastAPI application for better performance and resource management.

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
- **POST /analyze**: Accepts `{"input_text": "string"}`. Returns `{"embedding": [...]}`.
- **POST /classify**: Accepts `{"text": "string", "candidate_labels": ["label1", "label2"]}`. Returns `{"best_label": "label1", "score": 0.9, ...}`.

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
