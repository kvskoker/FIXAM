import logging
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from asr import create_engine
from minor_detector import MinorDetector
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

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ai_service")


# Load environment variables from backend/.env
# Get the directory of the current script
current_dir = os.path.dirname(os.path.abspath(__file__))
# Construct path to .env (parent of ai_service is backend)
env_path = os.path.join(current_dir, '..', '.env')
load_dotenv(env_path)

# Global variables
asr_engine = None
nude_detector = None
minor_detector = None
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
    global asr_engine, nude_detector, minor_detector, categories_list, intent_classifier
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

    # --- Load speech-to-text engine (Parakeet, see asr.py) ---
    engine = create_engine()
    print(f"Loading speech-to-text engine: {engine.name} ({engine.model_name})")
    try:
        engine.load()
        asr_engine = engine
        print(f"{engine.name} loaded successfully!")
    except Exception as e:
        # Transcription is degraded, not fatal: the bot stores voice notes and
        # keeps taking reports, so do not stop the rest of the service loading.
        print(f"Failed to load {engine.name}: {type(e).__name__}: {e}".strip())
        asr_engine = None

    # --- Load NudeNet ---
    print("Loading NudeNet detector...")
    try:
        nude_detector = NudeDetector()
        print("NudeNet detector loaded successfully!")
    except Exception as e:
        print(f"Failed to load NudeNet detector: {type(e).__name__}: {e}".strip())

    # --- Load age classifier (child-safeguarding check) ---
    if os.environ.get("MINOR_DETECTION_ENABLED", "true").lower() == "true":
        print("Loading age classifier...")
        try:
            detector = MinorDetector()
            detector.load()
            minor_detector = detector
            print("Age classifier loaded successfully!")
        except Exception as e:
            print(f"Failed to load age classifier: {type(e).__name__}: {e}".strip())
            minor_detector = None
    else:
        print("Age classifier disabled (MINOR_DETECTION_ENABLED=false)")
        minor_detector = None

    yield

    # Cleanup
    del asr_engine
    del nude_detector
    del minor_detector
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

app = FastAPI(lifespan=lifespan)


@app.get("/")
@app.get("/health")
def health():
    """
    What is actually loaded, so a caller can tell "starting up" from "broken".

    Every model here loads independently and is allowed to fail without taking
    the service down -- the bot degrades rather than stops. That means a 200
    from this endpoint is not enough on its own: check the individual flags.

    `ready` is true only when the pieces the bot depends on are all up.
    """
    asr_ready = asr_engine is not None
    nudenet_ready = nude_detector is not None
    intent_ready = intent_classifier is not None and intent_classifier.model is not None
    minor_ready = minor_detector is not None and minor_detector.loaded
    minor_enabled = os.environ.get("MINOR_DETECTION_ENABLED", "true").lower() == "true"

    # ffmpeg/ffprobe are what decode uploads and measure duration; without them
    # transcription fails for every format while the model looks perfectly fine.
    def _has(binary):
        try:
            subprocess.run([binary, "-version"], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=True)
            return True
        except Exception:
            return False

    ffmpeg_ready = _has("ffmpeg")
    ffprobe_ready = _has("ffprobe")

    return {
        "status": "ok",
        # A safeguarding model that failed to load must not read as healthy:
        # the bot refuses every photo in that state, and an operator watching
        # a green light would have no idea why reporting had stopped.
        "ready": asr_ready and intent_ready and ffmpeg_ready and (minor_ready or not minor_enabled),
        "models": {
            "speech_to_text": {
                "loaded": asr_ready,
                "engine": asr_engine.name if asr_ready else None,
                "model": asr_engine.model_name if asr_ready else os.environ.get(
                    "PARAKEET_MODEL", "nvidia/parakeet-tdt-0.6b-v3"),
            },
            "image_safety": {"loaded": nudenet_ready, "model": "nudenet"},
            "minor_detection": {
                "loaded": minor_ready,
                "model": minor_detector.model_id if minor_ready else None,
                "enabled": minor_enabled,
            },
            "intent_classifier": {"loaded": intent_ready, "categories": len(categories_list)},
        },
        "media_tools": {"ffmpeg": ffmpeg_ready, "ffprobe": ffprobe_ready},
        "endpoints": {
            "POST /transcribe": "audio file -> text",
            "POST /check-duration": "audio/video file -> duration in seconds",
            "POST /classify-image": "image file -> safe|nude",
            "POST /detect-minor": "image file -> is_minor, per-face age groups",
            "POST /analyze-issue": "{description, categories} -> {summary, category, urgency}",
            "POST /analyze-intent": "{text} -> {intent, entities}",
        },
    }


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
        _require_readable_image(tmp_path)
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
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

