"""
Flag photographs containing a child's face, so the bot can refuse to store them.

Two stages, deliberately:

  1. Find faces (NudeNet, already loaded for the nudity check -- it reports
     FACE_FEMALE / FACE_MALE boxes alongside everything else).
  2. Age-classify each cropped face with SigLIP2.

Classifying the whole photo in one pass -- which is what a bare age classifier
does -- is wrong here. Softmax always returns *some* age bucket, so a picture of
a pothole, a blocked drain or a dark street still comes back as "Adult 21-44" or
occasionally "Child 0-12" with a confident-looking score. Those photos are the
overwhelming majority of what citizens send, and rejecting them would break
reporting entirely. Gating on a detected face means an image with no people in
it is never flagged, which is the safe default for both the citizen and the
child.

A single image can also contain several people; each face is judged separately
and the image is flagged if any one of them is a child.
"""

import logging
import os
import time

logger = logging.getLogger("ai_service.minor")

MODEL_ID = os.environ.get("AGE_MODEL", "prithivMLmods/Age-Classification-SigLIP2")

# Label order is fixed by the model card.
LABELS = {
    0: "Child 0-12",
    1: "Teenager 13-20",
    2: "Adult 21-44",
    3: "Middle Age 45-64",
    4: "Aged 65+",
}
CHILD_IDX = 0

FACE_CLASSES = {"FACE_FEMALE", "FACE_MALE"}

# How sure NudeNet must be that a region is a face before it is age-classified.
FACE_CONFIDENCE = float(os.environ.get("MINOR_FACE_CONFIDENCE", "0.3"))
# How sure the age model must be before a face counts as a child.
AGE_CONFIDENCE = float(os.environ.get("MINOR_AGE_CONFIDENCE", "0.5"))
# Only the 0-12 bucket is flagged. The model's next bucket, 13-20, straddles the
# age of majority, so treating it as a minor would refuse photographs of legal
# adults -- a cost paid on every report for no safeguarding gain.

# Faces are cropped with a margin: the age signal lives in the whole head
# (hair, jaw, proportions), and a tight box loses it.
CROP_PADDING = 0.25


class MinorDetector:
    def __init__(self, model_id=None):
        self.model_id = model_id or MODEL_ID
        self.processor = None
        self.model = None

    def load(self):
        from transformers import AutoImageProcessor, SiglipForImageClassification

        logger.info(f"Loading age classifier '{self.model_id}'...")
        started = time.time()

        self.processor = AutoImageProcessor.from_pretrained(self.model_id)
        self.model = SiglipForImageClassification.from_pretrained(self.model_id)
        self.model.eval()

        logger.info(f"Age classifier loaded in {time.time() - started:.1f}s")

    @property
    def loaded(self):
        return self.model is not None and self.processor is not None

    def _classify_face(self, face_image):
        import torch

        inputs = self.processor(images=face_image, return_tensors="pt")
        with torch.no_grad():
            logits = self.model(**inputs).logits
            probs = torch.nn.functional.softmax(logits, dim=1).squeeze()

        index = int(torch.argmax(probs).item())
        return {
            "age_group": LABELS[index],
            "confidence": round(float(probs[index]), 4),
            "probabilities": {LABELS[i]: round(float(probs[i]), 4) for i in range(len(LABELS))},
            "_index": index,
        }

    def detect(self, image_path, nude_detector):
        """
        Returns a verdict for one image:
            { is_minor, faces_found, faces: [...], reason }

        `is_minor` false with `faces_found` 0 means "no face to judge" -- the
        common case for infrastructure photos -- not "checked and cleared".
        """
        from PIL import Image

        started = time.time()

        if not self.loaded:
            return {
                "is_minor": False,
                "faces_found": 0,
                "faces": [],
                "reason": "age classifier not loaded",
                "checked": False,
            }

        if nude_detector is None:
            return {
                "is_minor": False,
                "faces_found": 0,
                "faces": [],
                "reason": "face detector not loaded",
                "checked": False,
            }

        detections = nude_detector.detect(image_path) or []
        face_boxes = [
            d for d in detections
            if d.get("class") in FACE_CLASSES and d.get("score", 0) >= FACE_CONFIDENCE
        ]

        if not face_boxes:
            return {
                "is_minor": False,
                "faces_found": 0,
                "faces": [],
                "reason": "no faces detected",
                "checked": True,
                "processing_time_sec": round(time.time() - started, 3),
            }

        image = Image.open(image_path).convert("RGB")
        width, height = image.size

        faces = []
        is_minor = False

        for box in face_boxes:
            x, y, w, h = box["box"]
            pad_x, pad_y = w * CROP_PADDING, h * CROP_PADDING

            # Clamp to the image; NudeNet boxes can sit partly outside it.
            left = max(0, int(x - pad_x))
            top = max(0, int(y - pad_y))
            right = min(width, int(x + w + pad_x))
            bottom = min(height, int(y + h + pad_y))

            if right <= left or bottom <= top:
                continue

            result = self._classify_face(image.crop((left, top, right, bottom)))
            index = result.pop("_index")

            flagged = index == CHILD_IDX and result["confidence"] >= AGE_CONFIDENCE
            result["is_minor"] = flagged
            result["face_confidence"] = round(float(box.get("score", 0)), 4)
            faces.append(result)

            if flagged:
                is_minor = True

        elapsed = round(time.time() - started, 3)
        logger.info(
            f"Minor check: {len(faces)} face(s), is_minor={is_minor}, {elapsed}s"
        )

        return {
            "is_minor": is_minor,
            "faces_found": len(faces),
            "faces": faces,
            "reason": "child (0-12) detected" if is_minor else "no child detected",
            "checked": True,
            "processing_time_sec": elapsed,
        }
