import { Vector3D, LeadId, PhysicalElectrodeId, ECG12LeadFrame, ClinicalFactors } from './types';
import { CardiacDipoleEngine } from './CardiacDipoleEngine';

/**
 * Standard Anatomical Electrode Landmarks on Human Torso
 * All coordinates in Frank VCG convention (meters):
 * +X: Left, +Y: Inferior, +Z: Posterior
 */
export const STANDARD_ELECTRODE_LANDMARKS: Record<
  PhysicalElectrodeId,
  { pos: Vector3D; name: string; fullTitle: string; fullTitleEn?: string; landmarkDesc: string; landmarkDescEn?: string }
> = {
  RA: {
    pos: { x: -0.25, y: -0.22, z:  0.00 },
    name: 'RA',
    fullTitle: 'Right Arm (Lengan Kanan)',
    fullTitleEn: 'Right Arm',
    landmarkDesc: 'Fossa Infraklavikula Dextra (bawah klavikula kanan)',
    landmarkDescEn: 'Right Infraclavicular Fossa (below right clavicle)',
  },
  LA: {
    pos: { x:  0.25, y: -0.22, z:  0.00 },
    name: 'LA',
    fullTitle: 'Left Arm (Lengan Kiri)',
    fullTitleEn: 'Left Arm',
    landmarkDesc: 'Fossa Infraklavikula Sinistra (bawah klavikula kiri)',
    landmarkDescEn: 'Left Infraclavicular Fossa (below left clavicle)',
  },
  RL: {
    pos: { x: -0.12, y:  0.45, z:  0.00 },
    name: 'RL',
    fullTitle: 'Right Leg (Patient Ground / DRL)',
    fullTitleEn: 'Right Leg (Patient Ground / DRL)',
    landmarkDesc: 'Abdomen Kanan Bawah / Tungkai Kanan (Grounding 50 Hz)',
    landmarkDescEn: 'Right Lower Abdomen / Right Leg (50/60 Hz Grounding)',
  },
  LL: {
    pos: { x:  0.12, y:  0.45, z:  0.00 },
    name: 'LL',
    fullTitle: 'Left Leg (Tungkai Kiri)',
    fullTitleEn: 'Left Leg',
    landmarkDesc: 'Abdomen Kiri Bawah / Tungkai Kiri (Sadapan Inferior)',
    landmarkDescEn: 'Left Lower Abdomen / Left Leg (Inferior Leads)',
  },
  V1: {
    pos: { x: -0.03, y:  0.00, z: -0.11 },
    name: 'V1',
    fullTitle: 'Prekordial V1',
    fullTitleEn: 'Precordial V1',
    landmarkDesc: 'Ruang Interkostal IV, Garis Parasternal Kanan',
    landmarkDescEn: '4th Intercostal Space, Right Sternal Border',
  },
  V2: {
    pos: { x:  0.03, y:  0.00, z: -0.11 },
    name: 'V2',
    fullTitle: 'Prekordial V2',
    fullTitleEn: 'Precordial V2',
    landmarkDesc: 'Ruang Interkostal IV, Garis Parasternal Kiri',
    landmarkDescEn: '4th Intercostal Space, Left Sternal Border',
  },
  V3: {
    pos: { x:  0.06, y:  0.03, z: -0.10 },
    name: 'V3',
    fullTitle: 'Prekordial V3',
    fullTitleEn: 'Precordial V3',
    landmarkDesc: 'Pertengahan anatomis antara elektroda V2 dan V4',
    landmarkDescEn: 'Midway anatomically between leads V2 and V4',
  },
  V4: {
    pos: { x:  0.10, y:  0.06, z: -0.08 },
    name: 'V4',
    fullTitle: 'Prekordial V4',
    fullTitleEn: 'Precordial V4',
    landmarkDesc: 'Ruang Interkostal V, Garis Midklavikularis Kiri',
    landmarkDescEn: '5th Intercostal Space, Left Midclavicular Line',
  },
  V5: {
    pos: { x:  0.14, y:  0.06, z: -0.04 },
    name: 'V5',
    fullTitle: 'Prekordial V5',
    fullTitleEn: 'Precordial V5',
    landmarkDesc: 'Ruang Interkostal V, Garis Aksilaris Anterior Kiri',
    landmarkDescEn: '5th Intercostal Space, Left Anterior Axillary Line',
  },
  V6: {
    pos: { x:  0.16, y:  0.06, z:  0.01 },
    name: 'V6',
    fullTitle: 'Prekordial V6',
    fullTitleEn: 'Precordial V6',
    landmarkDesc: 'Ruang Interkostal V, Garis Midaksilaris Kiri',
    landmarkDescEn: '5th Intercostal Space, Left Midaxillary Line',
  },
};

