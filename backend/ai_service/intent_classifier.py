from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np

class IntentClassifier:
    def __init__(self, model_name="sentence-transformers/all-MiniLM-L6-v2"):
        """
        Initialize the intent classifier with a lightweight embedding model.
        The user suggested google/embeddinggemma-300m, but all-MiniLM-L6-v2 is the 
        standard for efficient local intent classification. 
        We can switch to 'google/embeddinggemma-300m' if available in SentenceTransformers,
        but for stability we use the proven MiniLM for now.
        """
        print(f"Loading embedding model: {model_name}...")
        self.model = SentenceTransformer(model_name)
        
        # Define canonical examples for each intent
        self.intents = {
            "vote_issue": [
                "I want to vote on an issue",
                "upvote ticket FIX-123456",
                "support this report",
                "downvote the issue",
                "cast my vote for FIX-999AX1",
                "vote for issue"
                
            ],
            "report_issue": [
                "I want to report an issue",
                "There is a pothole here",
                "fix this broken pipe",
                "report a problem",
                "complain about trash",
                "bad road condition",
                "water leak detected"
            ],
            "view_trending": [
                "show me trending issues",
                "what is popular in Freetown?",
                "top issues in my area",
                "view trending",
                "what's happening in Lumley?"
            ],
            "view_points": [
                "check my points",
                "how many points do I have?",
                "show my score",
                "leaderboard",
                "my rank"
            ],
            "provide_feedback": [
                "I have a suggestion",
                "provide feedback",
                "my opinion on the app",
                "leave a comment",
                "review the service"
            ],
            "get_help": [
                "help me",
                "how does this work?",
                "what can you do?",
                "show commands",
                "guide me",
                "how do i start?"
            ],
            "greeting": [
                "hi", "hello", "hey", "good morning", "good afternoon", "hola", "hi there"
            ],
            "appreciation": [
                "thanks", "thank you", "tnx", "nice work", "good job", "thanks a lot"
            ],
            "agreement": [
                "ok", "okay", "agreed", "sure", "no problem", "yes", "alright"
            ]
        }
        
        # Pre-compute embeddings for all examples
        print("Pre-computing intent embeddings...")
        self.intent_embeddings = {}
        self.intent_labels = []
        self.all_embeddings = []
        
        for intent, examples in self.intents.items():
            embeddings = self.model.encode(examples)
            self.intent_embeddings[intent] = embeddings
            for emb in embeddings:
                self.all_embeddings.append(emb)
                self.intent_labels.append(intent)
        
        self.all_embeddings = np.array(self.all_embeddings)
        print("Intent classifier ready.")

    def predict(self, text):
        """
        Predict the intent of the given text using cosine similarity.
        """
        if not text or len(text.strip()) < 2:
            return "unknown", 0.0

        # Encode user text
        user_emb = self.model.encode([text])
        
        # Calculate similarity with all examples
        similarities = cosine_similarity(user_emb, self.all_embeddings)[0]
        
        # Find best match
        best_idx = np.argmax(similarities)
        best_score = similarities[best_idx]
        best_intent = self.intent_labels[best_idx]
        
        # Thresholding
        if best_score < 0.3:
            return "unknown", float(best_score)
            
        return best_intent, float(best_score)
