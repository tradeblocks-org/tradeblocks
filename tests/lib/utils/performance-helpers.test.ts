import { classifyOutcome } from "@tradeblocks/lib";

describe("classifyOutcome", () => {
  it("returns all_wins when all legs are positive", () => {
    expect(classifyOutcome(2, 0, 2)).toBe("all_wins");
  });

  it("returns all_losses when all legs are negative", () => {
    expect(classifyOutcome(0, 2, 2)).toBe("all_losses");
  });

  it("returns mixed when legs are mixed", () => {
    expect(classifyOutcome(1, 1, 2)).toBe("mixed");
  });

  it("returns neutral (partial/neutral) when one leg is breakeven", () => {
    // 1 Win, 1 Breakeven -> positive=1, negative=0, total=2
    expect(classifyOutcome(1, 0, 2)).toBe("neutral");
  });

  it("returns neutral (partial/neutral) when one leg is loss and one breakeven", () => {
    // 1 Loss, 1 Breakeven -> positive=0, negative=1, total=2
    expect(classifyOutcome(0, 1, 2)).toBe("neutral");
  });
});
