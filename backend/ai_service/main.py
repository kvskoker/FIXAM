import torch
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
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
import google.generativeai as genai

# Load environment variables from backend/.env
# Get the directory of the current script
current_dir = os.path.dirname(os.path.abspath(__file__))
# Construct path to .env (parent of ai_service is backend)
env_path = os.path.join(current_dir, '..', '.env')
load_dotenv(env_path)

# Global variables
transcription_pipe = None
nude_detector = None
gemini_model = None
categories_list = []

# Model Configuration
# Model Configuration
GEMINI_MODEL_ID = "gemini-1.5-flash"

# ... (rest of code)

@app.post("/analyze-intent")
def analyze_intent(request: AnalyzeIntentRequest):
    """
    Analyze user text to determine intent and extract entities using Gemini.
    """
    global gemini_model
    if gemini_model is None:
        raise HTTPException(status_code=503, detail="Gemini model is not configured.")

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
        
        response = gemini_model.generate_content(prompt)
        content = response.text.strip()
        print(f"DEBUG: Gemini Raw Response: {content}")
        
        # Cleanup Markdown
        content = content.replace("```json", "").replace("```", "").strip()
        
        try:
            result = json.loads(content)
        except Exception as e:
            print(f"DEBUG: JSON Parse Error: {e}")
            # Fallback
            result = {"intent": "unknown", "entities": {}}
        
        # Ensure entities is a dict (handle None from JSON)
        if result.get("entities") is None:
             result["entities"] = {}
        
        # --- Hybrid Fallback: Regex for structured entities ---
        # Even with Gemini, we keep this for guarantee
        
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

