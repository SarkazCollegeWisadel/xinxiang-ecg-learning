import { Vector3D, GaussianWaveDef, ClinicalFactors, CardiacConductionPhaseInfo } from './types';

/**
 * High-Performance Rule-Based 3D Cardiac Dipole Engine
 * Evaluates the net equivalent cardiac current dipole vector P(t) in R^3
 * using a multi-oscillator dynamical architecture:
 * - Decoupled Atrial Oscillator (Sinus P vs AFib f-waves vs AFlutter)
 * - AV Conduction Filter with variable refractoriness and complete block
 * - Ventricular Generator (Narrow QRS vs wide ectopic QRS vs chaotic 3D wandering rotor vs flatline)
 * - Dynamic 3D affine precession operator for Torsades de Pointes
 */
export class CardiacDipoleEngine {
  private phase: number = -Math.PI;
  private timeSeconds: number = 0;

  /**
   * Evaluates the 3D cardiac dipole vector P(theta, t) in Frank VCG coordinates.
   * Coordinate conventions:
   * +X: Left (+Ax is towards patient's left)
   * +Y: Inferior (+Ay is towards patient's feet)
   * +Z: Posterior (+Az is towards patient's back)
   */
  public evaluateDipole(
    phase: number,
    factors: ClinicalFactors,
    timeSecondsOverride?: number
  ): Vector3D {
    const t = timeSecondsOverride !== undefined ? timeSecondsOverride : this.timeSeconds;
    const rhythm = factors.rhythmType || 'sinus';

    // -------------------------------------------------------------------------
    // RHYTHM SPECIALIZATION: ASYSTOLE (VENTRICULAR FLATLINE)
    // -------------------------------------------------------------------------
    if (rhythm === 'asystole') {
      const thermalNoise = 0.008 * (Math.sin(t * 29.3) * Math.cos(t * 43.1));
      const drift = 0.012 * Math.sin(2.0 * Math.PI * 0.12 * t);
      return {
        x: thermalNoise + drift * 0.4,
        y: thermalNoise * 0.8 + drift,
        z: thermalNoise * 0.6 - drift * 0.3,
      };
    }

    // -------------------------------------------------------------------------
    // RHYTHM SPECIALIZATION: COARSE VENTRICULAR FIBRILLATION (VFib Coarse)
    // Chaotic 3D wandering rotor, dominant frequency ~6.5 Hz, amplitude 0.4 - 0.8 mV
    // -------------------------------------------------------------------------
    if (rhythm === 'vfib_coarse') {
      const f1 = 6.2;
      const f2 = 7.4;
      const f3 = 5.1;
      const rx = 0.48 * Math.sin(2.0 * Math.PI * f1 * t) + 0.22 * Math.sin(2.0 * Math.PI * f2 * t + 1.3);
      const ry = 0.58 * Math.sin(2.0 * Math.PI * f2 * t + 0.8) + 0.26 * Math.sin(2.0 * Math.PI * f3 * t + 2.4);
      const rz = 0.38 * Math.cos(2.0 * Math.PI * f1 * t + 1.1) + 0.19 * Math.sin(2.0 * Math.PI * f3 * t + 0.5);
      return { x: rx, y: ry, z: rz };
    }

    // -------------------------------------------------------------------------
    // RHYTHM SPECIALIZATION: FINE VENTRICULAR FIBRILLATION (VFib Fine)
    // Degenerated low-amplitude chaotic rotor (~3.8 Hz, amplitude < 0.18 mV)
    // -------------------------------------------------------------------------
    if (rhythm === 'vfib_fine') {
      const f1 = 3.6;
      const f2 = 4.4;
      const rx = 0.11 * Math.sin(2.0 * Math.PI * f1 * t) + 0.05 * Math.sin(2.0 * Math.PI * f2 * t + 1.1);
      const ry = 0.14 * Math.sin(2.0 * Math.PI * f2 * t + 0.7) + 0.06 * Math.sin(2.0 * Math.PI * f1 * t + 2.1);
      const rz = 0.09 * Math.cos(2.0 * Math.PI * f1 * t + 0.9) + 0.04 * Math.sin(2.0 * Math.PI * f2 * t + 0.3);
      return { x: rx, y: ry, z: rz };
    }

    // -------------------------------------------------------------------------
    // RHYTHM SPECIALIZATION: COMPLETE 3RD-DEGREE AV BLOCK
    // Dual independent oscillators: Atrial Sinus (75 bpm) vs Idioventricular (35 bpm)
    // P-waves march through QRS complexes with complete AV dissociation.
    // -------------------------------------------------------------------------
    if (rhythm === 'av_block_3rd') {
      const hrAtria = 75.0;
      const omegaA = (2.0 * Math.PI * hrAtria) / 60.0;
      const phaseA = ((omegaA * t) % (2.0 * Math.PI)) - Math.PI;

      const hrV = 35.0;
      const omegaV = (2.0 * Math.PI * hrV) / 60.0;
      const phaseV = ((omegaV * t) % (2.0 * Math.PI)) - Math.PI;

      // Independent Atrial P-wave dipole
      let dThetaA = (phaseA - (-1.20)) % (2.0 * Math.PI);
      if (dThetaA > Math.PI) dThetaA -= 2.0 * Math.PI;
      if (dThetaA < -Math.PI) dThetaA += 2.0 * Math.PI;
      const pGauss = Math.exp(-(dThetaA * dThetaA) / (2.0 * 0.16 * 0.16));
      const pDipole: Vector3D = {
        x: 0.12 * pGauss,
        y: 0.18 * pGauss,
        z: 0.04 * pGauss,
      };

      // Independent Idioventricular QRS-T dipole (wide QRS)
      const vWaves: GaussianWaveDef[] = [
        { name: 'Q', thetaCenter: -0.25, bWidth: 0.09, amplitude: { x: -0.10, y: -0.05, z: -0.12 } },
        { name: 'R', thetaCenter:  0.00, bWidth: 0.14, amplitude: { x:  1.15, y:  1.40, z:  0.65 } },
        { name: 'S', thetaCenter:  0.25, bWidth: 0.11, amplitude: { x: -0.25, y: -0.45, z:  0.35 } },
        { name: 'T', thetaCenter:  1.40, bWidth: 0.35, amplitude: { x:  0.32, y:  0.38, z:  0.08 } },
      ];

      let vx = 0.0;
      let vy = 0.0;
      let vz = 0.0;
      for (let i = 0; i < vWaves.length; i++) {
        const w = vWaves[i];
        let dTheta = (phaseV - w.thetaCenter) % (2.0 * Math.PI);
        if (dTheta > Math.PI) dTheta -= 2.0 * Math.PI;
        if (dTheta < -Math.PI) dTheta += 2.0 * Math.PI;
        const g = Math.exp(-(dTheta * dTheta) / (2.0 * w.bWidth * w.bWidth));
        vx += w.amplitude.x * g;
        vy += w.amplitude.y * g;
        vz += w.amplitude.z * g;
      }

      return {
        x: pDipole.x + vx,
        y: pDipole.y + vy,
        z: pDipole.z + vz,
      };
    }

    // -------------------------------------------------------------------------
    // STANDARD / MODULATED CELLULAR ELECTROPHYSIOLOGY
    // -------------------------------------------------------------------------
    // 1. Rate-Restitution adjustments (Fridericia cubic root scaling)
    const effectiveHr = Math.max(30, factors.heartRate);
    const rrSec = 60.0 / effectiveHr;
    const qtScale = Math.pow(rrSec, 1.0 / 3.0);

    // 2. Potassium (K+) modulations on cellular electrophysiology
    const k = factors.serumPotassium;
    const isHyperK = k > 5.2;
    const isHypoK = k < 3.5;

    const hyperKRatio = Math.max(0, (k - 5.0) / 4.0);
    const hypoKRatio = Math.max(0, (3.5 - k) / 1.5);

    let pAmpScale = Math.max(0.0, 1.0 - hyperKRatio * 1.2);
    let qrsWidthScale = 1.0 + hyperKRatio * 1.4;

    const tAmpScale = isHyperK
      ? 1.0 + hyperKRatio * 2.2
      : Math.max(0.15, 1.0 - hypoKRatio * 0.85);

    const tWidthScale = isHyperK
      ? Math.max(0.55, 1.0 - hyperKRatio * 0.45)
      : 1.0 + hypoKRatio * 0.5;

    // 3. Calcium (Ca2+) modulations on ST duration
    const ca = factors.serumCalcium;
    const caRatio = (ca - 9.5) / 5.0;
    const stShift = -caRatio * 0.18;

    // Terminal Sine Wave check for critical hyperkalemia (K+ > 8.5)
    if (k > 8.5) {
      const sineWave = Math.sin(phase);
      return {
        x: sineWave * 0.70,
        y: sineWave * 0.90,
        z: sineWave * 0.35,
      };
    }

    // -------------------------------------------------------------------------
    // RHYTHM SPECIALIZATION: VENTRICULAR TACHYCARDIA & TORSADES DE POINTES
    // -------------------------------------------------------------------------
    const isVtach = rhythm === 'vtach' || rhythm === 'torsades';
    if (isVtach) {
      pAmpScale = 0.0;
      qrsWidthScale = 2.2;
    }

    // In AFib or AFlutter, eliminate organized sinus P-wave
    if (rhythm === 'afib' || rhythm === 'aflutter') {
      pAmpScale = 0.0;
    }

    // 4. Waveform centers and widths
    const thetaP = -1.20;
    const bP = 0.16;

    const thetaQ = -0.25;
    const bQ = 0.05 * qrsWidthScale;

    const thetaR = 0.00;
    const bR = 0.07 * qrsWidthScale;

    const thetaS = 0.22;
    const bS = 0.06 * qrsWidthScale;

    const thetaT = 1.35 * qtScale + stShift;
    const bT = 0.30 * tWidthScale;

    const waves: GaussianWaveDef[] = [];

    // P Wave (Sinus Atrial Depolarization)
    if (pAmpScale > 0.001) {
      waves.push({
        name: 'P',
        thetaCenter: thetaP,
        bWidth: bP,
        amplitude: {
          x: 0.12 * pAmpScale,
          y: 0.18 * pAmpScale,
          z: 0.04 * pAmpScale,
        },
      });
    }

    // Ventricular Complex (Q, R, S, T)
    if (isVtach) {
      // Ectopic Ventricular Focus: Extreme Northwest Axis and Discordant T
      waves.push(
        {
          name: 'Q_VT',
          thetaCenter: -0.30,
          bWidth: 0.10,
          amplitude: { x: 0.20, y: 0.30, z: -0.15 },
        },
        {
          name: 'R_VT',
          thetaCenter: 0.00,
          bWidth: 0.16,
          amplitude: { x: -0.85, y: -1.20, z: 0.55 },
        },
        {
          name: 'S_VT',
          thetaCenter: 0.30,
          bWidth: 0.12,
          amplitude: { x: 0.35, y: 0.50, z: -0.25 },
        },
        {
          name: 'T_VT',
          thetaCenter: 1.20,
          bWidth: 0.35,
          amplitude: { x: 0.45, y: 0.60, z: -0.30 }, // Discordant opposite polarity
        }
      );
    } else {
      // Normal Conduction Pathway
      waves.push(
        {
          name: 'Q',
          thetaCenter: thetaQ,
          bWidth: bQ,
          amplitude: { x: -0.10, y: -0.05, z: -0.12 },
        },
        {
          name: 'R',
          thetaCenter: thetaR,
          bWidth: bR,
          amplitude: { x: 1.15, y: 1.40, z: 0.65 },
        },
        {
          name: 'S',
          thetaCenter: thetaS,
          bWidth: bS,
          amplitude: { x: -0.25, y: -0.45, z: 0.35 },
        },
        {
          name: 'T',
          thetaCenter: thetaT,
          bWidth: bT,
          amplitude: {
            x: 0.32 * tAmpScale,
            y: 0.38 * tAmpScale,
            z: 0.08 * tAmpScale,
          },
        }
      );
    }

    // Hypokalemic U wave (appears following T wave)
    if (isHypoK && !isVtach) {
      waves.push({
        name: 'U',
        thetaCenter: thetaT + 0.55,
        bWidth: 0.22,
        amplitude: {
          x: 0.10 * hypoKRatio,
          y: 0.14 * hypoKRatio,
          z: -0.06 * hypoKRatio,
        },
      });
    }

    // 5. Acute Coronary Ischemic Injury Vector (Current of Injury)
    const injuryVector: Vector3D = { x: 0.0, y: 0.0, z: 0.0 };

    if (factors.ladStenosisPercent > 50) {
      const ladSeverity = (factors.ladStenosisPercent - 50) / 50.0;
      injuryVector.x += 0.22 * ladSeverity;
      injuryVector.y += 0.08 * ladSeverity;
      injuryVector.z -= 0.55 * ladSeverity;
    }

    if (factors.rcaStenosisPercent > 50) {
      const rcaSeverity = (factors.rcaStenosisPercent - 50) / 50.0;
      injuryVector.x -= 0.15 * rcaSeverity;
      injuryVector.y += 0.48 * rcaSeverity;
      injuryVector.z += 0.10 * rcaSeverity;
    }

    if (factors.lcxStenosisPercent > 50) {
      const lcxSeverity = (factors.lcxStenosisPercent - 50) / 50.0;
      injuryVector.x += 0.45 * lcxSeverity;
      injuryVector.y -= 0.20 * lcxSeverity;
      injuryVector.z += 0.35 * lcxSeverity;
    }

    if (Math.abs(injuryVector.x) > 0.001 || Math.abs(injuryVector.y) > 0.001 || Math.abs(injuryVector.z) > 0.001) {
      waves.push({
        name: 'ST_Injury',
        thetaCenter: 0.65,
        bWidth: 0.35,
        amplitude: injuryVector,
      });
    }

    // 6. Analytical summation of wrapped Gaussians in 3D
    let px = 0.0;
    let py = 0.0;
    let pz = 0.0;

    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      let dTheta = (phase - w.thetaCenter) % (2.0 * Math.PI);
      if (dTheta > Math.PI) dTheta -= 2.0 * Math.PI;
      if (dTheta < -Math.PI) dTheta += 2.0 * Math.PI;

      const gauss = Math.exp(-(dTheta * dTheta) / (2.0 * w.bWidth * w.bWidth));
      px += w.amplitude.x * gauss;
      py += w.amplitude.y * gauss;
      pz += w.amplitude.z * gauss;
    }

