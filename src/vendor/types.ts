/**
 * Types and interfaces for the 3D Biophysical Cardiac Dipole and Lead Field Engine.
 * All coordinate systems follow the canonical Frank VCG convention:
 * +X: Patient Left (Right -> Left)
 * +Y: Patient Inferior (Superior -> Inferior)
 * +Z: Patient Posterior (Anterior -> Posterior)
 */

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export type LeadId =
  | 'I'
  | 'II'
  | 'III'
  | 'aVR'
  | 'aVL'
  | 'aVF'
  | 'V1'
  | 'V2'
  | 'V3'
  | 'V4'
  | 'V5'
  | 'V6';

export type PhysicalElectrodeId =
  | 'RA'
  | 'LA'
  | 'LL'
  | 'RL'
  | 'V1'
  | 'V2'
  | 'V3'
  | 'V4'
  | 'V5'
  | 'V6';

export interface GaussianWaveDef {
  name: string;
  thetaCenter: number; // Center phase angle in radians [-pi, pi]
  bWidth: number;      // Standard deviation / angular width in radians
  amplitude: Vector3D; // 3D dipole amplitude vector in mV
}

export interface ECG12LeadFrame {
  timeMs: number;
  phase: number;
  dipole: Vector3D;
  graphicsDipole: Vector3D; // Converted for Three.js (+X Left, +Y Up, +Z Front)
  leads: Record<LeadId, number>; // Voltage in mV
  unipolar: Record<PhysicalElectrodeId, number>; // Surface potential in mV
  vWCT: number; // Wilson Central Terminal potential in mV
  leadOffStatus: Record<LeadId, boolean>;
  referenceLost: boolean;
  has50HzNoise: boolean;
}

export type WorkspaceMode = 'exploration' | 'monitor' | 'integrated';

export interface CardiacConductionPhaseInfo {
  key: 'P' | 'PR' | 'QRS' | 'ST' | 'T' | 'Diastole';
  label: string;
  organ: string;
  color: string;
}

export type RhythmType =
  | 'sinus'
  | 'afib'
  | 'aflutter'
  | 'vtach'
  | 'vfib_coarse'
  | 'vfib_fine'
  | 'asystole'
  | 'av_block_3rd'
  | 'torsades'
  | 'brady'
  | 'tachy';

export interface ClinicalFactors {
  heartRate: number;        // 30 - 220 BPM
  hsTroponinT: number;      // 2 - 100,000 ng/L (normal < 14)
  ladStenosisPercent: number; // 0 - 100%
  lcxStenosisPercent: number; // 0 - 100%
  rcaStenosisPercent: number; // 0 - 100%
  serumPotassium: number;   // 2.0 - 10.0 mmol/L (normal 3.5 - 5.0)
  serumCalcium: number;     // 5.0 - 16.0 mg/dL (normal 8.5 - 10.5)
  spo2Percent: number;      // 70 - 100%
  rhythmType: RhythmType;
}