def _require_readable_image(path):
    """
    Reject anything that is not a decodable image with a clear 400.

    Both detectors hand the path to OpenCV, which returns None for a file it
    cannot decode and then fails deep inside with "'NoneType' object has no
    attribute 'shape'" -- a 500 that tells the caller nothing.
    """
    from PIL import Image
    try:
        with Image.open(path) as img:
            img.verify()
    except Exception:
        raise HTTPException(status_code=400, detail="File is not a readable image.")


@app.post("/detect-minor")
def detect_minor(image: UploadFile = File(...)):
    """
    Child-safeguarding check: is there a child's face in this photo?

    Faces are located first and each one is age-classified separately. An image
    with no face in it -- a pothole, a blocked drain, a dark street, which is
    nearly everything citizens send -- comes back is_minor=false without the age
    model ever running.

    Returns 503 rather than a cleared verdict when the check cannot be
    performed, so a caller is never told an unchecked image is safe.
    """
    if minor_detector is None or not minor_detector.loaded:
        raise HTTPException(status_code=503, detail="Age classifier is not loaded.")
    if nude_detector is None:
        raise HTTPException(status_code=503, detail="Face detector is not loaded.")

    suffix = f".{image.filename.split('.')[-1]}" if '.' in image.filename else ".jpg"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(image.file, tmp)
        tmp_path = tmp.name

    try:
        _require_readable_image(tmp_path)
        result = minor_detector.detect(tmp_path, nude_detector)
        result["filename"] = image.filename
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.post("/transcribe")
def transcribe_audio(file: UploadFile = File(...)):
    if not asr_engine:
        raise HTTPException(status_code=500, detail="Speech-to-text model is not loaded.")

    suffix = f".{file.filename.split('.')[-1]}" if '.' in file.filename else ".ogg"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        result = asr_engine.transcribe(tmp_path)
        return {
            "filename": file.filename,
            "text": result["text"],
            # 0..1, or null when the decoder could not report one. Null is not
            # zero: the caller must be able to tell "unsure" from "not measured".
            "confidence": result.get("confidence"),
            "duration_sec": result.get("duration_sec"),
            "engine": asr_engine.name,
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
        
        # 4. Generate Summary using Smart Regex Heuristics
        # Note: Summa (TextRank) often fails on short, conversational texts.
        # We use a robust cleaning approach instead.
        
        summary = user_description.strip()
        
        # Step A: Remove conversational fillers at the start (Iterative)
        # e.g. "Yeah, so...", "Hello, I want...", "Ok, there is..."
        fillers = [
            r"^(?:yeah|yep|yes|ok|okay|so|well|actually|basically|please|kindly)[,.]?\s+",
            r"^(?:hello|hi|hey|good\s+morning|good\s+afternoon|good\s+evening)[,.]?\s+",
            r"^(?:i\s+think|i\s+feel|i\s+believe)[,.]?\s+" 
        ]
        
        for _ in range(3): # Run a few times to catch "Yeah, so, basically..."
            cleaned = False
            for f in fillers:
                if re.search(f, summary, re.IGNORECASE):
                    summary = re.sub(f, "", summary, count=1, flags=re.IGNORECASE)
                    cleaned = True
            if not cleaned:
                break
        
        # Step B: Identify the "Core" sentence
        # We split by common sentence terminators.
        sentences = re.split(r'[.!?\n]', summary)
        if sentences:
            summary = sentences[0].strip()
            
        # Step C: Extract "Matter" from "Intro" phrases
        # e.g. "I want to report X" -> "X"
        # e.g. "There is a X" -> "X"
        intro_patterns = [
            r"^(?:i\s+want\s+to|i'd\s+like\s+to|i\s+am)\s+(?:report|reporting|complain\s+about)\s+(?:a\s+|an\s+|the\s+)?",
            r"^(?:can\s+you|please|kindly)\s+(?:come\s+and\s+)?(?:fix|repair|look\s+at)\s+(?:a\s+|an\s+|the\s+)?",
            r"^(?:there\s+is|there's|we\s+have|it's)\s+(?:a\s+|an\s+|the\s+)?",
            r"^(?:report\s+of|issue\s+with|problem\s+with)\s+(?:a\s+|an\s+|the\s+)?"
        ]
        
        for p in intro_patterns:
            match = re.search(p, summary, re.IGNORECASE)
            if match:
                # Replace the start with empty string
                summary = re.sub(p, "", summary, count=1, flags=re.IGNORECASE)
                break # Only strip one major intro

        # Step D: Suffix/Explanation Cleaning (Existing logic, refined)
        suffixes = [
            r"\s+that needs\s+.*",
            r"\s+which needs\s+.*",
            r"\s+that\s+(?:is|has\s+been)\s+.*",
            r"\s+which\s+(?:is|has\s+been)\s+.*",
            r"\s+causing\s+.*",
            r"\s+resulting\s+in\s+.*",
            r"\s+because\s+.*",
            r"\s+since\s+.*",
            r"\s+for\s+the\s+past\s+.*",            
            r"\s+and\s+it.*",
            r"\s+and\s+we.*" 
        ]
        
        for s in suffixes:
            summary = re.sub(s, "", summary, count=1, flags=re.IGNORECASE)

        summary = summary.strip()

        # Step E: Formatting
        if summary:
            summary = summary[0].upper() + summary[1:]
             
        # Step F: Final Truncation
        # "Leaking water pipe at Juba" -> 5 words. Perfect.
        words = summary.split()
        if len(words) > 10:
            summary = " ".join(words[:10]) + "..."
            
        if not summary:
             summary = user_description[:30] + "..."

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
        logger.info("Analyzing intent for text: %s", user_text)
        
        # 1. Use Embedding Model to find best matching intent
        intent, score = intent_classifier.predict(user_text)
        logger.info("Embedding Prediction: Intent='%s', Score=%.4f", intent, score)
        
        result = {
            "intent": intent, 
            "entities": {}
        }
        
        # Ticket ID Extraction (Improved to handle missing prefix)
        # Matches FIX-G9IJIY or just G9IJIY (but only if it looks like a ticket ID)
        ticket_pattern = r'\b(?:FIX-)?([A-Z0-9]{6})\b'
        ticket_match = re.search(ticket_pattern, user_text.upper())
        if ticket_match:
            ticket_id = f"FIX-{ticket_match.group(1)}"
            logger.info("Found Ticket ID: %s", ticket_id)
            result["entities"]["ticket_id"] = ticket_id
            
            # Contextual Intent Override
            tracking_keywords = ["status", "track", "follow", "endorse", "check", "happen", "far"]
            if any(kw in lower_text for kw in tracking_keywords):
                 result["intent"] = 'track_status'
            elif result["intent"] == 'unknown':
                 # If it's just a ticket ID alone, let the handler decide based on current state
                 # By returning 'unknown' here but including the ticket_id, the handler
                 # can prioritize the 'awaiting_track_ticket_id' state if it's active.
                 # However, if we must pick one, vote is a safe default for NEW conversations.
                 result["intent"] = 'unknown' # Let JS Handler handle the state-based logic
        
        # Vote Type (Simple keywords)
        if "upvote" in lower_text or "up vote" in lower_text or "support" in lower_text:
             result["entities"]["vote_type"] = "upvote"
        elif "downvote" in lower_text or "down vote" in lower_text or "reject" in lower_text:
             result["entities"]["vote_type"] = "downvote"

        # Location extraction (Simple heuristics for now)
        loc_match = re.search(r'\b(?:in|at|near|around)\s+([a-zA-Z\s]{3,})', user_text, re.IGNORECASE)
        if loc_match:
            result["entities"]["location"] = loc_match.group(1).strip()
            
        logger.info("Final Result: %s", result)
        return result

    except Exception as e:
        logger.error("Exception in analyze_intent: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
