const fs = require('fs');

// Fix modern-mediasync.js
let js = fs.readFileSync('modern-mediasync.js', 'utf8');

// 1. Add this._tPlayCall = performance.now(); in _startPlaying
js = js.replace(
  'this._testDriftLocked = false;',
  'this._testDriftLocked = false;\n    this._tPlayCall = performance.now();'
);

// 2. Fix _applyMicroAdjustment call in _syncLoop
js = js.replace(
  'this._applyMicroAdjustment(smoothedDrift);',
  'const elapsedSincePlay = performance.now() - this._tPlayCall;\n        this._applyMicroAdjustment(smoothedDrift, elapsedSincePlay);'
);

fs.writeFileSync('modern-mediasync.js', js);

// Fix test.html
let html = fs.readFileSync('test.html', 'utf8');

// 1. Fix rawDrift usage
html = html.replace(
  'rawDrift: rawDrift,',
  'rawDrift: sync.currentRawDrift,'
);

// 2. Fix syntax error (extra });)
html = html.replace(
  '            });\n            });\n            if (history.length > MAX_HISTORY) history.shift();',
  '            });\n            if (history.length > MAX_HISTORY) history.shift();'
);

fs.writeFileSync('test.html', html);
