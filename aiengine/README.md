# Lightweight AI Service

This is a Python-based AI service that uses the `google/gemma-3-270m-it` model to analyze text input and generate responses.

## Prerequisites

- Python 3.8+
- Internet connection (for downloading the model)
- Hugging Face account (if the model is gated, you might need to log in via `huggingface-cli login`)

## Installation

1.  Navigate to the project directory:
    ```bash
    cd c:\Users\kenne\Documents\KVSK\MaxCIT\Projects\FIXAM\Codebase\aiengine
    ```

2.  Install the required dependencies:
    ```bash
    pip install -r requirements.txt
    ```

## Usage

1.  Start the service:
    ```bash
    python main.py
    ```
    The service will start listening on `http://0.0.0.0:9000`.

2.  Send a request:
    You can use `curl` or any HTTP client (like Postman).

    **Example using curl:**
    ```bash
    curl -X POST "http://localhost:9000/analyze" \
         -H "Content-Type: application/json" \
         -d "{\"input_text\": \"Who are you?\"}"
    ```

## Configuration

The service is configured to run on the CPU and listen on port 9000.
The model used is `google/gemma-3-270m-it`.
