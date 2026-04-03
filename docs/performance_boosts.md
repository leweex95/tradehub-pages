# TradeHub Performance Optimizations

This document tracks performance improvements made to TradeHub's backtest engine.

## Summary

| Optimization | Before | After | Improvement |
|--------------|--------|-------|-------------|
| Pre-compute global peaks | 0.944s | 0.599s | **37% faster** |
| Bisect-based peak filtering | 0.599s | 0.404s | **32% faster** |
| **Total improvement** | 0.944s | 0.404s | **57% faster** |

*Measurements on 14,400 bar (10 day M1) EURUSD backtest*

---

## Optimization 1: Pre-compute Global Peaks

**Date:** 2026-02-22  
**Impact:** 37% reduction in backtest time

### Problem

The backtest hot loop calls `detect_arrays()` every `scan_interval` bars (default 15). Each call recomputes peak/trough detection using `scipy.signal.find_peaks()` on the current window slice.

For a 14,400 bar dataset with lookback=300 and scan_interval=15:
- Number of scans: (14,400 - 300) / 15 ≈ **940 calls**
- Each call runs `find_peaks_scipy()` on a 300-bar window
- Total time in `find_peaks_scipy`: **0.248s** (26% of backtest time)

### Solution

Pre-compute peaks/troughs **once** for the full dataset at the start of the backtest, then filter to each window slice during the hot loop.

**Implementation:**

1. Added `GlobalPeaks` dataclass to cache pre-computed peaks:
   ```python
   @dataclass
   class GlobalPeaks:
       peak_indices: List[int]     # indices in full array
       trough_indices: List[int]   # indices in full array
       mean_atr: float
   ```

2. Added `FormationDetector.precompute_peaks()` method that computes peaks once on the full dataset.

3. Added `FormationDetector.detect_arrays_cached()` that accepts pre-computed peaks and filters them to the window.

4. Updated `Backtester.run()` to call `precompute_peaks()` once before the main loop.

**Files changed:**
- [formations.py](../src/tradehub/analysis/formations.py) - Added GlobalPeaks, precompute_peaks(), detect_arrays_cached()
- [backtester.py](../src/tradehub/backtest/backtester.py) - Pre-compute peaks before loop, use cached version

---

## Optimization 2: Bisect-based Peak Filtering

**Date:** 2026-02-22  
**Impact:** 32% additional reduction (57% total)

### Problem

Initial `detect_arrays_cached()` used list comprehensions to filter global peaks to the window:
```python
peak_idx = [
    idx - window_start
    for idx in global_peaks.peak_indices
    if window_start <= idx < window_end
]
```

This is O(n) where n = total number of peaks in the dataset. With 940 calls per backtest, this added up.

Profile showed 0.15s total in list comprehensions (`<listcomp>` lines 258, 263).

### Solution

Use `bisect_left` for O(log n) lookup since peak indices are already sorted:
```python
from bisect import bisect_left

p_lo = bisect_left(gp, window_start)
p_hi = bisect_left(gp, window_end)
peak_idx = [gp[j] - window_start for j in range(p_lo, p_hi)]
```

This reduces the filtering cost from O(n) to O(log n + k) where k = peaks in window.

**Files changed:**
- [formations.py](../src/tradehub/analysis/formations.py) - Use bisect for peak filtering

---

## Remaining Hotspots

Based on cProfile output, the remaining time is distributed across:

| Function | Time | Calls | Notes |
|----------|------|-------|-------|
| `_head_shoulders` | 0.124s | 940 | Pattern detection loop |
| `_double_bottoms` | 0.121s | 940 | Pattern detection loop |
| `_inv_head_shoulders` | 0.119s | 940 | Pattern detection loop |
| `compute_supertrend` | 0.111s | 1 | One-time computation |
| `_double_tops` | 0.108s | 940 | Pattern detection loop |

These pattern detection functions iterate over detected peaks/troughs in O(n²) or O(n³) nested loops. Further optimization would require algorithmic changes that might affect detection accuracy.

---

## Verification

All optimizations were verified to:
1. Produce identical backtest results (same trades, same P&L)
2. Pass existing test suite
3. Not affect detection accuracy

Run `scripts/profile_e2e.py` to reproduce measurements.
