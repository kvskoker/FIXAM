import torch
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline, AutoTokenizer, AutoModelForCausalLM
from fastapi import FastAPI, UploadFile, File, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from nudenet import NudeDetector
import uvicorn
import os
import shutil
from contextlib import asynccontextmanager
import tempfile
from dotenv import load_dotenv
import json
import re
import psycopg2
import subprocess
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
from intent_classifier import IntentClassifier
from summa import summarizer

# Load environment variables from backend/.env
# Get the directory of the current script
current_dir = os.path.dirname(os.path.abspath(__file__))
# Construct path to .env (parent of ai_service is backend)
env_path = os.path.join(current_dir, '..', '.env')
load_dotenv(env_path)

# Global variables
transcription_pipe = None
nude_detector = None
intent_classifier = None
categories_list = []
category_embeddings = None
urgency_list = ["Low", "Medium", "High", "Critical"]
urgency_embeddings = None

class AnalysisRequest(BaseModel):
    input_text: str

class AnalyzeIssueRequest(BaseModel):
    description: str
    categories: Optional[str] = None

class AnalyzeIntentRequest(BaseModel):
    text: str

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
    global transcription_pipe, nude_detector, categories_list, intent_classifier
    global category_embeddings, urgency_embeddings, urgency_list
    
    # --- Load Intent Classifier ---
    print("Loading Intent Classifier...")
    try:
        intent_classifier = IntentClassifier()
    except Exception as e:
        print(f"Failed to load Intent Classifier: {e}")
        intent_classifier = None
    
    # --- Load Categories from DB ---
    print("Loading categories from database...")
    try:
        conn = psycopg2.connect(
            host=os.environ.get("DB_HOST", "localhost"),
            database=os.environ.get("DB_NAME", "fixam"),
            user=os.environ.get("DB_USER", "postgres"),
            password=os.environ.get("DB_PASSWORD", "password"),
            port=os.environ.get("DB_PORT", "5432")
        )
        cur = conn.cursor()
        cur.execute("SELECT name FROM categories;")
        rows = cur.fetchall()
        categories_list = [row[0] for row in rows]
        print(f"Loaded {len(categories_list)} categories from database.")
        cur.close()
        conn.close()
    except Exception as e:
        print(f"Failed to fetch categories from DB: {e}")
        # Fallback
        categories_list = [
            "Electricity", "Water", "Road", "Transportation", "Drainage", "Waste", 
            "Housing", "Telecommunications", "Health", "Education", "Security"
        ]
        print("Using fallback categories.")

    # --- Pre-compute Embeddings for Categories & Urgency ---
    if intent_classifier and intent_classifier.model:
        print("Pre-computing Category and Urgency embeddings...")
        try:
            category_embeddings = intent_classifier.model.encode(categories_list)
            urgency_embeddings = intent_classifier.model.encode(urgency_list)
            print("Embeddings computed successfully.")
        except Exception as e:
            print(f"Failed to compute embeddings: {e}")

    # --- Load Whisper ---
    device = "cuda:0" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    torch_dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    
    model_id = os.environ.get("WHISPER_MODEL", "openai/whisper-base")
    
    print(f"Loading Whisper model '{model_id}' on {device} ({torch_dtype})...")

    try:
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            model_id, 
            torch_dtype=torch_dtype, 
            low_cpu_mem_usage=True, 
            use_safetensors=True
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
            batch_size=1,
            return_timestamps=True,
            torch_dtype=torch_dtype,
            device=device,
            generate_kwargs={
                "task": "transcribe"
            }
        )
        print("Whisper model loaded successfully!")
    except Exception as e:
        print(f"Failed to load Whisper model: {e}")
    
    # --- Load NudeNet ---
    print("Loading NudeNet detector...")
    try:
        nude_detector = NudeDetector()
        print("NudeNet detector loaded successfully!")
    except Exception as e:
        print(f"Failed to load NudeNet detector: {e}")

    yield
    
    # Cleanup
    del transcription_pipe
    del nude_detector
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

app = FastAPI(lifespan=lifespan)

def get_media_duration(file_path):
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        return float(result.stdout)
    except Exception as e:
        print(f"Error checking duration: {e}")
        return 0.0

@app.post("/check-duration")
def check_duration(file: UploadFile = File(...)):
    suffix = f".{file.filename.split('.')[-1]}" if '.' in file.filename else ".tmp"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        duration = get_media_duration(tmp_path)
        return {"duration": duration}
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

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

