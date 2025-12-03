import torch
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline, AutoTokenizer, AutoModel
from fastapi import FastAPI, UploadFile, File, HTTPException
from pydantic import BaseModel
from typing import List
from nudenet import NudeDetector
import uvicorn
import os
import shutil
from contextlib import asynccontextmanager
import tempfile
from dotenv import load_dotenv

# Load environment variables from backend/.env
# Get the directory of the current script
current_dir = os.path.dirname(os.path.abspath(__file__))
# Construct path to .env (parent of ai_service is backend)
env_path = os.path.join(current_dir, '..', '.env')
load_dotenv(env_path)

# Global variables
transcription_pipe = None
nude_detector = None
embedding_model = None
embedding_tokenizer = None

EMBEDDING_MODEL_ID = "google/embeddinggemma-300m"

class AnalysisRequest(BaseModel):
    input_text: str

class ClassifyRequest(BaseModel):
    text: str
    candidate_labels: List[str]

UNSAFE_LABELS = [
    "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_BREAST_EXPOSED",
    "ANUS_EXPOSED",
    "MALE_GENITALIA_EXPOSED"
]

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Load models when the server starts.
    """
    global transcription_pipe, nude_detector, embedding_model, embedding_tokenizer
    
    # --- Load Whisper ---
    device = "cuda:0" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    torch_dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    
    # Allow model selection via environment variable for resource-constrained servers
    # Options: "openai/whisper-large-v3-turbo" (better quality, more memory)
    #          "openai/whisper-base" (faster, less memory)
    #          "openai/whisper-small" (balanced)
    model_id = os.environ.get("WHISPER_MODEL", "openai/whisper-base")
    
    print(f"Loading Whisper model '{model_id}' on {device} ({torch_dtype})...")

    try:
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            model_id, 
            torch_dtype=torch_dtype, 
            low_cpu_mem_usage=True, 
            use_safetensors=True,
            use_flash_attention_2=False  # Disable for compatibility
        )
        model.to(device)
        
        processor = AutoProcessor.from_pretrained(model_id)

        transcription_pipe = pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            max_new_tokens=128,
            chunk_length_s=30,
            batch_size=1,  # Reduced from 16 to minimize memory usage
            return_timestamps=True,
            torch_dtype=torch_dtype,
            device=device,
            generate_kwargs={
                "language": "en",  # Explicitly set to English to avoid deprecation warning
                "task": "transcribe"  # Explicitly set task
            }
        )
        print("Whisper model loaded successfully!")
    except Exception as e:
        print(f"Failed to load Whisper model: {e}")
        # We don't raise here to allow the app to start even if one model fails, 
        # but endpoints will fail if accessed.
    
    # --- Load NudeNet ---
    print("Loading NudeNet detector...")
    try:
        nude_detector = NudeDetector()
        print("NudeNet detector loaded successfully!")
    except Exception as e:
        print(f"Failed to load NudeNet detector: {e}")

    # --- Load Embedding Model ---
    print(f"Loading Embedding Model: {EMBEDDING_MODEL_ID}...")
    try:
        # Debug .env loading
        print(f"Attempting to load .env from: {env_path}")
        if os.path.exists(env_path):
            print(".env file exists.")
        else:
            print(".env file does NOT exist at the specified path.")

        # Get token from environment if needed, though this model might be public or cached
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_API_KEY")
        
        if not token:
            print("Warning: HF_TOKEN or HUGGINGFACE_API_KEY not found in environment. Model loading may fail if it is gated.")
        else:
            print("HF_TOKEN found in environment.")

        embedding_tokenizer = AutoTokenizer.from_pretrained(EMBEDDING_MODEL_ID, token=token)
        embedding_model = AutoModel.from_pretrained(EMBEDDING_MODEL_ID, token=token)
        
        # Force CPU for embedding model to avoid VRAM issues with Whisper
        embedding_model.to("cpu") 
        print("Embedding model loaded successfully on CPU!")
    except Exception as e:
        print(f"Failed to load Embedding model: {e}")
        import traceback
        traceback.print_exc()

    yield
    
    # Cleanup
    del transcription_pipe
    del nude_detector
    del embedding_model
    del embedding_tokenizer
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

app = FastAPI(lifespan=lifespan)

@app.post("/classify-image")
def classify_image(image: UploadFile = File(...)):
    if not nude_detector:
        raise HTTPException(status_code=500, detail="NudeNet detector is not loaded.")

    # Save to temp file
    suffix = f".{image.filename.split('.')[-1]}" if '.' in image.filename else ".jpg"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(image.file, tmp)
        tmp_path = tmp.name

    try:
        detections = nude_detector.detect(tmp_path)
        is_nude = False
        
        for detection in detections:
            if detection['class'] in UNSAFE_LABELS and detection['score'] > 0.5:
                is_nude = True
                break

        status = "nude" if is_nude else "safe"
        return {
            "status": status,
            "detections": detections
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

@app.post("/transcribe")
def transcribe_audio(file: UploadFile = File(...)):
    if not transcription_pipe:
        raise HTTPException(status_code=500, detail="Whisper model is not loaded.")

    suffix = f".{file.filename.split('.')[-1]}" if '.' in file.filename else ".ogg"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        result = transcription_pipe(tmp_path)
        return {
            "filename": file.filename,
            "text": result["text"].strip()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

@app.post("/analyze")
def analyze_text(request: AnalysisRequest):
    global embedding_model, embedding_tokenizer
    if embedding_model is None or embedding_tokenizer is None:
        raise HTTPException(status_code=503, detail="Embedding model is not loaded.")

    try:
        # Tokenize input
        inputs = embedding_tokenizer(request.input_text, return_tensors="pt", padding=True, truncation=True)
        inputs = inputs.to(embedding_model.device)

        # Generate embeddings
        with torch.no_grad():
            outputs = embedding_model(**inputs)
            # Mean pooling
            last_hidden_state = outputs.last_hidden_state
            attention_mask = inputs['attention_mask']
            input_mask_expanded = attention_mask.unsqueeze(-1).expand(last_hidden_state.size()).float()
            sum_embeddings = torch.sum(last_hidden_state * input_mask_expanded, 1)
            sum_mask = torch.clamp(input_mask_expanded.sum(1), min=1e-9)
            embeddings = sum_embeddings / sum_mask
            
            # Normalize embeddings
            embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=1)

        return {"embedding": embeddings[0].tolist()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/classify")
def classify_text(request: ClassifyRequest):
    global embedding_model, embedding_tokenizer
    if embedding_model is None or embedding_tokenizer is None:
        raise HTTPException(status_code=503, detail="Embedding model is not loaded.")

    try:
        # Prepare texts: first is the query, rest are candidates
        all_texts = [request.text] + request.candidate_labels
        
        # Tokenize batch
        inputs = embedding_tokenizer(all_texts, return_tensors="pt", padding=True, truncation=True)
        inputs = inputs.to(embedding_model.device)
        
        with torch.no_grad():
            outputs = embedding_model(**inputs)
            # Mean pooling
            last_hidden_state = outputs.last_hidden_state
            attention_mask = inputs['attention_mask']
            input_mask_expanded = attention_mask.unsqueeze(-1).expand(last_hidden_state.size()).float()
            sum_embeddings = torch.sum(last_hidden_state * input_mask_expanded, 1)
            sum_mask = torch.clamp(input_mask_expanded.sum(1), min=1e-9)
            embeddings = sum_embeddings / sum_mask
            
            # Normalize embeddings
            embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=1)
            
        # The first embedding is the query
        query_emb = embeddings[0]
        # The rest are candidates
        candidate_embs = embeddings[1:]
        
        # Calculate cosine similarities (dot product since normalized)
        scores = torch.matmul(candidate_embs, query_emb)
        
        # Find best match
        best_score_idx = torch.argmax(scores).item()
        best_label = request.candidate_labels[best_score_idx]
        best_score = scores[best_score_idx].item()
        
        return {
            "best_label": best_label,
            "score": best_score,
            "scores": {label: score.item() for label, score in zip(request.candidate_labels, scores)}
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
