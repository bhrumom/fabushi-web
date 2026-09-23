/**
 * Generated merit-benefit data modules historically referenced
 * FaliuMeritBenefit as an ambient type. Keep that data contract tied to the
 * canonical exported interface without adding runtime imports to hundreds of
 * scripture data modules.
 */
export {};

declare global {
  type FaliuMeritBenefit =
    import("./lib/faliu-merit-benefits-original").FaliuMeritBenefit;
}
