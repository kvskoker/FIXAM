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

QWEN_MODEL_ID = "Qwen/Qwen3-0.6B"

class AnalysisRequest(BaseModel):
    input_text: str

class AnalyzeIssueRequest(BaseModel):
    description: str
    categories: Optional[str] = "Electricity, Water, Road, Transportation, Drainage, Waste, Housing & Urban Development, Telecommunications, Internet, Health Services, Education Services, Public Safety, Security, Fire Services, Social Welfare, Environmental Pollution, Deforestation, Animal Control, Public Space Maintenance, Disaster Management, Corruption, Accountability, Local Taxation, Streetlights, Bridges or Culverts, Public Buildings, Sewage or Toilet Facilities, Traffic Management, Road Safety, Youth Engagement, Gender-Based Violence, Child Protection, Disability Access, Market Operations, Service Access"

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
    global transcription_pipe, nude_detector, qwen_model, qwen_tokenizer
    
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

import subprocess

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
    Returns: {
        "summary": "5 word max summary",
        "category": "detected category",
        "urgency": "low|medium|high|critical"
    }
    """
    global qwen_model, qwen_tokenizer
    if qwen_model is None or qwen_tokenizer is None:
        raise HTTPException(status_code=503, detail="Qwen model is not loaded.")

    try:
        # Prepare the prompt
        user_description = request.description
        categories = request.categories
        
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
            enable_thinking=False  # Switches between thinking and non-thinking modes
        )
        
        model_inputs = qwen_tokenizer([text], return_tensors="pt").to(qwen_model.device)
        
        # Generate response
        generated_ids = qwen_model.generate(
            **model_inputs,
            max_new_tokens=512,  # Reduced from 32768 for faster response
            temperature=0.7,
            do_sample=True
        )
        
        output_ids = generated_ids[0][len(model_inputs.input_ids[0]):].tolist()
        
        # Parse thinking content (if any)
        try:
            # rindex finding 151668 (</think>)
            index = len(output_ids) - output_ids[::-1].index(151668)
        except ValueError:
            index = 0
        
        content = qwen_tokenizer.decode(output_ids[index:], skip_special_tokens=True).strip("\n")
        
        # Try to extract JSON from the response
        try:
            # Look for JSON pattern in the response
            json_match = re.search(r'\{[^}]+\}', content)
            if json_match:
                result = json.loads(json_match.group())
            else:
                # If no JSON found, try to parse the entire content
                result = json.loads(content)
            
            # Validate and normalize the response
            summary = result.get("summary", user_description[:30])
            category = result.get("category", "Uncategorized")
            urgency = result.get("urgency", "medium").lower()
            
            # Ensure urgency is valid
            if urgency not in ["low", "medium", "high", "critical"]:
                urgency = "medium"
            
            return {
                "summary": summary,
                "category": category,
                "urgency": urgency
            }
        except json.JSONDecodeError:
            # Fallback if JSON parsing fails
            return {
                "summary": user_description[:30] + ("..." if len(user_description) > 30 else ""),
                "category": "Uncategorized",
                "urgency": "medium"
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