@app.post("/analyze-issue")
def analyze_issue(request: AnalyzeIssueRequest):
    """
    Analyze an issue description using Embeddings (Semantic Similarity).
    Replaces the heavy Qwen model with efficient embedding comparison.
    """
    global intent_classifier, category_embeddings, urgency_embeddings, categories_list, urgency_list
    
    if intent_classifier is None or category_embeddings is None:
        raise HTTPException(status_code=503, detail="AI models (Embeddings) are not loaded.")

    try:
        user_description = request.description.strip()
        print(f"Analyzing Issue: {user_description}")
        
        # 1. Compute Embedding for User Description
        desc_embedding = intent_classifier.model.encode([user_description])
        
        # 2. Find Best Category
        cat_sims = cosine_similarity(desc_embedding, category_embeddings)[0]
        best_cat_idx = np.argmax(cat_sims)
        best_category = categories_list[best_cat_idx]
        
        # 3. Find Urgency
        urg_sims = cosine_similarity(desc_embedding, urgency_embeddings)[0]
        best_urg_idx = np.argmax(urg_sims)
        best_urgency = urgency_list[best_urg_idx].lower()
        
        # 4. Generate Summary using Summa (TextRank) + Fallbacks
        summary = ""
        try:
            # Try TextRank first. 
            # 'words=10' helps prioritize brevity, but Summa might return empty for short inputs.
            text_rank_summary = summarizer.summarize(user_description, words=10)
            if text_rank_summary:
                # Summa returns full sentences. Use the first one if multiple.
                summary = text_rank_summary.split('\n')[0]
        except Exception as e:
            print(f"Summa summarization failed: {e}")

        # Fallback: Use first sentence if Summa returned nothing
        if not summary:
            summary = re.split(r'[.!?\n]', user_description.strip())[0]

        # Cleanup: Remove conversational prefixes to make it "Abstractive-like"
        prefixes = [
            r"^i want to report\s+(?:a\s+|an\s+)?",
            r"^i'd like to report\s+(?:a\s+|an\s+)?",
            r"^reporting\s+(?:a\s+|an\s+)?",
            r"^please fix\s+",
            r"^kindly fix\s+",
            r"^fix\s+",
            r"^report of\s+",
            r"^there is\s+(?:a\s+|an\s+)?",
            r"^there's\s+(?:a\s+|an\s+)?",
            r"^we have\s+(?:a\s+|an\s+)?",
            r"^hello,?\s+",
            r"^hi,?\s+"
        ]
        
        cleaned_text = summary.strip()
        for p in prefixes:
            cleaned_text = re.sub(p, "", cleaned_text, count=1, flags=re.IGNORECASE)
            
        # Cleanup: Remove conversational suffixes/explanations (clauses starting with 'that', 'which', 'causing', etc.)
        suffixes = [
            r"\s+that needs\s+.*",
            r"\s+that need\s+.*",
            r"\s+which needs\s+.*",
            r"\s+which is\s+.*",
            r"\s+that is\s+.*",
            r"\s+causing\s+.*",
            r"\s+resulting in\s+.*",
            r"\s+so\s+.*",
            r"\s+please\s+.*",
            r"\s+kindly\s+.*",
            r"\s+it has been\s+.*",
            r"\s+we have\s+.*",
            r"\s+and it\s+.*"
        ]
        for s in suffixes:
            cleaned_text = re.sub(s, "", cleaned_text, count=1, flags=re.IGNORECASE)

        cleaned_text = cleaned_text.strip()
        
        # Capitalize and ensure it's not too long
        if cleaned_text:
             cleaned_text = cleaned_text[0].upper() + cleaned_text[1:]
             
        # Hard truncate if still too long (fallback safety)
        words = cleaned_text.split()
        if len(words) > 10:
            summary = " ".join(words[:10]) + "..."
        else:
            summary = cleaned_text
            
        if not summary:
             summary = user_description[:20] + "..."

        print(f"Result -> Category: {best_category}, Urgency: {best_urgency}, Summary: {summary}")

        return {
            "summary": summary,
            "category": best_category,
            "urgency": best_urgency
        }

    except Exception as e:
        print(f"Error in analyze_issue: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/analyze-intent")
def analyze_intent(request: AnalyzeIntentRequest):
    """
    Analyze user text to determine intent and extract entities using Embedding Model + Regex.
    """
    global intent_classifier
    
    if intent_classifier is None:
        raise HTTPException(status_code=503, detail="Intent Classifier is not loaded.")

    try:
        user_text = request.text.strip()
        print(f"DEBUG: Analyzing intent for text: {user_text}")
        
        # 1. Use Embedding Model to find best matching intent
        intent, score = intent_classifier.predict(user_text)
        print(f"DEBUG: Embedding Prediction: Intent='{intent}', Score={score:.4f}")
        
        result = {
            "intent": intent, 
            "entities": {}
        }
        
        # 2. Extract Entities (Rule-based / Regex)
        # Ticket ID (Strongest Entity)
        ticket_pattern = r'(FIX-[A-Z0-9]{6})'
        ticket_match = re.search(ticket_pattern, user_text.upper())
        if ticket_match:
            ticket_id = ticket_match.group(1)
            print(f"DEBUG: Found Ticket ID: {ticket_id}")
            result["entities"]["ticket_id"] = ticket_id
            
            # If ticket found, highly likely 'vote_issue' or 'status'
            # If embedding said unknown or report, override to vote if context implies
            if result["intent"] == 'unknown':
                 result["intent"] = 'vote_issue'
        
        # Vote Type (Simple keywords)
        lower_text = user_text.lower()
        if "upvote" in lower_text or "up vote" in lower_text or "support" in lower_text:
             result["entities"]["vote_type"] = "upvote"
        elif "downvote" in lower_text or "down vote" in lower_text or "reject" in lower_text:
             result["entities"]["vote_type"] = "downvote"

        # Location extraction (Simple heuristics for now)
        # "trending in Freetown"
        loc_match = re.search(r'\b(?:in|at|near|around)\s+([a-zA-Z\s]+)', user_text, re.IGNORECASE)
        if loc_match:
            result["entities"]["location"] = loc_match.group(1).strip()
            
        print(f"DEBUG: Final Result: {result}")
        return result

    except Exception as e:
        print(f"DEBUG: Exception in analyze_intent: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