    // 7. Continuous Atrial Fibrillation f-waves
    if (rhythm === 'afib') {
      const fx = 0.04 * Math.sin(2.0 * Math.PI * 6.2 * t + 0.5) + 0.02 * Math.sin(2.0 * Math.PI * 8.1 * t + 1.2);
      const fy = 0.06 * Math.sin(2.0 * Math.PI * 5.7 * t + 2.1) + 0.03 * Math.sin(2.0 * Math.PI * 7.4 * t + 0.8);
      const fz = -0.05 * Math.sin(2.0 * Math.PI * 6.5 * t + 1.8) - 0.03 * Math.sin(2.0 * Math.PI * 8.6 * t + 3.0);
      px += fx;
      py += fy;
      pz += fz;
    }

    // 8. Continuous Atrial Flutter Sawtooth waves (300 bpm = 5 Hz)
    if (rhythm === 'aflutter') {
      const fSawtooth = ((t * 5.0) % 1.0) - 0.5;
      px -= 0.05 * fSawtooth;
      py += 0.15 * fSawtooth;
      pz -= 0.08 * fSawtooth;
    }

    // 9. Dynamic 3D Precession Operator for Torsades de Pointes
    if (rhythm === 'torsades') {
      const twistPeriod = 4.0; // 4 second spindle envelope cycle
      const phi = (2.0 * Math.PI * t) / twistPeriod;
      // Precession axis u = (1, 1, 1) / sqrt(3)
      const ux = 0.57735;
      const uy = 0.57735;
      const uz = 0.57735;

      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);
      const dot = ux * px + uy * py + uz * pz;

