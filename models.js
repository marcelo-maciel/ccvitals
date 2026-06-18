'use strict';

// Detects context window size from model id bracket notation (e.g. opus[1m], sonnet[500k]).
// Falls back to 200k (Claude default) when no bracket suffix is present.
// If CC already provides `context_window.context_window_size`, prefer that via `fromInput`.
function detectContextSize(modelId, fromInput) {
  if (fromInput && Number.isFinite(fromInput) && fromInput > 0) return fromInput;
  const id = String(modelId || '').toLowerCase();
  const m = id.match(/\[(\d+)(k|m)\]/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return m[2] === 'm' ? n * 1_000_000 : n * 1_000;
  }
  return 200_000;
}

function formatContextLabel(size) {
  const k = Math.floor(size / 1000);
  return k >= 1000 ? `${Math.floor(k / 1000)}M` : `${k}k`;
}

module.exports = { detectContextSize, formatContextLabel };
