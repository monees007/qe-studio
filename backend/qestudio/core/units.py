"""Physical constants and unit conversions (CODATA 2018, the set used by Quantum ESPRESSO 7.x).

Verified against QE 7.6 output: alat written by pw.x for a cell given in Angstrom equals
|a1| / BOHR_A to all printed digits. Keep every conversion in the code base in this module
(and in frontend/src/lib/units.ts) so that values agree everywhere.
"""

from __future__ import annotations

RY_EV = 13.605693122994  # Rydberg energy in eV
HA_EV = 2.0 * RY_EV  # Hartree in eV (27.211386245988)
BOHR_A = 0.529177210903  # Bohr radius in Angstrom
AMU_G = 1.66053906660e-24  # atomic mass unit in gram
EV_PER_A3_TO_GPA = 160.2176634  # 1 eV/Angstrom^3 in GPa (e is exact in the 2019 SI)
