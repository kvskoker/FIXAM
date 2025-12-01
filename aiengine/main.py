from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModel
import torch
import uvicorn
import os
from contextlib import asynccontextmanager

# Global variables
model = None
tokenizer = None
MODEL_ID = "google/embeddinggemma-300m"

from typing import List

class AnalysisRequest(BaseModel):
    input_text: str

class ClassifyRequest(BaseModel):
    text: str
    candidate_labels: List[str]


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, tokenizer
    print(f"Loading model: {MODEL_ID}...")
    try:
        tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
        model = AutoModel.from_pretrained(MODEL_ID)
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
        # Tokenize input
        inputs = tokenizer(request.input_text, return_tensors="pt", padding=True, truncation=True)
        inputs = inputs.to(model.device)

        # Generate embeddings
        with torch.no_grad():
            outputs = model(**inputs)
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
    global model, tokenizer
    if model is None or tokenizer is None:
        raise HTTPException(status_code=503, detail="Model is not loaded. Check server logs.")

    try:
        # Prepare texts: first is the query, rest are candidates
        all_texts = [request.text] + request.candidate_labels
        
        # Tokenize batch
        inputs = tokenizer(all_texts, return_tensors="pt", padding=True, truncation=True)
        inputs = inputs.to(model.device)
        
        with torch.no_grad():
            outputs = model(**inputs)
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
    print("Starting AI Service on port 9000...")
    uvicorn.run(app, host="0.0.0.0", port=9000)
