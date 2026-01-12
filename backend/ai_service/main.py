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

# Load environment variables from backend/.env
# Get the directory of the current script
current_dir = os.path.dirname(os.path.abspath(__file__))
# Construct path to .env (parent of ai_service is backend)
env_path = os.path.join(current_dir, '..', '.env')
load_dotenv(env_path)

# Global variables
transcription_pipe = None
nude_detector = None
qwen_model = None
qwen_tokenizer = None
categories_list = []

QWEN_MODEL_ID = "Qwen/Qwen3-0.6B"

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
    global transcription_pipe, nude_detector, qwen_model, qwen_tokenizer, categories_list
    
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

    # --- Load Qwen Model ---
    print(f"Loading Qwen Model: {QWEN_MODEL_ID}...")
    try:
        # Get token from environment if needed
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_API_KEY")
        
        if not token:
            print("Warning: HF_TOKEN or HUGGINGFACE_API_KEY not found in environment. Model loading may fail if it is gated.")
        else:
            print("HF_TOKEN found in environment.")

        qwen_tokenizer = AutoTokenizer.from_pretrained(QWEN_MODEL_ID, token=token)
        qwen_model = AutoModelForCausalLM.from_pretrained(
            QWEN_MODEL_ID,
            torch_dtype="auto",
            device_map="cpu",  # Force CPU to avoid VRAM issues with Whisper
            token=token
        )
        print("Qwen model loaded successfully on CPU!")
    except Exception as e:
        print(f"Failed to load Qwen model: {e}")
        import traceback
        traceback.print_exc()

    yield
    
    # Cleanup
    del transcription_pipe
    del nude_detector
    del qwen_model
    del qwen_tokenizer
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
    Analyze an issue description using Qwen model.
    """
    global qwen_model, qwen_tokenizer, categories_list
    if qwen_model is None or qwen_tokenizer is None:
        raise HTTPException(status_code=503, detail="Qwen model is not loaded.")

    try:
        # Prepare the prompt
        user_description = request.description
        categories = request.categories
        
        # Use DB categories if not provided in request
        if not categories:
            if categories_list:
                categories = ", ".join(categories_list)
            else:
                categories = "Electricity, Water, Road, General"
        
        prompt = f'''Summarize the following description in 5 words max and determine which category the description belongs. 
Description: {user_description}
Categories: {categories}. 
Output should be a json format with the following keys: summary, category, urgency. 
Urgency should be one of: low, medium, high, critical.
No extra comments.'''
        
        messages = [
            {"role": "user", "content": prompt}
        ]
        
        text = qwen_tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False
        )
        
        model_inputs = qwen_tokenizer([text], return_tensors="pt").to(qwen_model.device)
        
        # Generate response
        generated_ids = qwen_model.generate(
            **model_inputs,
            max_new_tokens=512,
            temperature=0.7,
            do_sample=True
        )
        
        output_ids = generated_ids[0][len(model_inputs.input_ids[0]):].tolist()
        
        # Parse thinking content (if any)
        try:
            index = len(output_ids) - output_ids[::-1].index(151668)
        except ValueError:
            index = 0
        
        content = qwen_tokenizer.decode(output_ids[index:], skip_special_tokens=True).strip("\n")
        
        try:
            json_match = re.search(r'\{[^}]+\}', content)
            if json_match:
                result = json.loads(json_match.group())
            else:
                result = json.loads(content)
            
            summary = result.get("summary", user_description[:30])
            category = result.get("category", "Uncategorized")
            urgency = result.get("urgency", "medium").lower()
            
            if urgency not in ["low", "medium", "high", "critical"]:
                urgency = "medium"
            
            return {
                "summary": summary,
                "category": category,
                "urgency": urgency
            }
        except json.JSONDecodeError:
            return {
                "summary": user_description[:30] + ("..." if len(user_description) > 30 else ""),
                "category": "Uncategorized",
                "urgency": "medium"
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/analyze-intent")
def analyze_intent(request: AnalyzeIntentRequest):
    """
    Analyze user text to determine intent and extract entities using Qwen.
    """
    global qwen_model, qwen_tokenizer
    if qwen_model is None or qwen_tokenizer is None:
        raise HTTPException(status_code=503, detail="Qwen model is not loaded.")

    try:
        user_text = request.text
        print(f"DEBUG: Analyzing intent for text: {user_text}")
        
        prompt = f'''Analyze the text from a user interacting with a civic issue reporting bot. 
Determine the user's intent and extract relevant entities based on the guide below.

Intents & Entities:
1. registration
   - Entities: name (User's name)
2. report_issue
   - Entities: description (Issue details), location (Address or landmark)
3. vote_issue
   - Entities: ticket_id (Look for pattern FIX-XXXXXX), vote_type (upvote/downvote)
4. view_trending
   - Entities: location (Community or area name)
5. view_points
   - Entities: None
6. provide_feedback
   - Entities: feedback_text (The actual feedback content)
7. get_help
   - Entities: topic (What they need help with)
8. unknown
   - Entities: None

Output JSON with keys: 'intent' (string), 'entities' (object).
Return null for missing entities.

User Text: "{user_text}"
Output (JSON only):'''
        
        messages = [
            {"role": "user", "content": prompt}
        ]
        
        text = qwen_tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False
        )
        
        model_inputs = qwen_tokenizer([text], return_tensors="pt").to(qwen_model.device)
        
        generated_ids = qwen_model.generate(
            **model_inputs,
            max_new_tokens=256,
            temperature=0.3, # Lower temperature for consistency
            do_sample=True
        )
        
        output_ids = generated_ids[0][len(model_inputs.input_ids[0]):].tolist()
        
        # Parse thinking content (if any)
        try:
            index = len(output_ids) - output_ids[::-1].index(151668) # </think>
        except ValueError:
            index = 0
            
        content = qwen_tokenizer.decode(output_ids[index:], skip_special_tokens=True).strip("\n")
        print(f"DEBUG: Qwen Raw Response: {content}")
        
        # JSON extraction
        try:
            json_match = re.search(r'\{.*\}', content, re.DOTALL)
            if json_match:
                result = json.loads(json_match.group())
            else:
                result = json.loads(content)
        except Exception as e:
            print(f"DEBUG: JSON Parse Error: {e}")
            # Fallback
            result = {"intent": "unknown", "entities": {}}
        
        # Ensure entities is a dict (handle None from JSON)
        if result.get("entities") is None:
             result["entities"] = {}
        
        # --- Hybrid Fallback: Regex for structured entities ---
        # Even with Qwen, we keep this for guarantee
        
        # 1. Ticket ID fallback (FIX-XXXXXX)
        # Search anywhere in string, case insensitive for input but ensuring format
        ticket_pattern = r'(FIX-[A-Z0-9]{6})'
        ticket_match = re.search(ticket_pattern, user_text.upper())
        if ticket_match:
            ticket_id = ticket_match.group(1)
            print(f"DEBUG: Regex found Ticket ID: {ticket_id}")
            result["entities"]["ticket_id"] = ticket_id
            
            # If we found a ticket ID, the intent is likely vote_issue
            # We override if intent is unknown, chat, or even 'report_issue' if it lacks description but has ID
            current_intent = result.get("intent")
            if current_intent in ["unknown", "chat", None] or (current_intent == 'report_issue' and not result['entities'].get('description')):
                result["intent"] = "vote_issue"

        # 2. Vote Type fallback
        if result.get("intent") == "vote_issue":
            lower_text = user_text.lower()
            if "upvote" in lower_text or "up vote" in lower_text or "support" in lower_text:
                result["entities"]["vote_type"] = "upvote"
            elif "downvote" in lower_text or "down vote" in lower_text:
                result["entities"]["vote_type"] = "downvote"
        
        print(f"DEBUG: Final Analysis Result: {result}")
        return result

    except Exception as e:
        print(f"DEBUG: Exception in analyze_intent: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
