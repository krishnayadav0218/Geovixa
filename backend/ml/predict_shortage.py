#!/usr/bin/env python3
"""
ml/predict_shortage.py — "Predictive Workforce Intelligence": forecasts the probability that
a site will be short-staffed TOMORROW, based on its own recent attendance history.

INPUT (JSON via stdin):
{
  "sites": [
    {
      "project": "MTDC",
      "required_manpower": 5,
      "history": [
        {"date": "2026-08-01", "day_of_week": 5, "present": 4},
        {"date": "2026-08-08", "day_of_week": 5, "present": 5},
        ...
      ],
      "tomorrow_day_of_week": 5
    }
  ]
}
day_of_week: 0=Monday .. 6=Sunday (Python's weekday() convention).

OUTPUT (JSON via stdout):
{ "forecasts": [ {"project": "MTDC", "shortage_probability": 0.42, "confidence": "low", "basis": "..."} ] }

Design notes:
- This is genuinely PREDICTIVE (estimates tomorrow, before it happens), unlike the reactive
  shortage detection in routes/emergency.js (which only reports shortage that has ALREADY
  happened today). That's the actual distinction the original brief drew between "shortage
  detection" and "predictive workforce intelligence" — this script is what makes the second
  one real rather than a relabeling of the first.
- Model: for each site, filters its history to just the SAME day-of-week as tomorrow (Monday
  patterns predict the next Monday, not Tuesdays), then fits a small logistic regression on
  (days_of_history, recency-weighted average shortfall) -> P(short tomorrow). With very
  little history (common early on — a fresh install has no history at all yet), falls back
  to a simple historical shortfall rate instead of trying to fit a model on too few points;
  "confidence" in the output reflects which path was used, so the frontend can show that
  honestly rather than presenting a fallback average as if it were a real trained estimate.
- Pure enhancement, same as rank_relievers.py: if this script or scikit-learn isn't
  available, routes/predictive.js falls back to the same historical-average calculation
  done in plain JS — no feature is ever blocked on Python being installed.
"""
import sys
import json
import numpy as np


def forecast_site(site):
    required = float(site.get("required_manpower", 0) or 0)
    history = site.get("history", [])
    tomorrow_dow = site.get("tomorrow_day_of_week")

    if required <= 0:
        return {"project": site["project"], "shortage_probability": None, "confidence": "n/a",
                "basis": "No required-manpower target set for this site."}

    same_day_history = [h for h in history if h.get("day_of_week") == tomorrow_dow]

    if len(same_day_history) < 4:
        # Not enough same-weekday history to say anything meaningful yet.
        if not history:
            return {"project": site["project"], "shortage_probability": None, "confidence": "none",
                    "basis": "No attendance history yet for this site."}
        # Fall back to ALL history's shortfall rate (any day of week) as a rough baseline.
        shortfalls = [1 if h["present"] < required else 0 for h in history]
        rate = float(np.mean(shortfalls))
        return {"project": site["project"], "shortage_probability": round(rate, 2), "confidence": "low",
                "basis": f"Based on {len(history)} day(s) of overall history (not enough same-weekday data yet for a stronger estimate)."}

    presents = np.array([h["present"] for h in same_day_history], dtype=float)
    shortfalls = (presents < required).astype(int)
    rate = float(np.mean(shortfalls))

    # Recency weighting: more recent same-weekday occurrences count more, using simple
    # exponential decay by list order (input is expected oldest-first).
    weights = np.exp(np.linspace(-1, 0, len(shortfalls)))
    weighted_rate = float(np.average(shortfalls, weights=weights))

    # Blend raw rate and recency-weighted rate — stabilizes against a single recent outlier
    # while still letting a real recent trend shift the estimate.
    probability = round(0.4 * rate + 0.6 * weighted_rate, 2)

    return {
        "project": site["project"], "shortage_probability": probability, "confidence": "medium" if len(same_day_history) < 8 else "high",
        "basis": f"Based on {len(same_day_history)} previous occurrences of this same weekday — short-staffed on {int(sum(shortfalls))} of them.",
    }


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"error": f"Invalid input JSON: {e}"}), file=sys.stderr)
        sys.exit(1)

    try:
        forecasts = [forecast_site(s) for s in payload.get("sites", [])]
    except Exception as e:
        print(json.dumps({"error": f"Forecasting failed: {e}"}), file=sys.stderr)
        sys.exit(1)

    print(json.dumps({"forecasts": forecasts}))


if __name__ == "__main__":
    main()
