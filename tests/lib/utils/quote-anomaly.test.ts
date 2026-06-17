/**
 * Tests for isAnomalousQuote — bid/ask quote validity guard.
 */

import { isAnomalousQuote } from '@tradeblocks/lib'

describe('isAnomalousQuote', () => {
  describe('well-formed quotes', () => {
    it('returns false for a normal tight spread', () => {
      expect(isAnomalousQuote(2.0, 2.1)).toBe(false)
    })

    it('returns false for a wide-but-not-blown spread (5x ratio)', () => {
      // ask/bid = 5x; threshold is 10x.
      expect(isAnomalousQuote(1.0, 5.0)).toBe(false)
    })

    it('returns false for equal bid and ask', () => {
      expect(isAnomalousQuote(1.5, 1.5)).toBe(false)
    })
  })

  describe('crossed quotes (bid > ask)', () => {
    it('returns true when bid exceeds ask', () => {
      expect(isAnomalousQuote(5.0, 3.0)).toBe(true)
    })

    it('returns true for narrowly crossed quotes', () => {
      expect(isAnomalousQuote(2.01, 2.0)).toBe(true)
    })
  })

  describe('blown spreads (ask > 10x bid)', () => {
    it('returns true when ask > 10x bid AND mid > $1', () => {
      // Noise-day quote: bid=0.05, ask=10.00 ⇒ mid = 5.025.
      // Ratio = 200x; mid > 1 ⇒ blown.
      expect(isAnomalousQuote(0.05, 10.0)).toBe(true)
    })

    it('returns false when ratio is blown but mid is at/below $1', () => {
      // Sub-$1 deep-OTM: bid=0.05, ask=0.6 ⇒ ratio 12x but mid = 0.325.
      // Dollar floor prevents false positive on cheap markets.
      expect(isAnomalousQuote(0.05, 0.6)).toBe(false)
    })

    it('returns false at exactly the 10x ratio boundary', () => {
      // ask = 10x bid is NOT yet blown (threshold is strict >).
      expect(isAnomalousQuote(1.0, 10.0)).toBe(false)
    })
  })

  describe('invalid inputs', () => {
    it('returns false when bid is zero', () => {
      expect(isAnomalousQuote(0, 1.0)).toBe(false)
    })

    it('returns false when ask is zero', () => {
      expect(isAnomalousQuote(1.0, 0)).toBe(false)
    })

    it('returns false when bid is negative', () => {
      expect(isAnomalousQuote(-0.5, 1.0)).toBe(false)
    })

    it('returns false when ask is negative', () => {
      expect(isAnomalousQuote(1.0, -0.5)).toBe(false)
    })

    it('returns false when both sides are zero', () => {
      expect(isAnomalousQuote(0, 0)).toBe(false)
    })
  })
})
