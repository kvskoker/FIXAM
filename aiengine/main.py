from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModelForCausalLM
import torch
import uvicorn
import os
from contextlib import asynccontextmanager

# Global variables
model = None
tokenizer = None
MODEL_ID = "google/gemma-3-270m-it"

class AnalysisRequest(BaseModel):
    input_text: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, tokenizer
    print(f"Loading model: {MODEL_ID}...")
    try:
        tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
        model = AutoModelForCausalLM.from_pretrained(MODEL_ID)
        # Explicitly move to CPU (though usually default)
        model.to("cpu")
        print("Model loaded successfully on CPU.")
    except Exception as e:
        print(f"Error loading model: {e}")
        print("Please ensure you have access to the model and a valid Hugging Face token if required.")
    yield
    # Clean up resources if needed
    print("Shutting down...")

app = FastAPI(title="Lightweight AI Service", lifespan=lifespan)


@app.post("/analyze")
def analyze_text(request: AnalysisRequest):
    global model, tokenizer
    if model is None or tokenizer is None:
        raise HTTPException(status_code=503, detail="Model is not loaded. Check server logs.")

    try:
        messages = [
            {"role": "user", "content": request.input_text},
        ]
        
        inputs = tokenizer.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        ).to(model.device)

        # Generate response
        # Using no_grad for inference to save memory and computation
        with torch.no_grad():
            outputs = model.generate(**inputs, max_new_tokens=200)

        # Decode the output, skipping the input prompt
        response = tokenizer.decode(outputs[0][inputs["input_ids"].shape[-1]:], skip_special_tokens=True)
        
        return {"response": response}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    print("Starting AI Service on port 9000...")
    uvicorn.run(app, host="0.0.0.0", port=9000)
