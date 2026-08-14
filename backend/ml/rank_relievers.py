#!/usr/bin/env python3
"""
ml/rank_relievers.py — the actual "which nearby free employee should cover this shortage"
brain behind Reliever Auto-Assign, upgraded from a hand-rolled distance loop to real
spatial ML (scikit-learn NearestNeighbors with a haversine metric) plus a trained scoring
model (LogisticRegression) that combines distance with attendance reliability, shift
coverage, and OT eligibility into a single 0-1 "fitness probability" per candidate.

INPUT  (JSON via stdin):
{
  "site": {"lat": 19.07, "lng": 72.87},
  "candidates": [
    {"employee_id": "E4", "name": "Vikram", "lat": 19.071, "lng": 72.871,
     "attendance_30d_pct": 80, "ot_hours_7d": 2, "has_shift": true, "is_live_location": true}
  ],
  "weekly_ot_ceiling_hours": 20
}

OUTPUT (JSON via stdout):
{
  "ranked": [
    {"employee_id": "E4", "distance_km": 0.15, "ml_score": 0.87, "rank": 1}
  ]
}

Design notes (read this before touching the model):
- NearestNeighbors(metric='haversine') does the actual "who's geographically closest" work —
  this is a real spatial index, not a manual loop recomputing haversine by hand (which is
  what the pure-JS fallback in routes/reliever.js still does when Python isn't available —
  see USE_PYTHON_RANKER in that file). scikit-learn's haversine metric expects radians and
  returns distances in radians, converted back to km via EARTH_RADIUS_KM below.
- The LogisticRegression scorer is trained HERE, at call time, on a small SYNTHETIC dataset
  built from reasonable domain assumptions (closer + more reliable attendance + lower recent
  OT + has a shift on file => more likely to be a good reliever pick). There is no real
  historical "did this assignment work out" outcome data in this system yet to train on
  honestly — that's a real limitation, not hidden: once reliever_assignments accumulates
  enough completed/accepted-vs-rejected history, swap generate_synthetic_training_data() for
  a query against that table and retrain on real outcomes instead.
- Runs as a single stdin->stdout process per call (invoked via child_process from Node) rather
  than a long-running service, since ranking calls are infrequent (a few per shortage, every
  few minutes at most) and this keeps the Node app's only dependency on Python being present
  at call time, with zero persistent process to manage or crash.
"""
import sys
import json
import numpy as np
from sklearn.neighbors import NearestNeighbors
from sklearn.linear_model import LogisticRegression

EARTH_RADIUS_KM = 6371.0


def generate_synthetic_training_data(n=400, seed=42):
    """Builds a synthetic labeled dataset to train the fitness-scoring model on, since no
    real historical accept/reject outcome data exists yet (see module docstring). Each
    sample is (distance_km, attendance_pct, ot_hours_7d, has_shift) -> label (1 = good pick).
    The labeling rule below encodes the same domain assumptions the old pure-JS scoring used
    (close + reliable + not already close to their OT cap + has a shift on file is "good"),
    plus random noise so the model learns a soft boundary rather than memorizing a hard rule.
    """
    rng = np.random.default_rng(seed)
    distance_km = rng.exponential(scale=4.0, size=n).clip(0, 25)
    attendance_pct = rng.uniform(0, 100, size=n)
    ot_hours = rng.uniform(0, 25, size=n)
    has_shift = rng.integers(0, 2, size=n)

    score = (
        (1 - distance_km / 25) * 0.40
        + (attendance_pct / 100) * 0.30
        + (1 - np.clip(ot_hours, 0, 20) / 20) * 0.15
        + has_shift * 0.15
    )
    noise = rng.normal(0, 0.08, size=n)
    labels = (score + noise > 0.5).astype(int)

    X = np.column_stack([distance_km, attendance_pct, ot_hours, has_shift])
    return X, labels


def train_scoring_model():
    X, y = generate_synthetic_training_data()
    model = LogisticRegression()
    model.fit(X, y)
    return model


def rank(payload):
    site = payload["site"]
    candidates = payload.get("candidates", [])
    weekly_ot_ceiling = float(payload.get("weekly_ot_ceiling_hours", 20) or 20)

    if not candidates:
        return {"ranked": []}

    # --- Spatial nearest-neighbor search (real ML/algorithm library, not a hand loop) ---
    site_rad = np.radians([[site["lat"], site["lng"]]])
    cand_coords = np.array([[c["lat"], c["lng"]] for c in candidates])
    cand_rad = np.radians(cand_coords)

    nn = NearestNeighbors(n_neighbors=len(candidates), metric="haversine")
    nn.fit(cand_rad)
    distances_rad, indices = nn.kneighbors(site_rad)
    distances_km = distances_rad[0] * EARTH_RADIUS_KM
    # indices[0] tells us the ORDER candidates were returned in (nearest-first) — map that
    # back to each candidate's own distance so we can still score every candidate below.
    distance_by_index = {}
    for rank_pos, idx in enumerate(indices[0]):
        distance_by_index[int(idx)] = float(distances_km[rank_pos])

    # --- Trained fitness-probability scorer ---
    model = train_scoring_model()
    feature_rows = []
    for i, c in enumerate(candidates):
        feature_rows.append([
            distance_by_index[i],
            float(c.get("attendance_30d_pct", 0) or 0),
            float(c.get("ot_hours_7d", 0) or 0),
            1.0 if c.get("has_shift") else 0.0,
        ])
    X = np.array(feature_rows)
    probabilities = model.predict_proba(X)[:, 1]  # P(good reliever pick)

    ranked = []
    for i, c in enumerate(candidates):
        ranked.append({
            "employee_id": c["employee_id"],
            "distance_km": round(distance_by_index[i], 2),
            "ml_score": round(float(probabilities[i]) * 100, 1),  # 0-100 for easy display alongside the old 0-100 score
            "is_live_location": bool(c.get("is_live_location")),
        })
    ranked.sort(key=lambda r: r["ml_score"], reverse=True)
    for i, r in enumerate(ranked):
        r["rank"] = i + 1

    return {"ranked": ranked}


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"error": f"Invalid input JSON: {e}"}), file=sys.stderr)
        sys.exit(1)

    try:
        result = rank(payload)
    except Exception as e:
        print(json.dumps({"error": f"Ranking failed: {e}"}), file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