      // Rodrigues rotation formula: v_rot = v*cosP + (u x v)*sinP + u*(u.v)*(1 - cosP)
      const crossX = uy * pz - uz * py;
      const crossY = uz * px - ux * pz;
      const crossZ = ux * py - uy * px;

      const oneMinusCos = 1.0 - cosP;
      const rx = px * cosP + crossX * sinP + ux * dot * oneMinusCos;
      const ry = py * cosP + crossY * sinP + uy * dot * oneMinusCos;
      const rz = pz * cosP + crossZ * sinP + uz * dot * oneMinusCos;

      return { x: rx, y: ry, z: rz };
    }

    return { x: px, y: py, z: pz };
  }

  /**
   * Advances the internal cardiac cycle phase and returns the updated phase.
   */
  public advancePhase(
    dtSeconds: number,
    heartRateOrFactors: number | ClinicalFactors
  ): number {
    this.timeSeconds += dtSeconds;
    const hr = typeof heartRateOrFactors === 'number' ? heartRateOrFactors : heartRateOrFactors.heartRate;
    const effectiveHr = Math.max(1, hr);
    const omega = (2.0 * Math.PI * effectiveHr) / 60.0;
    this.phase += omega * dtSeconds;
    while (this.phase > Math.PI) {
      this.phase -= 2.0 * Math.PI;
    }
    while (this.phase < -Math.PI) {
      this.phase += 2.0 * Math.PI;
    }
    return this.phase;
  }

  public getPhase(): number {
    return this.phase;
  }

  public getTimeSeconds(): number {
    return this.timeSeconds;
  }

  public resetPhase(newPhase: number = -Math.PI): void {
    this.phase = newPhase;
    this.timeSeconds = 0;
  }

  /**
   * Helper: Converts Frank VCG coordinates to Three.js coordinates
   */
  public static toGraphicsCoords(v: Vector3D): Vector3D {
    return {
      x: v.x,   // Patient Left (+X)
      y: -v.y,  // Inferior becomes Upwards (+Y)
      z: -v.z,  // Posterior becomes Anterior (+Z)
    };
  }
}

