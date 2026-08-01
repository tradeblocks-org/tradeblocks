/**
 * Mode-aware worst-case budget captions. Guarantee mode forces an exact count
 * into every simulation, so it may speak in "exactly"/"force" terms;
 * probabilistic mode replaces each slot at a literal chance, so its captions
 * must speak in per-slot-chance and average terms — nothing is forced there.
 */

import { describeWorstCaseBudget } from "@/app/(platform)/risk-simulator/worst-case-copy";

describe("describeWorstCaseBudget", () => {
  it("simulation basis, probabilistic: literal chance and an average count", () => {
    const text = describeWorstCaseBudget({
      mode: "probabilistic",
      basedOn: "simulation",
      percentage: 5,
      budget: 15,
    });
    expect(text).toMatch(/literal 5% chance/);
    expect(text).toMatch(/15 per simulation on average/);
    expect(text).not.toMatch(/[Ff]orce/);
    expect(text).not.toMatch(/[Ee]xactly/);
  });

  it("simulation basis, guarantee: exact share of the horizon", () => {
    const text = describeWorstCaseBudget({
      mode: "guarantee",
      basedOn: "simulation",
      percentage: 5,
      budget: 15,
    });
    expect(text).toMatch(/Exactly 5% of the simulation horizon/);
    expect(text).toMatch(/15 synthetic trades/);
  });

  it("historical basis, guarantee: keeps the force-promise wording", () => {
    const text = describeWorstCaseBudget({
      mode: "guarantee",
      basedOn: "historical",
      percentage: 5,
      budget: 15,
    });
    expect(text).toMatch(/historical trade count/);
    expect(text).toMatch(/"Force 5%" promise/);
  });

  it("historical basis, probabilistic: average composition, no force promise", () => {
    const text = describeWorstCaseBudget({
      mode: "probabilistic",
      basedOn: "historical",
      percentage: 5,
      budget: 15,
    });
    expect(text).toMatch(/historical trade count/);
    expect(text).toMatch(/literal 5% replacement chance/);
    expect(text).toMatch(/15 per simulation on average/);
    expect(text).not.toMatch(/[Ff]orce/);
  });
});
