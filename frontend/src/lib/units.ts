// Physical constants and unit conversions: CODATA 2018, the set used by Quantum ESPRESSO 7.x.
// Mirror of backend/qestudio/core/units.py: keep the two files in sync.

/** Rydberg energy in eV. */
export const RY_EV = 13.605693122994;
/** Hartree energy in eV. */
export const HA_EV = 2 * RY_EV;
/** Bohr radius in Angstrom. */
export const BOHR_A = 0.529177210903;
/** 1 Ry/bohr in eV/Angstrom (forces). */
export const RY_BOHR_TO_EV_A = RY_EV / BOHR_A;
/** 1 THz in cm^-1 (1e12 / c, c = 2.99792458e10 cm/s). */
export const CM1_PER_THZ = 1e12 / 2.99792458e10;
/** 1 meV in cm^-1 (1 eV = 8065.543937 cm^-1). */
export const CM1_PER_MEV = 8.065543937;