/**
 * Returns the active physiological cardiac conduction phase from the cycle phase angle.
 * Phase mapping: P (Atrium) -> PR (AV Nodus) -> QRS (Depol Ventrikel) -> ST (Plateau) -> T (Repolarisasi) -> Diastol.
 */
export function getCardiacConductionPhase(
  phase: number,
  rhythm: string = 'sinus'
): CardiacConductionPhaseInfo {
  if (rhythm === 'vfib_coarse' || rhythm === 'vfib_fine') {
    return {
      key: 'QRS',
      label: 'Fibrilasi Ventrikel',
      organ: 'Kekacauan Gelombang Putar 3D (Rotor)',
      color: 'bg-rose-700 text-white',
    };
  }
  if (rhythm === 'asystole') {
    return {
      key: 'Diastole',
      label: 'Asistol (Flatline)',
      organ: 'Henti Listrik Miokard Total',
      color: 'bg-slate-700 text-white',
    };
  }
  if (rhythm === 'vtach' || rhythm === 'torsades') {
    return {
      key: 'QRS',
      label: rhythm === 'torsades' ? 'Torsades de Pointes' : 'Takikardia Ventrikel',
      organ: 'Depolarisasi Ektopik Ventrikel Cepat',
      color: 'bg-rose-600 text-white',
    };
  }

  if (phase >= -1.55 && phase < -0.85) {
    return {
      key: 'P',
      label: rhythm === 'afib' ? 'Gelombang f (Kacau)' : 'Gelombang P',
      organ: rhythm === 'afib' ? 'Atrium (Fibrilasi Mikro-Reentran)' : 'Atrium (Depolarisasi)',
      color: rhythm === 'afib' ? 'bg-amber-600 text-white' : 'bg-sky-600 text-white',
    };
  } else if (phase >= -0.85 && phase < -0.32) {
    return {
      key: 'PR',
      label: 'Interval PR',
      organ: 'AV Nodus (Konduksi Fisiologis)',
      color: 'bg-emerald-600 text-white',
    };
  } else if (phase >= -0.32 && phase < 0.32) {
    return {
      key: 'QRS',
      label: 'Kompleks QRS',
      organ: 'Ventrikel (Depolarisasi Cepat)',
      color: 'bg-rose-600 text-white',
    };
  } else if (phase >= 0.32 && phase < 0.95) {
    return {
      key: 'ST',
      label: 'Segmen ST',
      organ: 'Plateau Potensial Aksi Miokard',
      color: 'bg-amber-600 text-white',
    };
  } else if (phase >= 0.95 && phase < 1.85) {
    return {
      key: 'T',
      label: 'Gelombang T',
      organ: 'Ventrikel (Repolarisasi Cepat)',
      color: 'bg-purple-600 text-white',
    };
  } else {
    return {
      key: 'Diastole',
      label: 'Fase Diastol',
      organ: 'Polarisasi Istirahat & Pengisian',
      color: 'bg-slate-500 text-white',
    };
  }
}
