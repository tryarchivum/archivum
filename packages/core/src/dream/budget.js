import { normalizeUsage, zeroUsage } from "../providers/http.js";

/**
 * Shared token counter. The cap is checked BEFORE each call is launched, so a
 * run can overshoot by at most the tokens of the calls already in flight.
 */
export class BudgetTracker {
  /**
   * @param {number} cap
   * @param {(pct:number, used:number, cap:number)=>void} [onThreshold] called once at 50, 80 and 100 percent
   */
  constructor(cap, onThreshold) {
    this.cap = cap;
    this.usage = zeroUsage();
    this.onThreshold = onThreshold;
    this.fired = new Set();
  }
  get used() {
    return this.usage.total_tokens;
  }
  get exhausted() {
    return this.used >= this.cap;
  }
  add(raw) {
    const u = normalizeUsage(raw);
    for (const k of Object.keys(this.usage)) this.usage[k] += u[k];
    for (const pct of [50, 80, 100]) {
      if (!this.fired.has(pct) && this.used * 100 >= this.cap * pct) {
        this.fired.add(pct);
        this.onThreshold?.(pct, this.used, this.cap);
      }
    }
  }
}
