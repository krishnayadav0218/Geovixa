const { execFile } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'ml', 'rank_relievers.py');

// Calls ml/rank_relievers.py with the given payload and returns its parsed "ranked" array,
// or null if Python/scikit-learn isn't available or the call fails for any reason — callers
// MUST treat null as "fall back to the pure-JS heuristic ranking", never as an error to
// surface to the user. This keeps the ML layer a pure enhancement: an environment without
// Python3 + scikit-learn installed still gets full Reliever Auto-Assign functionality, just
// via the simpler distance/attendance/shift/OT formula instead of the trained model.
function rankWithPython(payload, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      'python3',
      [SCRIPT_PATH],
      { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          console.warn('ML ranker unavailable, falling back to JS heuristic:', stderr.trim() || err.message);
          return resolve(null);
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) {
            console.warn('ML ranker returned an error, falling back to JS heuristic:', parsed.error);
            return resolve(null);
          }
          resolve(parsed.ranked || null);
        } catch (parseErr) {
          console.warn('ML ranker output was not valid JSON, falling back to JS heuristic:', parseErr.message);
          resolve(null);
        }
      }
    );
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

module.exports = { rankWithPython };