/**
 * Geometric 3D Lead Field Model
 * Computes lead vectors and calculates 12-lead voltages from any arbitrary
 * 3D electrode positions on the torso relative to the cardiac electrical center.
 * Implements biophysical voltage scaling S = 0.05, lead-off detection,
 * driven right leg 50 Hz noise injection, and magnetic snapping.
 */
export class LeadFieldModel {
  // Torso transfer constant: kappa = eta / (4 * pi * sigma)
  // sigma = 0.22 S/m, eta = 3.0 (insulated torso boundary correction)
  public readonly kappa: number = 1.085;

  // Biophysical voltage scale factor: S = 0.05
  // Calibrated so Lead II R-wave is ~1.28 mV, P-wave is ~0.15 mV, T-wave is ~0.35 mV,
  // and acute LAD STEMI produces ~2.47 mV ST elevation in V2.
  public readonly voltageScale: number = 0.05;

  // Magnetic snapping radius: 35 mm (0.035 meters)
  public static readonly SNAP_RADIUS_METERS: number = 0.035;

  // Cardiac Electrical Center (Mid-interventricular septum)
  public heartOrigin: Vector3D = { x: 0.0, y: 0.0, z: 0.0 };

  // 3D physical coordinates of electrodes in Frank VCG coordinates (meters)
  public electrodes: Record<PhysicalElectrodeId, Vector3D> = {
    RA: { ...STANDARD_ELECTRODE_LANDMARKS.RA.pos },
    LA: { ...STANDARD_ELECTRODE_LANDMARKS.LA.pos },
    LL: { ...STANDARD_ELECTRODE_LANDMARKS.LL.pos },
    RL: { ...STANDARD_ELECTRODE_LANDMARKS.RL.pos },
    V1: { ...STANDARD_ELECTRODE_LANDMARKS.V1.pos },
    V2: { ...STANDARD_ELECTRODE_LANDMARKS.V2.pos },
    V3: { ...STANDARD_ELECTRODE_LANDMARKS.V3.pos },
    V4: { ...STANDARD_ELECTRODE_LANDMARKS.V4.pos },
    V5: { ...STANDARD_ELECTRODE_LANDMARKS.V5.pos },
    V6: { ...STANDARD_ELECTRODE_LANDMARKS.V6.pos },
  };

  // Placed vs unplaced state for all 10 physical electrodes
  public placed: Record<PhysicalElectrodeId, boolean> = {
    RA: true,
    LA: true,
    LL: true,
    RL: true,
    V1: true,
    V2: true,
    V3: true,
    V4: true,
    V5: true,
    V6: true,
  };

  // Precomputed lead vectors L_i = kappa * (r_i - r_0) / |r_i - r_0|^3
  private cachedLeadVectors: Record<PhysicalElectrodeId, Vector3D> = {} as any;
  private isDirty: boolean = true;

  constructor() {
    this.recomputeLeadVectors();
  }

  /**
   * Updates an electrode's 3D spatial position dynamically with magnetic snapping.
   * Call this when user moves or drags an electrode in the 3D scene.
   */
  public setElectrodePosition(id: PhysicalElectrodeId, newPos: Vector3D, allowSnap: boolean = true): void {
    if (this.electrodes[id]) {
      if (allowSnap) {
        this.electrodes[id] = this.checkSnapping(id, newPos);
      } else {
        this.electrodes[id] = { ...newPos };
      }
      this.isDirty = true;
    }
  }

  /**
   * Checks magnetic snapping against standard anatomical landmarks (35mm radius).
   */
  public checkSnapping(id: PhysicalElectrodeId, pos: Vector3D): Vector3D {
    const target = STANDARD_ELECTRODE_LANDMARKS[id].pos;
    const dx = pos.x - target.x;
    const dy = pos.y - target.y;
    const dz = pos.z - target.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist <= LeadFieldModel.SNAP_RADIUS_METERS) {
      return { ...target };
    }
    return pos;
  }

  /**
   * Updates an electrode's placed state.
   */
  public setElectrodePlaced(id: PhysicalElectrodeId, isPlaced: boolean): void {
    this.placed[id] = isPlaced;
  }

  /**
   * Auto-attaches all 10 electrodes to standard anatomical landmarks.
   */
  public attachAllElectrodes(): void {
    const keys = Object.keys(this.placed) as PhysicalElectrodeId[];
    for (const key of keys) {
      this.placed[key] = true;
    }
    this.resetToStandardPositions();
  }

  /**
   * Detaches all 10 electrodes into tray (lead-off state).
   */
  public detachAllElectrodes(): void {
    const keys = Object.keys(this.placed) as PhysicalElectrodeId[];
    for (const key of keys) {
      this.placed[key] = false;
    }
  }

  /**
   * Resets all electrodes to standard clinical anatomical positions.
   */
  public resetToStandardPositions(): void {
    this.electrodes = {
      RA: { ...STANDARD_ELECTRODE_LANDMARKS.RA.pos },
      LA: { ...STANDARD_ELECTRODE_LANDMARKS.LA.pos },
      LL: { ...STANDARD_ELECTRODE_LANDMARKS.LL.pos },
      RL: { ...STANDARD_ELECTRODE_LANDMARKS.RL.pos },
      V1: { ...STANDARD_ELECTRODE_LANDMARKS.V1.pos },
      V2: { ...STANDARD_ELECTRODE_LANDMARKS.V2.pos },
      V3: { ...STANDARD_ELECTRODE_LANDMARKS.V3.pos },
      V4: { ...STANDARD_ELECTRODE_LANDMARKS.V4.pos },
      V5: { ...STANDARD_ELECTRODE_LANDMARKS.V5.pos },
      V6: { ...STANDARD_ELECTRODE_LANDMARKS.V6.pos },
    };
    this.isDirty = true;
  }

  /**
   * Recomputes lead vectors L_i based on current electrode positions.
   */
  public recomputeLeadVectors(): void {
    const keys = Object.keys(this.electrodes) as PhysicalElectrodeId[];
    for (let i = 0; i < keys.length; i++) {
      const id = keys[i];
      const pos = this.electrodes[id];
      const dx = pos.x - this.heartOrigin.x;
      const dy = pos.y - this.heartOrigin.y;
      const dz = pos.z - this.heartOrigin.z;

      const distSq = dx * dx + dy * dy + dz * dz;
      const dist = Math.sqrt(distSq);
      // Avoid division by zero with small epsilon threshold
      const invDistCube = dist > 1e-4 ? this.kappa / (distSq * dist) : 0;

      this.cachedLeadVectors[id] = {
        x: dx * invDistCube,
        y: dy * invDistCube,
        z: dz * invDistCube,
      };
    }
    this.isDirty = false;
  }

  /**
   * Computes the complete 12-lead ECG potential frame for a given 3D dipole vector.
   * Incorporates Lead-Off biophysical rules, 50 Hz powerline interference,
   * Wilson Central Terminal integrity, and voltage scaling S = 0.05.
   */
  public compute12Leads(
    dipole: Vector3D,
    phase: number,
    timeMs: number,
    placedOverride?: Record<PhysicalElectrodeId, boolean>
  ): ECG12LeadFrame {
    if (this.isDirty) {
      this.recomputeLeadVectors();
    }

    const placed = placedOverride || this.placed;

    // 1. Calculate unipolar surface potentials: Phi_i = (L_i . P) * voltageScale
    const unipolar: Record<PhysicalElectrodeId, number> = {} as any;
    const keys = Object.keys(this.cachedLeadVectors) as PhysicalElectrodeId[];

    for (let i = 0; i < keys.length; i++) {
      const id = keys[i];
      const L = this.cachedLeadVectors[id];
      unipolar[id] = (L.x * dipole.x + L.y * dipole.y + L.z * dipole.z) * this.voltageScale;
    }

    // Subtle amplifier thermal noise for disconnected leads (~0.008 mV)
    const getBaselineNoise = (offset: number) => {
      const t = timeMs * 0.001;
      return (
        Math.sin(t * 19.3 + offset) * 0.008 +
        Math.sin(t * 41.7 + offset * 2.1) * 0.004
      );
    };

    // 50 Hz powerline AC interference when RL (Driven Right Leg) is unplaced
    const has50HzNoise = !placed.RL;
    const tSec = timeMs / 1000.0;
    const powerlineNoise = has50HzNoise
      ? 0.35 * Math.sin(2.0 * Math.PI * 50.0 * tSec) +
        0.12 * Math.sin(2.0 * Math.PI * 150.0 * tSec)
      : 0.0;

    // Limb electrodes status
    const raPlaced = !!placed.RA;
    const laPlaced = !!placed.LA;
    const llPlaced = !!placed.LL;

    // Wilson Central Terminal (WCT) valid ONLY if RA, LA, and LL are all placed
    const wctValid = raPlaced && laPlaced && llPlaced;
    const referenceLost = !wctValid;
    const vWCT = wctValid ? (unipolar.RA + unipolar.LA + unipolar.LL) / 3.0 : 0.0;

    // Lead-Off status for each of the 12 leads
    const leadOffStatus: Record<LeadId, boolean> = {
      I: !raPlaced || !laPlaced,
      II: !raPlaced || !llPlaced,
      III: !laPlaced || !llPlaced,
      aVR: !wctValid,
      aVL: !wctValid,
      aVF: !wctValid,
      V1: !wctValid || !placed.V1,
      V2: !wctValid || !placed.V2,
      V3: !wctValid || !placed.V3,
      V4: !wctValid || !placed.V4,
      V5: !wctValid || !placed.V5,
      V6: !wctValid || !placed.V6,
    };

    // 2. Einthoven Standard Bipolar Limb Leads
    const leadI = leadOffStatus.I
      ? getBaselineNoise(1.1)
      : (unipolar.LA - unipolar.RA) + powerlineNoise;

    const leadII = leadOffStatus.II
      ? getBaselineNoise(2.2)
      : (unipolar.LL - unipolar.RA) + powerlineNoise;

    const leadIII = leadOffStatus.III
      ? getBaselineNoise(3.3)
      : (unipolar.LL - unipolar.LA) + powerlineNoise;

    // 3. Goldberger Augmented Unipolar Limb Leads
    const aVR = leadOffStatus.aVR
      ? getBaselineNoise(4.4)
      : (unipolar.RA - 0.5 * (unipolar.LA + unipolar.LL)) + powerlineNoise;

    const aVL = leadOffStatus.aVL
      ? getBaselineNoise(5.5)
      : (unipolar.LA - 0.5 * (unipolar.RA + unipolar.LL)) + powerlineNoise;

    const aVF = leadOffStatus.aVF
      ? getBaselineNoise(6.6)
      : (unipolar.LL - 0.5 * (unipolar.RA + unipolar.LA)) + powerlineNoise;

    // 4. Wilson Precordial Chest Leads
    const V1 = leadOffStatus.V1 ? getBaselineNoise(7.7) : (unipolar.V1 - vWCT) + powerlineNoise;
    const V2 = leadOffStatus.V2 ? getBaselineNoise(8.8) : (unipolar.V2 - vWCT) + powerlineNoise;
    const V3 = leadOffStatus.V3 ? getBaselineNoise(9.9) : (unipolar.V3 - vWCT) + powerlineNoise;
    const V4 = leadOffStatus.V4 ? getBaselineNoise(11.0) : (unipolar.V4 - vWCT) + powerlineNoise;
    const V5 = leadOffStatus.V5 ? getBaselineNoise(12.1) : (unipolar.V5 - vWCT) + powerlineNoise;
    const V6 = leadOffStatus.V6 ? getBaselineNoise(13.2) : (unipolar.V6 - vWCT) + powerlineNoise;

    const leads: Record<LeadId, number> = {
      I: leadI,
      II: leadII,
      III: leadIII,
      aVR,
      aVL,
      aVF,
      V1,
      V2,
      V3,
      V4,
      V5,
      V6,
    };

    return {
      timeMs,
      phase,
      dipole,
      graphicsDipole: CardiacDipoleEngine.toGraphicsCoords(dipole),
      leads,
      unipolar,
      vWCT,
      leadOffStatus,
      referenceLost,
      has50HzNoise,
    };
  }

  /**
   * Helper: Get electrode position in Three.js coordinates
   */
  public getElectrodeInGraphicsCoords(id: PhysicalElectrodeId): Vector3D {
    const p = this.electrodes[id];
    return CardiacDipoleEngine.toGraphicsCoords(p);
  }

  /**
   * Evaluates the acute coronary ischemic injury vector (current of injury)
   * in Frank VCG coordinates (+X Left, +Y Inferior, +Z Posterior).
   */
  public computeInjuryVector(factors: ClinicalFactors): Vector3D {
    const injuryVector: Vector3D = { x: 0.0, y: 0.0, z: 0.0 };

    if (factors.ladStenosisPercent > 50) {
      const ladSeverity = (factors.ladStenosisPercent - 50) / 50.0;
      injuryVector.x += 0.22 * ladSeverity;
      injuryVector.y += 0.08 * ladSeverity;
      injuryVector.z -= 0.55 * ladSeverity; // Anterior deflection
    }

    if (factors.rcaStenosisPercent > 50) {
      const rcaSeverity = (factors.rcaStenosisPercent - 50) / 50.0;
      injuryVector.x -= 0.15 * rcaSeverity;
      injuryVector.y += 0.48 * rcaSeverity; // Inferior deflection
      injuryVector.z += 0.10 * rcaSeverity;
    }

    if (factors.lcxStenosisPercent > 50) {
      const lcxSeverity = (factors.lcxStenosisPercent - 50) / 50.0;
      injuryVector.x += 0.45 * lcxSeverity; // Leftward deflection
      injuryVector.y -= 0.20 * lcxSeverity;
      injuryVector.z += 0.35 * lcxSeverity;
    }

    return injuryVector;
  }

  /**
   * Computes closed-form analytical ST deviations, T-wave amplitudes,
   * and physiological intervals directly from the biophysical lead field.
   * Eliminates asynchronous beat-frequency polling flicker.
   */
  public computeAnalyticalFeatures(
    factors: ClinicalFactors,
    placedOverride?: Record<PhysicalElectrodeId, boolean>
  ): {
    prIntervalMs: number;
    qrsDurationMs: number;
    qtIntervalMs: number;
    qtcBazettMs: number;
    qtcFridericiaMs: number;
    stDeviationMv: Record<LeadId, number>;
    tWaveAmplitudeMv: Record<LeadId, number>;
  } {
    const placed = placedOverride || this.placed;
    const raPlaced = !!placed.RA;
    const laPlaced = !!placed.LA;
    const llPlaced = !!placed.LL;
    const wctValid = raPlaced && laPlaced && llPlaced;

    const injury = this.computeInjuryVector(factors);
    const keys = Object.keys(this.cachedLeadVectors) as PhysicalElectrodeId[];

    // Unipolar ST potentials: Phi_i = (L_i . P_injury) * S
    const unipolarST: Record<PhysicalElectrodeId, number> = {} as any;
    for (let i = 0; i < keys.length; i++) {
      const id = keys[i];
      const L = this.cachedLeadVectors[id];
      unipolarST[id] = (L.x * injury.x + L.y * injury.y + L.z * injury.z) * this.voltageScale;
    }
    const vWCT_ST = wctValid ? (unipolarST.RA + unipolarST.LA + unipolarST.LL) / 3.0 : 0.0;

    const stDeviationMv: Record<LeadId, number> = {
      I: !raPlaced || !laPlaced ? 0.0 : unipolarST.LA - unipolarST.RA,
      II: !raPlaced || !llPlaced ? 0.0 : unipolarST.LL - unipolarST.RA,
      III: !laPlaced || !llPlaced ? 0.0 : unipolarST.LL - unipolarST.LA,
      aVR: !wctValid ? 0.0 : unipolarST.RA - 0.5 * (unipolarST.LA + unipolarST.LL),
      aVL: !wctValid ? 0.0 : unipolarST.LA - 0.5 * (unipolarST.RA + unipolarST.LL),
      aVF: !wctValid ? 0.0 : unipolarST.LL - 0.5 * (unipolarST.RA + unipolarST.LA),
      V1: !wctValid || !placed.V1 ? 0.0 : unipolarST.V1 - vWCT_ST,
      V2: !wctValid || !placed.V2 ? 0.0 : unipolarST.V2 - vWCT_ST,
      V3: !wctValid || !placed.V3 ? 0.0 : unipolarST.V3 - vWCT_ST,
      V4: !wctValid || !placed.V4 ? 0.0 : unipolarST.V4 - vWCT_ST,
      V5: !wctValid || !placed.V5 ? 0.0 : unipolarST.V5 - vWCT_ST,
      V6: !wctValid || !placed.V6 ? 0.0 : unipolarST.V6 - vWCT_ST,
    };

    // T-wave dipole calculation
    const k = factors.serumPotassium;
    const isHyperK = k > 5.2;
    const hyperKRatio = Math.max(0, (k - 5.0) / 4.0);
    const hypoKRatio = Math.max(0, (3.5 - k) / 1.5);
    const tAmpScale = isHyperK
      ? 1.0 + hyperKRatio * 2.2
      : Math.max(0.15, 1.0 - hypoKRatio * 0.85);

    const tDipole: Vector3D = {
      x: 0.32 * tAmpScale,
      y: 0.38 * tAmpScale,
      z: 0.08 * tAmpScale,
    };

    const unipolarT: Record<PhysicalElectrodeId, number> = {} as any;
    for (let i = 0; i < keys.length; i++) {
      const id = keys[i];
      const L = this.cachedLeadVectors[id];
      unipolarT[id] = (L.x * tDipole.x + L.y * tDipole.y + L.z * tDipole.z) * this.voltageScale;
    }
    const vWCT_T = wctValid ? (unipolarT.RA + unipolarT.LA + unipolarT.LL) / 3.0 : 0.0;

    const tWaveAmplitudeMv: Record<LeadId, number> = {
      I: !raPlaced || !laPlaced ? 0.0 : unipolarT.LA - unipolarT.RA,
      II: !raPlaced || !llPlaced ? 0.0 : unipolarT.LL - unipolarT.RA,
      III: !laPlaced || !llPlaced ? 0.0 : unipolarT.LL - unipolarT.LA,
      aVR: !wctValid ? 0.0 : unipolarT.RA - 0.5 * (unipolarT.LA + unipolarT.LL),
      aVL: !wctValid ? 0.0 : unipolarT.LA - 0.5 * (unipolarT.RA + unipolarT.LL),
      aVF: !wctValid ? 0.0 : unipolarT.LL - 0.5 * (unipolarT.RA + unipolarT.LA),
      V1: !wctValid || !placed.V1 ? 0.0 : unipolarT.V1 - vWCT_T,
      V2: !wctValid || !placed.V2 ? 0.0 : unipolarT.V2 - vWCT_T,
      V3: !wctValid || !placed.V3 ? 0.0 : unipolarT.V3 - vWCT_T,
      V4: !wctValid || !placed.V4 ? 0.0 : unipolarT.V4 - vWCT_T,
      V5: !wctValid || !placed.V5 ? 0.0 : unipolarT.V5 - vWCT_T,
      V6: !wctValid || !placed.V6 ? 0.0 : unipolarT.V6 - vWCT_T,
    };

    // Physiological interval calculations
    const hr = Math.max(20, factors.heartRate);
    const rrSec = 60.0 / hr;
    const qtcBazettMs = Math.round(410.0 / Math.sqrt(rrSec));
    const qtcFridericiaMs = Math.round(410.0 / Math.pow(rrSec, 1.0 / 3.0));
    const qtIntervalMs = Math.round(410.0 * Math.pow(rrSec, 0.33));

    let prIntervalMs = 160.0;
    if (factors.rhythmType === 'afib') prIntervalMs = 0.0;
    else if (factors.rhythmType === 'av_block_3rd') prIntervalMs = 380.0;

    let qrsDurationMs = 86.0;
    if (factors.rhythmType === 'vtach' || factors.rhythmType === 'torsades') {
      qrsDurationMs = 150.0;
    } else if (factors.rhythmType === 'av_block_3rd') {
      qrsDurationMs = 135.0;
    } else if (factors.serumPotassium > 6.5) {
      qrsDurationMs = 86.0 * (1.0 + Math.max(0, (factors.serumPotassium - 5.0) / 4.0) * 1.4);
    }

    return {
      prIntervalMs,
      qrsDurationMs,
      qtIntervalMs,
      qtcBazettMs,
      qtcFridericiaMs,
      stDeviationMv,
      tWaveAmplitudeMv,
    };
  }
}
