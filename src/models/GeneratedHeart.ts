import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Atlas Cardiac Model
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createAtlasCardiacModelModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Atlas Cardiac Model";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"view": "front", "projection": "orthographic", "position": [0, 0.15, 5], "target": [0, 0.15, 0], "notes": "Anterior atlas crop, patient left is +X on screen right. Fixed camera for pass comparison."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["myocardium"] = createSculptMaterial(
    "myocardium",
    {"id": "myocardium", "name": "myocardium", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#c96861", "color": "#c96861", "albedo": {"dominant": "#c96861", "secondary": ["#c96861"], "samplingNotes": "Atlas illustration region; not inverse-rendered living tissue"}, "colorVariation": {"palette": ["#c96861"], "pattern": "mottled", "amplitude": 0.04, "heightCorrelation": 0.3}, "roughness": {"base": 0.48, "variation": 0.03}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "myocardium-variation", "description": "Subtle independent height-dependent tissue tone", "evidenceRefs": ["anterior-atlas"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Atlas color; physical PBR scalar inferred and intentionally restrained.", "textureless": {"declared": true, "evidence": ["OpenStax anterior/posterior atlas has flat illustrated tissue color zones; coronary lines and striation are modeled as named geometry, not photographic texture.", "modeling/intake.md: physical PBR microstructure cannot be inferred from the diagram."]}},
    options
  );
  materialMap["atrium"] = createSculptMaterial(
    "atrium",
    {"id": "atrium", "name": "atrium", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#a94e53", "color": "#a94e53", "albedo": {"dominant": "#a94e53", "secondary": ["#a94e53"], "samplingNotes": "Atlas illustration region; not inverse-rendered living tissue"}, "colorVariation": {"palette": ["#a94e53"], "pattern": "mottled", "amplitude": 0.04, "heightCorrelation": 0.3}, "roughness": {"base": 0.48, "variation": 0.03}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "atrium-variation", "description": "Subtle independent height-dependent tissue tone", "evidenceRefs": ["anterior-atlas"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Atlas color; physical PBR scalar inferred and intentionally restrained.", "textureless": {"declared": true, "evidence": ["OpenStax anterior/posterior atlas has flat illustrated tissue color zones; coronary lines and striation are modeled as named geometry, not photographic texture.", "modeling/intake.md: physical PBR microstructure cannot be inferred from the diagram."]}},
    options
  );
  materialMap["artery"] = createSculptMaterial(
    "artery",
    {"id": "artery", "name": "artery", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#c53736", "color": "#c53736", "albedo": {"dominant": "#c53736", "secondary": ["#c53736"], "samplingNotes": "Atlas illustration region; not inverse-rendered living tissue"}, "colorVariation": {"palette": ["#c53736"], "pattern": "mottled", "amplitude": 0.04, "heightCorrelation": 0.3}, "roughness": {"base": 0.48, "variation": 0.03}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "artery-variation", "description": "Subtle independent height-dependent tissue tone", "evidenceRefs": ["anterior-atlas"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Atlas color; physical PBR scalar inferred and intentionally restrained.", "textureless": {"declared": true, "evidence": ["OpenStax anterior/posterior atlas has flat illustrated tissue color zones; coronary lines and striation are modeled as named geometry, not photographic texture.", "modeling/intake.md: physical PBR microstructure cannot be inferred from the diagram."]}},
    options
  );
  materialMap["vein"] = createSculptMaterial(
    "vein",
    {"id": "vein", "name": "vein", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#456d9e", "color": "#456d9e", "albedo": {"dominant": "#456d9e", "secondary": ["#456d9e"], "samplingNotes": "Atlas illustration region; not inverse-rendered living tissue"}, "colorVariation": {"palette": ["#456d9e"], "pattern": "mottled", "amplitude": 0.04, "heightCorrelation": 0.3}, "roughness": {"base": 0.48, "variation": 0.03}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "vein-variation", "description": "Subtle independent height-dependent tissue tone", "evidenceRefs": ["anterior-atlas"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Atlas color; physical PBR scalar inferred and intentionally restrained.", "textureless": {"declared": true, "evidence": ["OpenStax anterior/posterior atlas has flat illustrated tissue color zones; coronary lines and striation are modeled as named geometry, not photographic texture.", "modeling/intake.md: physical PBR microstructure cannot be inferred from the diagram."]}},
    options
  );
  materialMap["fat"] = createSculptMaterial(
    "fat",
    {"id": "fat", "name": "fat", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#ecd398", "color": "#ecd398", "albedo": {"dominant": "#ecd398", "secondary": ["#ecd398"], "samplingNotes": "Atlas illustration region; not inverse-rendered living tissue"}, "colorVariation": {"palette": ["#ecd398"], "pattern": "mottled", "amplitude": 0.04, "heightCorrelation": 0.3}, "roughness": {"base": 0.48, "variation": 0.03}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "fat-variation", "description": "Subtle independent height-dependent tissue tone", "evidenceRefs": ["anterior-atlas"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Atlas color; physical PBR scalar inferred and intentionally restrained.", "textureless": {"declared": true, "evidence": ["OpenStax anterior/posterior atlas has flat illustrated tissue color zones; coronary lines and striation are modeled as named geometry, not photographic texture.", "modeling/intake.md: physical PBR microstructure cannot be inferred from the diagram."]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Heart root__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Heart root", "level": "macro", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Invisible transform container; all surfaces are named children.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "visible": false, "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 104, 97, 1)", "secondaryAlbedo": "rgba(201, 104, 97, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Heart root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Heart root", "level": "macro", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Invisible transform container; all surfaces are named children.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "visible": false, "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 104, 97, 1)", "secondaryAlbedo": "rgba(201, 104, 97, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_lv_1 = makeAttachmentEndpoint(null);
  const node_lv_1 = new THREE.Group();
  node_lv_1.name = "\u5de6\u5fc3\u5ba4__pivot";
  node_lv_1.scale.set(1, 1, 1);
  if (endpoint_lv_1) {
    node_lv_1.position.copy(endpoint_lv_1.start);
    node_lv_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lv_1.position.set(0.22, -0.28, -0.02);
    node_lv_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_lv_1.userData.sculptComponent = {"id": "lv", "name": "左心室", "level": "macro", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.92, "height": 1.48, "depth": 0.82, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.22, -0.28, -0.02], "rotation": [0, 0, 0], "scale": [0.92, 1.48, 0.82]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lv", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "apical-taper", "description": "Inferior-left taper and oblique long axis", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 104, 97, 1)", "secondaryAlbedo": "rgba(201, 104, 97, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_lv_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lv", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["root"] ?? root).add(node_lv_1);
  nodes["lv"] = node_lv_1;
  const mesh_lv_1Geometry = endpoint_lv_1
    ? new THREE.CylinderGeometry(endpoint_lv_1.endRadius, endpoint_lv_1.baseRadius, endpoint_lv_1.length, 32, 12)
    : buildLatheGeometry({"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48});
  if (!endpoint_lv_1) {
    mesh_lv_1Geometry.scale(0.92, 1.48, 0.82);
  }
  const mesh_lv_1 = new THREE.Mesh(
    mesh_lv_1Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lv_1.name = "\u5de6\u5fc3\u5ba4";
  if (endpoint_lv_1) {
    mesh_lv_1.position.copy(endpoint_lv_1.midpoint);
    mesh_lv_1.quaternion.copy(endpoint_lv_1.quaternion);
  }
  mesh_lv_1.castShadow = options.castShadow ?? true;
  mesh_lv_1.receiveShadow = options.receiveShadow ?? true;
  mesh_lv_1.userData.sculptComponent = {"id": "lv", "name": "左心室", "level": "macro", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.92, "height": 1.48, "depth": 0.82, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.22, -0.28, -0.02], "rotation": [0, 0, 0], "scale": [0.92, 1.48, 0.82]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lv", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "apical-taper", "description": "Inferior-left taper and oblique long axis", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 104, 97, 1)", "secondaryAlbedo": "rgba(201, 104, 97, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_lv_1.add(mesh_lv_1);
  meshes["lv"] = mesh_lv_1;
  colliders["lv"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["lv"] ??= [];
  destructionGroups["lv"].push(node_lv_1);

  const endpoint_rv_2 = makeAttachmentEndpoint(null);
  const node_rv_2 = new THREE.Group();
  node_rv_2.name = "\u53f3\u5fc3\u5ba4__pivot";
  node_rv_2.scale.set(1, 1, 1);
  if (endpoint_rv_2) {
    node_rv_2.position.copy(endpoint_rv_2.start);
    node_rv_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rv_2.position.set(-0.27, -0.17, 0.2);
    node_rv_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_rv_2.userData.sculptComponent = {"id": "rv", "name": "右心室", "level": "macro", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.9, "height": 1.25, "depth": 0.59, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.27, -0.17, 0.2], "rotation": [0, 0, 0], "scale": [0.9, 1.25, 0.59]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rv", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "anterior-crescent", "description": "Broad anterior RV face meets LV at a shared sulcus", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 104, 97, 1)", "secondaryAlbedo": "rgba(201, 104, 97, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_rv_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rv", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["root"] ?? root).add(node_rv_2);
  nodes["rv"] = node_rv_2;
  const mesh_rv_2Geometry = endpoint_rv_2
    ? new THREE.CylinderGeometry(endpoint_rv_2.endRadius, endpoint_rv_2.baseRadius, endpoint_rv_2.length, 32, 12)
    : buildLatheGeometry({"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48});
  if (!endpoint_rv_2) {
    mesh_rv_2Geometry.scale(0.9, 1.25, 0.59);
  }
  const mesh_rv_2 = new THREE.Mesh(
    mesh_rv_2Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rv_2.name = "\u53f3\u5fc3\u5ba4";
  if (endpoint_rv_2) {
    mesh_rv_2.position.copy(endpoint_rv_2.midpoint);
    mesh_rv_2.quaternion.copy(endpoint_rv_2.quaternion);
  }
  mesh_rv_2.castShadow = options.castShadow ?? true;
  mesh_rv_2.receiveShadow = options.receiveShadow ?? true;
  mesh_rv_2.userData.sculptComponent = {"id": "rv", "name": "右心室", "level": "macro", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.9, "height": 1.25, "depth": 0.59, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.27, -0.17, 0.2], "rotation": [0, 0, 0], "scale": [0.9, 1.25, 0.59]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rv", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "anterior-crescent", "description": "Broad anterior RV face meets LV at a shared sulcus", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 104, 97, 1)", "secondaryAlbedo": "rgba(201, 104, 97, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_rv_2.add(mesh_rv_2);
  meshes["rv"] = mesh_rv_2;
  colliders["rv"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["rv"] ??= [];
  destructionGroups["rv"].push(node_rv_2);

  const endpoint_ra_3 = makeAttachmentEndpoint(null);
  const node_ra_3 = new THREE.Group();
  node_ra_3.name = "\u53f3\u5fc3\u623f__pivot";
  node_ra_3.scale.set(1, 1, 1);
  if (endpoint_ra_3) {
    node_ra_3.position.copy(endpoint_ra_3.start);
    node_ra_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ra_3.position.set(-0.57, 0.34, 0.06);
    node_ra_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_ra_3.userData.sculptComponent = {"id": "ra", "name": "右心房", "level": "macro", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.62, "height": 0.75, "depth": 0.52, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.57, 0.34, 0.06], "rotation": [0, 0, 0], "scale": [0.62, 0.75, 0.52]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ra", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}}, "material": "atrium", "materialLayers": ["atrium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "atrial-lobes", "description": "Irregular overlapping atrial profile", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 78, 83, 1)", "secondaryAlbedo": "rgba(169, 78, 83, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_ra_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ra", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}};
  (nodes["root"] ?? root).add(node_ra_3);
  nodes["ra"] = node_ra_3;
  const mesh_ra_3Geometry = endpoint_ra_3
    ? new THREE.CylinderGeometry(endpoint_ra_3.endRadius, endpoint_ra_3.baseRadius, endpoint_ra_3.length, 32, 12)
    : buildLatheGeometry({"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48});
  if (!endpoint_ra_3) {
    mesh_ra_3Geometry.scale(0.62, 0.75, 0.52);
  }
  const mesh_ra_3 = new THREE.Mesh(
    mesh_ra_3Geometry,
    materialMap["atrium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ra_3.name = "\u53f3\u5fc3\u623f";
  if (endpoint_ra_3) {
    mesh_ra_3.position.copy(endpoint_ra_3.midpoint);
    mesh_ra_3.quaternion.copy(endpoint_ra_3.quaternion);
  }
  mesh_ra_3.castShadow = options.castShadow ?? true;
  mesh_ra_3.receiveShadow = options.receiveShadow ?? true;
  mesh_ra_3.userData.sculptComponent = {"id": "ra", "name": "右心房", "level": "macro", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.62, "height": 0.75, "depth": 0.52, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.57, 0.34, 0.06], "rotation": [0, 0, 0], "scale": [0.62, 0.75, 0.52]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ra", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}}, "material": "atrium", "materialLayers": ["atrium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "atrial-lobes", "description": "Irregular overlapping atrial profile", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 78, 83, 1)", "secondaryAlbedo": "rgba(169, 78, 83, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_ra_3.add(mesh_ra_3);
  meshes["ra"] = mesh_ra_3;
  colliders["ra"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ra"] ??= [];
  destructionGroups["ra"].push(node_ra_3);

  const endpoint_la_4 = makeAttachmentEndpoint(null);
  const node_la_4 = new THREE.Group();
  node_la_4.name = "\u5de6\u5fc3\u623f__pivot";
  node_la_4.scale.set(1, 1, 1);
  if (endpoint_la_4) {
    node_la_4.position.copy(endpoint_la_4.start);
    node_la_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_la_4.position.set(0.2, 0.4, -0.4);
    node_la_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_la_4.userData.sculptComponent = {"id": "la", "name": "左心房", "level": "macro", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.75, "height": 0.59, "depth": 0.53, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2, 0.4, -0.4], "rotation": [0, 0, 0], "scale": [0.75, 0.59, 0.53]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "la", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}}, "material": "atrium", "materialLayers": ["atrium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "posterior-location", "description": "Left atrial body predominantly behind great vessels", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 78, 83, 1)", "secondaryAlbedo": "rgba(169, 78, 83, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_la_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "la", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}};
  (nodes["root"] ?? root).add(node_la_4);
  nodes["la"] = node_la_4;
  const mesh_la_4Geometry = endpoint_la_4
    ? new THREE.CylinderGeometry(endpoint_la_4.endRadius, endpoint_la_4.baseRadius, endpoint_la_4.length, 32, 12)
    : buildLatheGeometry({"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48});
  if (!endpoint_la_4) {
    mesh_la_4Geometry.scale(0.75, 0.59, 0.53);
  }
  const mesh_la_4 = new THREE.Mesh(
    mesh_la_4Geometry,
    materialMap["atrium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_la_4.name = "\u5de6\u5fc3\u623f";
  if (endpoint_la_4) {
    mesh_la_4.position.copy(endpoint_la_4.midpoint);
    mesh_la_4.quaternion.copy(endpoint_la_4.quaternion);
  }
  mesh_la_4.castShadow = options.castShadow ?? true;
  mesh_la_4.receiveShadow = options.receiveShadow ?? true;
  mesh_la_4.userData.sculptComponent = {"id": "la", "name": "左心房", "level": "macro", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.75, "height": 0.59, "depth": 0.53, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2, 0.4, -0.4], "rotation": [0, 0, 0], "scale": [0.75, 0.59, 0.53]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "la", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}}, "material": "atrium", "materialLayers": ["atrium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "posterior-location", "description": "Left atrial body predominantly behind great vessels", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 78, 83, 1)", "secondaryAlbedo": "rgba(169, 78, 83, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_la_4.add(mesh_la_4);
  meshes["la"] = mesh_la_4;
  colliders["la"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["la"] ??= [];
  destructionGroups["la"].push(node_la_4);

  const attachment_aorta_5 = {"parentSocket": "aorta-root", "localStart": [0, 0.24, 0], "localEnd": [0.58, 0.33, -0.38], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.135, "endRadius": 0.10800000000000001, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_aorta_5 = makeAttachmentEndpoint(attachment_aorta_5);
  const node_aorta_5 = new THREE.Group();
  node_aorta_5.name = "\u4e3b\u52a8\u8109\u5f13__pivot";
  node_aorta_5.scale.set(1, 1, 1);
  if (endpoint_aorta_5) {
    node_aorta_5.position.copy(endpoint_aorta_5.start);
    node_aorta_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_aorta_5.position.set(0.0, 0.0, 0.0);
    node_aorta_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_aorta_5.userData.sculptComponent = {"id": "aorta", "name": "主动脉弓", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0, 0.24, 0], [0, 0.72, -0.05], [0.13, 1.06, -0.14], [0.48, 1.13, -0.23], [0.67, 0.94, -0.32], [0.58, 0.33, -0.38]], "radius": 0.135, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0, 0.24, 0], [0, 0.72, -0.05], [0.13, 1.06, -0.14], [0.48, 1.13, -0.23], [0.67, 0.94, -0.32], [0.58, 0.33, -0.38]], "radius": 0.135, "wallThickness": 0.0216, "lumen": true}}, "parent": "lv", "attachment": {"parentSocket": "aorta-root", "localStart": [0, 0.24, 0], "localEnd": [0.58, 0.33, -0.38], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.135, "endRadius": 0.10800000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aorta", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arch-curve", "description": "Arch curves posterior to pulmonary trunk", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_aorta_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aorta", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["lv"] ?? root).add(node_aorta_5);
  nodes["aorta"] = node_aorta_5;
  const mesh_aorta_5Geometry = endpoint_aorta_5
    ? new THREE.CylinderGeometry(endpoint_aorta_5.endRadius, endpoint_aorta_5.baseRadius, endpoint_aorta_5.length, 32, 12)
    : buildTubeGeometry({"points": [[0, 0.24, 0], [0, 0.72, -0.05], [0.13, 1.06, -0.14], [0.48, 1.13, -0.23], [0.67, 0.94, -0.32], [0.58, 0.33, -0.38]], "radius": 0.135, "radialSegments": 16, "closed": false});
  if (!endpoint_aorta_5) {
    mesh_aorta_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_aorta_5 = new THREE.Mesh(
    mesh_aorta_5Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_aorta_5.name = "\u4e3b\u52a8\u8109\u5f13";
  if (endpoint_aorta_5) {
    mesh_aorta_5.position.copy(endpoint_aorta_5.midpoint);
    mesh_aorta_5.quaternion.copy(endpoint_aorta_5.quaternion);
  }
  mesh_aorta_5.castShadow = options.castShadow ?? true;
  mesh_aorta_5.receiveShadow = options.receiveShadow ?? true;
  mesh_aorta_5.userData.sculptComponent = {"id": "aorta", "name": "主动脉弓", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0, 0.24, 0], [0, 0.72, -0.05], [0.13, 1.06, -0.14], [0.48, 1.13, -0.23], [0.67, 0.94, -0.32], [0.58, 0.33, -0.38]], "radius": 0.135, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0, 0.24, 0], [0, 0.72, -0.05], [0.13, 1.06, -0.14], [0.48, 1.13, -0.23], [0.67, 0.94, -0.32], [0.58, 0.33, -0.38]], "radius": 0.135, "wallThickness": 0.0216, "lumen": true}}, "parent": "lv", "attachment": {"parentSocket": "aorta-root", "localStart": [0, 0.24, 0], "localEnd": [0.58, 0.33, -0.38], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.135, "endRadius": 0.10800000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aorta", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arch-curve", "description": "Arch curves posterior to pulmonary trunk", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_aorta_5.add(mesh_aorta_5);
  meshes["aorta"] = mesh_aorta_5;
  colliders["aorta"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["aorta"] ??= [];
  destructionGroups["aorta"].push(node_aorta_5);

  const attachment_pulmonary_6 = {"parentSocket": "pulmonary-root", "localStart": [-0.17, 0.18, 0.27], "localEnd": [0.53, 0.81, 0.15], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.14, "endRadius": 0.11200000000000002, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_pulmonary_6 = makeAttachmentEndpoint(attachment_pulmonary_6);
  const node_pulmonary_6 = new THREE.Group();
  node_pulmonary_6.name = "\u80ba\u52a8\u8109\u5e72__pivot";
  node_pulmonary_6.scale.set(1, 1, 1);
  if (endpoint_pulmonary_6) {
    node_pulmonary_6.position.copy(endpoint_pulmonary_6.start);
    node_pulmonary_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pulmonary_6.position.set(0.0, 0.0, 0.0);
    node_pulmonary_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_pulmonary_6.userData.sculptComponent = {"id": "pulmonary", "name": "肺动脉干", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[-0.17, 0.18, 0.27], [-0.1, 0.57, 0.35], [0.12, 0.78, 0.29], [0.53, 0.81, 0.15]], "radius": 0.14, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[-0.17, 0.18, 0.27], [-0.1, 0.57, 0.35], [0.12, 0.78, 0.29], [0.53, 0.81, 0.15]], "radius": 0.14, "wallThickness": 0.022400000000000003, "lumen": true}}, "parent": "rv", "attachment": {"parentSocket": "pulmonary-root", "localStart": [-0.17, 0.18, 0.27], "localEnd": [0.53, 0.81, 0.15], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.14, "endRadius": 0.11200000000000002, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "anterior-crossing", "description": "Pulmonary trunk passes anterior to ascending aorta", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}};
  (nodes["rv"] ?? root).add(node_pulmonary_6);
  nodes["pulmonary"] = node_pulmonary_6;
  const mesh_pulmonary_6Geometry = endpoint_pulmonary_6
    ? new THREE.CylinderGeometry(endpoint_pulmonary_6.endRadius, endpoint_pulmonary_6.baseRadius, endpoint_pulmonary_6.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.17, 0.18, 0.27], [-0.1, 0.57, 0.35], [0.12, 0.78, 0.29], [0.53, 0.81, 0.15]], "radius": 0.14, "radialSegments": 16, "closed": false});
  if (!endpoint_pulmonary_6) {
    mesh_pulmonary_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pulmonary_6 = new THREE.Mesh(
    mesh_pulmonary_6Geometry,
    materialMap["vein"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pulmonary_6.name = "\u80ba\u52a8\u8109\u5e72";
  if (endpoint_pulmonary_6) {
    mesh_pulmonary_6.position.copy(endpoint_pulmonary_6.midpoint);
    mesh_pulmonary_6.quaternion.copy(endpoint_pulmonary_6.quaternion);
  }
  mesh_pulmonary_6.castShadow = options.castShadow ?? true;
  mesh_pulmonary_6.receiveShadow = options.receiveShadow ?? true;
  mesh_pulmonary_6.userData.sculptComponent = {"id": "pulmonary", "name": "肺动脉干", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[-0.17, 0.18, 0.27], [-0.1, 0.57, 0.35], [0.12, 0.78, 0.29], [0.53, 0.81, 0.15]], "radius": 0.14, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[-0.17, 0.18, 0.27], [-0.1, 0.57, 0.35], [0.12, 0.78, 0.29], [0.53, 0.81, 0.15]], "radius": 0.14, "wallThickness": 0.022400000000000003, "lumen": true}}, "parent": "rv", "attachment": {"parentSocket": "pulmonary-root", "localStart": [-0.17, 0.18, 0.27], "localEnd": [0.53, 0.81, 0.15], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.14, "endRadius": 0.11200000000000002, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "anterior-crossing", "description": "Pulmonary trunk passes anterior to ascending aorta", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_6.add(mesh_pulmonary_6);
  meshes["pulmonary"] = mesh_pulmonary_6;
  colliders["pulmonary"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pulmonary"] ??= [];
  destructionGroups["pulmonary"].push(node_pulmonary_6);

  const attachment_svc_7 = {"parentSocket": "svc-root", "localStart": [-0.55, 0.36, -0.04], "localEnd": [-0.59, 1.07, -0.17], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.12, "endRadius": 0.096, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_svc_7 = makeAttachmentEndpoint(attachment_svc_7);
  const node_svc_7 = new THREE.Group();
  node_svc_7.name = "\u4e0a\u8154\u9759\u8109__pivot";
  node_svc_7.scale.set(1, 1, 1);
  if (endpoint_svc_7) {
    node_svc_7.position.copy(endpoint_svc_7.start);
    node_svc_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_svc_7.position.set(0.0, 0.0, 0.0);
    node_svc_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_svc_7.userData.sculptComponent = {"id": "svc", "name": "上腔静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[-0.55, 0.36, -0.04], [-0.58, 0.76, -0.13], [-0.59, 1.07, -0.17]], "radius": 0.12, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[-0.55, 0.36, -0.04], [-0.58, 0.76, -0.13], [-0.59, 1.07, -0.17]], "radius": 0.12, "wallThickness": 0.0192, "lumen": true}}, "parent": "ra", "attachment": {"parentSocket": "svc-root", "localStart": [-0.55, 0.36, -0.04], "localEnd": [-0.59, 1.07, -0.17], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.12, "endRadius": 0.096, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "svc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lumen-lip", "description": "Thin vessel wall around open cut end", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_svc_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "svc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}};
  (nodes["ra"] ?? root).add(node_svc_7);
  nodes["svc"] = node_svc_7;
  const mesh_svc_7Geometry = endpoint_svc_7
    ? new THREE.CylinderGeometry(endpoint_svc_7.endRadius, endpoint_svc_7.baseRadius, endpoint_svc_7.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.55, 0.36, -0.04], [-0.58, 0.76, -0.13], [-0.59, 1.07, -0.17]], "radius": 0.12, "radialSegments": 16, "closed": false});
  if (!endpoint_svc_7) {
    mesh_svc_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_svc_7 = new THREE.Mesh(
    mesh_svc_7Geometry,
    materialMap["vein"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_svc_7.name = "\u4e0a\u8154\u9759\u8109";
  if (endpoint_svc_7) {
    mesh_svc_7.position.copy(endpoint_svc_7.midpoint);
    mesh_svc_7.quaternion.copy(endpoint_svc_7.quaternion);
  }
  mesh_svc_7.castShadow = options.castShadow ?? true;
  mesh_svc_7.receiveShadow = options.receiveShadow ?? true;
  mesh_svc_7.userData.sculptComponent = {"id": "svc", "name": "上腔静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[-0.55, 0.36, -0.04], [-0.58, 0.76, -0.13], [-0.59, 1.07, -0.17]], "radius": 0.12, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[-0.55, 0.36, -0.04], [-0.58, 0.76, -0.13], [-0.59, 1.07, -0.17]], "radius": 0.12, "wallThickness": 0.0192, "lumen": true}}, "parent": "ra", "attachment": {"parentSocket": "svc-root", "localStart": [-0.55, 0.36, -0.04], "localEnd": [-0.59, 1.07, -0.17], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.12, "endRadius": 0.096, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "svc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lumen-lip", "description": "Thin vessel wall around open cut end", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_svc_7.add(mesh_svc_7);
  meshes["svc"] = mesh_svc_7;
  colliders["svc"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["svc"] ??= [];
  destructionGroups["svc"].push(node_svc_7);

  const attachment_ivc_8 = {"parentSocket": "ivc-root", "localStart": [-0.57, 0.25, -0.1], "localEnd": [-0.55, -0.45, -0.2], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.13, "endRadius": 0.10400000000000001, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_ivc_8 = makeAttachmentEndpoint(attachment_ivc_8);
  const node_ivc_8 = new THREE.Group();
  node_ivc_8.name = "\u4e0b\u8154\u9759\u8109__pivot";
  node_ivc_8.scale.set(1, 1, 1);
  if (endpoint_ivc_8) {
    node_ivc_8.position.copy(endpoint_ivc_8.start);
    node_ivc_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ivc_8.position.set(0.0, 0.0, 0.0);
    node_ivc_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_ivc_8.userData.sculptComponent = {"id": "ivc", "name": "下腔静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[-0.57, 0.25, -0.1], [-0.59, -0.08, -0.17], [-0.55, -0.45, -0.2]], "radius": 0.13, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[-0.57, 0.25, -0.1], [-0.59, -0.08, -0.17], [-0.55, -0.45, -0.2]], "radius": 0.13, "wallThickness": 0.020800000000000003, "lumen": true}}, "parent": "ra", "attachment": {"parentSocket": "ivc-root", "localStart": [-0.57, 0.25, -0.1], "localEnd": [-0.55, -0.45, -0.2], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.13, "endRadius": 0.10400000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ivc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_ivc_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ivc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}};
  (nodes["ra"] ?? root).add(node_ivc_8);
  nodes["ivc"] = node_ivc_8;
  const mesh_ivc_8Geometry = endpoint_ivc_8
    ? new THREE.CylinderGeometry(endpoint_ivc_8.endRadius, endpoint_ivc_8.baseRadius, endpoint_ivc_8.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.57, 0.25, -0.1], [-0.59, -0.08, -0.17], [-0.55, -0.45, -0.2]], "radius": 0.13, "radialSegments": 16, "closed": false});
  if (!endpoint_ivc_8) {
    mesh_ivc_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ivc_8 = new THREE.Mesh(
    mesh_ivc_8Geometry,
    materialMap["vein"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ivc_8.name = "\u4e0b\u8154\u9759\u8109";
  if (endpoint_ivc_8) {
    mesh_ivc_8.position.copy(endpoint_ivc_8.midpoint);
    mesh_ivc_8.quaternion.copy(endpoint_ivc_8.quaternion);
  }
  mesh_ivc_8.castShadow = options.castShadow ?? true;
  mesh_ivc_8.receiveShadow = options.receiveShadow ?? true;
  mesh_ivc_8.userData.sculptComponent = {"id": "ivc", "name": "下腔静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[-0.57, 0.25, -0.1], [-0.59, -0.08, -0.17], [-0.55, -0.45, -0.2]], "radius": 0.13, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[-0.57, 0.25, -0.1], [-0.59, -0.08, -0.17], [-0.55, -0.45, -0.2]], "radius": 0.13, "wallThickness": 0.020800000000000003, "lumen": true}}, "parent": "ra", "attachment": {"parentSocket": "ivc-root", "localStart": [-0.57, 0.25, -0.1], "localEnd": [-0.55, -0.45, -0.2], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.13, "endRadius": 0.10400000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ivc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_ivc_8.add(mesh_ivc_8);
  meshes["ivc"] = mesh_ivc_8;
  colliders["ivc"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ivc"] ??= [];
  destructionGroups["ivc"].push(node_ivc_8);

  const attachment_aortic_branch_1_9 = {"parentSocket": "aortic-branch-1-root", "localStart": [0.09, 0.97, -0.14], "localEnd": [-0.1, 1.45, -0.08], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.065, "endRadius": 0.052000000000000005, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_aortic_branch_1_9 = makeAttachmentEndpoint(attachment_aortic_branch_1_9);
  const node_aortic_branch_1_9 = new THREE.Group();
  node_aortic_branch_1_9.name = "\u5934\u81c2\u5e72__pivot";
  node_aortic_branch_1_9.scale.set(1, 1, 1);
  if (endpoint_aortic_branch_1_9) {
    node_aortic_branch_1_9.position.copy(endpoint_aortic_branch_1_9.start);
    node_aortic_branch_1_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_aortic_branch_1_9.position.set(0.0, 0.0, 0.0);
    node_aortic_branch_1_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_aortic_branch_1_9.userData.sculptComponent = {"id": "aortic-branch-1", "name": "头臂干", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.09, 0.97, -0.14], [-0.03, 1.29, -0.11], [-0.1, 1.45, -0.08]], "radius": 0.065, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.09, 0.97, -0.14], [-0.03, 1.29, -0.11], [-0.1, 1.45, -0.08]], "radius": 0.065, "wallThickness": 0.010400000000000001, "lumen": true}}, "parent": "aorta", "attachment": {"parentSocket": "aortic-branch-1-root", "localStart": [0.09, 0.97, -0.14], "localEnd": [-0.1, 1.45, -0.08], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.065, "endRadius": 0.052000000000000005, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-branch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_aortic_branch_1_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-branch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["aorta"] ?? root).add(node_aortic_branch_1_9);
  nodes["aortic-branch-1"] = node_aortic_branch_1_9;
  const mesh_aortic_branch_1_9Geometry = endpoint_aortic_branch_1_9
    ? new THREE.CylinderGeometry(endpoint_aortic_branch_1_9.endRadius, endpoint_aortic_branch_1_9.baseRadius, endpoint_aortic_branch_1_9.length, 32, 12)
    : buildTubeGeometry({"points": [[0.09, 0.97, -0.14], [-0.03, 1.29, -0.11], [-0.1, 1.45, -0.08]], "radius": 0.065, "radialSegments": 16, "closed": false});
  if (!endpoint_aortic_branch_1_9) {
    mesh_aortic_branch_1_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_aortic_branch_1_9 = new THREE.Mesh(
    mesh_aortic_branch_1_9Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_aortic_branch_1_9.name = "\u5934\u81c2\u5e72";
  if (endpoint_aortic_branch_1_9) {
    mesh_aortic_branch_1_9.position.copy(endpoint_aortic_branch_1_9.midpoint);
    mesh_aortic_branch_1_9.quaternion.copy(endpoint_aortic_branch_1_9.quaternion);
  }
  mesh_aortic_branch_1_9.castShadow = options.castShadow ?? true;
  mesh_aortic_branch_1_9.receiveShadow = options.receiveShadow ?? true;
  mesh_aortic_branch_1_9.userData.sculptComponent = {"id": "aortic-branch-1", "name": "头臂干", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.09, 0.97, -0.14], [-0.03, 1.29, -0.11], [-0.1, 1.45, -0.08]], "radius": 0.065, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.09, 0.97, -0.14], [-0.03, 1.29, -0.11], [-0.1, 1.45, -0.08]], "radius": 0.065, "wallThickness": 0.010400000000000001, "lumen": true}}, "parent": "aorta", "attachment": {"parentSocket": "aortic-branch-1-root", "localStart": [0.09, 0.97, -0.14], "localEnd": [-0.1, 1.45, -0.08], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.065, "endRadius": 0.052000000000000005, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-branch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_aortic_branch_1_9.add(mesh_aortic_branch_1_9);
  meshes["aortic-branch-1"] = mesh_aortic_branch_1_9;
  colliders["aortic-branch-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["aortic-branch-1"] ??= [];
  destructionGroups["aortic-branch-1"].push(node_aortic_branch_1_9);

  const attachment_aortic_branch_2_10 = {"parentSocket": "aortic-branch-2-root", "localStart": [0.29, 1.1, -0.2], "localEnd": [0.32, 1.45, -0.19], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.055, "endRadius": 0.044000000000000004, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_aortic_branch_2_10 = makeAttachmentEndpoint(attachment_aortic_branch_2_10);
  const node_aortic_branch_2_10 = new THREE.Group();
  node_aortic_branch_2_10.name = "\u5de6\u9888\u603b\u52a8\u8109__pivot";
  node_aortic_branch_2_10.scale.set(1, 1, 1);
  if (endpoint_aortic_branch_2_10) {
    node_aortic_branch_2_10.position.copy(endpoint_aortic_branch_2_10.start);
    node_aortic_branch_2_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_aortic_branch_2_10.position.set(0.0, 0.0, 0.0);
    node_aortic_branch_2_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_aortic_branch_2_10.userData.sculptComponent = {"id": "aortic-branch-2", "name": "左颈总动脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.29, 1.1, -0.2], [0.32, 1.45, -0.19]], "radius": 0.055, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.29, 1.1, -0.2], [0.32, 1.45, -0.19]], "radius": 0.055, "wallThickness": 0.0088, "lumen": true}}, "parent": "aorta", "attachment": {"parentSocket": "aortic-branch-2-root", "localStart": [0.29, 1.1, -0.2], "localEnd": [0.32, 1.45, -0.19], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.055, "endRadius": 0.044000000000000004, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-branch-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_aortic_branch_2_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-branch-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["aorta"] ?? root).add(node_aortic_branch_2_10);
  nodes["aortic-branch-2"] = node_aortic_branch_2_10;
  const mesh_aortic_branch_2_10Geometry = endpoint_aortic_branch_2_10
    ? new THREE.CylinderGeometry(endpoint_aortic_branch_2_10.endRadius, endpoint_aortic_branch_2_10.baseRadius, endpoint_aortic_branch_2_10.length, 32, 12)
    : buildTubeGeometry({"points": [[0.29, 1.1, -0.2], [0.32, 1.45, -0.19]], "radius": 0.055, "radialSegments": 16, "closed": false});
  if (!endpoint_aortic_branch_2_10) {
    mesh_aortic_branch_2_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_aortic_branch_2_10 = new THREE.Mesh(
    mesh_aortic_branch_2_10Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_aortic_branch_2_10.name = "\u5de6\u9888\u603b\u52a8\u8109";
  if (endpoint_aortic_branch_2_10) {
    mesh_aortic_branch_2_10.position.copy(endpoint_aortic_branch_2_10.midpoint);
    mesh_aortic_branch_2_10.quaternion.copy(endpoint_aortic_branch_2_10.quaternion);
  }
  mesh_aortic_branch_2_10.castShadow = options.castShadow ?? true;
  mesh_aortic_branch_2_10.receiveShadow = options.receiveShadow ?? true;
  mesh_aortic_branch_2_10.userData.sculptComponent = {"id": "aortic-branch-2", "name": "左颈总动脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.29, 1.1, -0.2], [0.32, 1.45, -0.19]], "radius": 0.055, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.29, 1.1, -0.2], [0.32, 1.45, -0.19]], "radius": 0.055, "wallThickness": 0.0088, "lumen": true}}, "parent": "aorta", "attachment": {"parentSocket": "aortic-branch-2-root", "localStart": [0.29, 1.1, -0.2], "localEnd": [0.32, 1.45, -0.19], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.055, "endRadius": 0.044000000000000004, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-branch-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_aortic_branch_2_10.add(mesh_aortic_branch_2_10);
  meshes["aortic-branch-2"] = mesh_aortic_branch_2_10;
  colliders["aortic-branch-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["aortic-branch-2"] ??= [];
  destructionGroups["aortic-branch-2"].push(node_aortic_branch_2_10);

  const attachment_aortic_branch_3_11 = {"parentSocket": "aortic-branch-3-root", "localStart": [0.44, 1.07, -0.25], "localEnd": [0.58, 1.37, -0.3], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.06, "endRadius": 0.048, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_aortic_branch_3_11 = makeAttachmentEndpoint(attachment_aortic_branch_3_11);
  const node_aortic_branch_3_11 = new THREE.Group();
  node_aortic_branch_3_11.name = "\u5de6\u9501\u9aa8\u4e0b\u52a8\u8109__pivot";
  node_aortic_branch_3_11.scale.set(1, 1, 1);
  if (endpoint_aortic_branch_3_11) {
    node_aortic_branch_3_11.position.copy(endpoint_aortic_branch_3_11.start);
    node_aortic_branch_3_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_aortic_branch_3_11.position.set(0.0, 0.0, 0.0);
    node_aortic_branch_3_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_aortic_branch_3_11.userData.sculptComponent = {"id": "aortic-branch-3", "name": "左锁骨下动脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.44, 1.07, -0.25], [0.58, 1.37, -0.3]], "radius": 0.06, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.44, 1.07, -0.25], [0.58, 1.37, -0.3]], "radius": 0.06, "wallThickness": 0.0096, "lumen": true}}, "parent": "aorta", "attachment": {"parentSocket": "aortic-branch-3-root", "localStart": [0.44, 1.07, -0.25], "localEnd": [0.58, 1.37, -0.3], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.06, "endRadius": 0.048, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-branch-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_aortic_branch_3_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-branch-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["aorta"] ?? root).add(node_aortic_branch_3_11);
  nodes["aortic-branch-3"] = node_aortic_branch_3_11;
  const mesh_aortic_branch_3_11Geometry = endpoint_aortic_branch_3_11
    ? new THREE.CylinderGeometry(endpoint_aortic_branch_3_11.endRadius, endpoint_aortic_branch_3_11.baseRadius, endpoint_aortic_branch_3_11.length, 32, 12)
    : buildTubeGeometry({"points": [[0.44, 1.07, -0.25], [0.58, 1.37, -0.3]], "radius": 0.06, "radialSegments": 16, "closed": false});
  if (!endpoint_aortic_branch_3_11) {
    mesh_aortic_branch_3_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_aortic_branch_3_11 = new THREE.Mesh(
    mesh_aortic_branch_3_11Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_aortic_branch_3_11.name = "\u5de6\u9501\u9aa8\u4e0b\u52a8\u8109";
  if (endpoint_aortic_branch_3_11) {
    mesh_aortic_branch_3_11.position.copy(endpoint_aortic_branch_3_11.midpoint);
    mesh_aortic_branch_3_11.quaternion.copy(endpoint_aortic_branch_3_11.quaternion);
  }
  mesh_aortic_branch_3_11.castShadow = options.castShadow ?? true;
  mesh_aortic_branch_3_11.receiveShadow = options.receiveShadow ?? true;
  mesh_aortic_branch_3_11.userData.sculptComponent = {"id": "aortic-branch-3", "name": "左锁骨下动脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.44, 1.07, -0.25], [0.58, 1.37, -0.3]], "radius": 0.06, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.44, 1.07, -0.25], [0.58, 1.37, -0.3]], "radius": 0.06, "wallThickness": 0.0096, "lumen": true}}, "parent": "aorta", "attachment": {"parentSocket": "aortic-branch-3-root", "localStart": [0.44, 1.07, -0.25], "localEnd": [0.58, 1.37, -0.3], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.06, "endRadius": 0.048, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-branch-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_aortic_branch_3_11.add(mesh_aortic_branch_3_11);
  meshes["aortic-branch-3"] = mesh_aortic_branch_3_11;
  colliders["aortic-branch-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["aortic-branch-3"] ??= [];
  destructionGroups["aortic-branch-3"].push(node_aortic_branch_3_11);

  const attachment_pulmonary_right_12 = {"parentSocket": "pulmonary-right-root", "localStart": [0.02, 0.68, 0.05], "localEnd": [-0.85, 0.73, -0.26], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.095, "endRadius": 0.07600000000000001, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_pulmonary_right_12 = makeAttachmentEndpoint(attachment_pulmonary_right_12);
  const node_pulmonary_right_12 = new THREE.Group();
  node_pulmonary_right_12.name = "\u53f3\u80ba\u52a8\u8109__pivot";
  node_pulmonary_right_12.scale.set(1, 1, 1);
  if (endpoint_pulmonary_right_12) {
    node_pulmonary_right_12.position.copy(endpoint_pulmonary_right_12.start);
    node_pulmonary_right_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pulmonary_right_12.position.set(0.0, 0.0, 0.0);
    node_pulmonary_right_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_pulmonary_right_12.userData.sculptComponent = {"id": "pulmonary-right", "name": "右肺动脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.02, 0.68, 0.05], [-0.35, 0.76, -0.24], [-0.85, 0.73, -0.26]], "radius": 0.095, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.02, 0.68, 0.05], [-0.35, 0.76, -0.24], [-0.85, 0.73, -0.26]], "radius": 0.095, "wallThickness": 0.0152, "lumen": true}}, "parent": "pulmonary", "attachment": {"parentSocket": "pulmonary-right-root", "localStart": [0.02, 0.68, 0.05], "localEnd": [-0.85, 0.73, -0.26], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.095, "endRadius": 0.07600000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_right_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}};
  (nodes["pulmonary"] ?? root).add(node_pulmonary_right_12);
  nodes["pulmonary-right"] = node_pulmonary_right_12;
  const mesh_pulmonary_right_12Geometry = endpoint_pulmonary_right_12
    ? new THREE.CylinderGeometry(endpoint_pulmonary_right_12.endRadius, endpoint_pulmonary_right_12.baseRadius, endpoint_pulmonary_right_12.length, 32, 12)
    : buildTubeGeometry({"points": [[0.02, 0.68, 0.05], [-0.35, 0.76, -0.24], [-0.85, 0.73, -0.26]], "radius": 0.095, "radialSegments": 16, "closed": false});
  if (!endpoint_pulmonary_right_12) {
    mesh_pulmonary_right_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pulmonary_right_12 = new THREE.Mesh(
    mesh_pulmonary_right_12Geometry,
    materialMap["vein"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pulmonary_right_12.name = "\u53f3\u80ba\u52a8\u8109";
  if (endpoint_pulmonary_right_12) {
    mesh_pulmonary_right_12.position.copy(endpoint_pulmonary_right_12.midpoint);
    mesh_pulmonary_right_12.quaternion.copy(endpoint_pulmonary_right_12.quaternion);
  }
  mesh_pulmonary_right_12.castShadow = options.castShadow ?? true;
  mesh_pulmonary_right_12.receiveShadow = options.receiveShadow ?? true;
  mesh_pulmonary_right_12.userData.sculptComponent = {"id": "pulmonary-right", "name": "右肺动脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.02, 0.68, 0.05], [-0.35, 0.76, -0.24], [-0.85, 0.73, -0.26]], "radius": 0.095, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.02, 0.68, 0.05], [-0.35, 0.76, -0.24], [-0.85, 0.73, -0.26]], "radius": 0.095, "wallThickness": 0.0152, "lumen": true}}, "parent": "pulmonary", "attachment": {"parentSocket": "pulmonary-right-root", "localStart": [0.02, 0.68, 0.05], "localEnd": [-0.85, 0.73, -0.26], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.095, "endRadius": 0.07600000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_right_12.add(mesh_pulmonary_right_12);
  meshes["pulmonary-right"] = mesh_pulmonary_right_12;
  colliders["pulmonary-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pulmonary-right"] ??= [];
  destructionGroups["pulmonary-right"].push(node_pulmonary_right_12);

  const attachment_pulmonary_vein_left_upper_13 = {"parentSocket": "pulmonary-vein-left-upper-root", "localStart": [0.25, 0.43, -0.4], "localEnd": [0.86, 0.59, -0.46], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_pulmonary_vein_left_upper_13 = makeAttachmentEndpoint(attachment_pulmonary_vein_left_upper_13);
  const node_pulmonary_vein_left_upper_13 = new THREE.Group();
  node_pulmonary_vein_left_upper_13.name = "\u5de6\u4e0a\u80ba\u9759\u8109__pivot";
  node_pulmonary_vein_left_upper_13.scale.set(1, 1, 1);
  if (endpoint_pulmonary_vein_left_upper_13) {
    node_pulmonary_vein_left_upper_13.position.copy(endpoint_pulmonary_vein_left_upper_13.start);
    node_pulmonary_vein_left_upper_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pulmonary_vein_left_upper_13.position.set(0.0, 0.0, 0.0);
    node_pulmonary_vein_left_upper_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_pulmonary_vein_left_upper_13.userData.sculptComponent = {"id": "pulmonary-vein-left-upper", "name": "左上肺静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.25, 0.43, -0.4], [0.67, 0.53, -0.45], [0.86, 0.59, -0.46]], "radius": 0.07, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.25, 0.43, -0.4], [0.67, 0.53, -0.45], [0.86, 0.59, -0.46]], "radius": 0.07, "wallThickness": 0.011200000000000002, "lumen": true}}, "parent": "la", "attachment": {"parentSocket": "pulmonary-vein-left-upper-root", "localStart": [0.25, 0.43, -0.4], "localEnd": [0.86, 0.59, -0.46], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-left-upper", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_vein_left_upper_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-left-upper", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["la"] ?? root).add(node_pulmonary_vein_left_upper_13);
  nodes["pulmonary-vein-left-upper"] = node_pulmonary_vein_left_upper_13;
  const mesh_pulmonary_vein_left_upper_13Geometry = endpoint_pulmonary_vein_left_upper_13
    ? new THREE.CylinderGeometry(endpoint_pulmonary_vein_left_upper_13.endRadius, endpoint_pulmonary_vein_left_upper_13.baseRadius, endpoint_pulmonary_vein_left_upper_13.length, 32, 12)
    : buildTubeGeometry({"points": [[0.25, 0.43, -0.4], [0.67, 0.53, -0.45], [0.86, 0.59, -0.46]], "radius": 0.07, "radialSegments": 16, "closed": false});
  if (!endpoint_pulmonary_vein_left_upper_13) {
    mesh_pulmonary_vein_left_upper_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pulmonary_vein_left_upper_13 = new THREE.Mesh(
    mesh_pulmonary_vein_left_upper_13Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pulmonary_vein_left_upper_13.name = "\u5de6\u4e0a\u80ba\u9759\u8109";
  if (endpoint_pulmonary_vein_left_upper_13) {
    mesh_pulmonary_vein_left_upper_13.position.copy(endpoint_pulmonary_vein_left_upper_13.midpoint);
    mesh_pulmonary_vein_left_upper_13.quaternion.copy(endpoint_pulmonary_vein_left_upper_13.quaternion);
  }
  mesh_pulmonary_vein_left_upper_13.castShadow = options.castShadow ?? true;
  mesh_pulmonary_vein_left_upper_13.receiveShadow = options.receiveShadow ?? true;
  mesh_pulmonary_vein_left_upper_13.userData.sculptComponent = {"id": "pulmonary-vein-left-upper", "name": "左上肺静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.25, 0.43, -0.4], [0.67, 0.53, -0.45], [0.86, 0.59, -0.46]], "radius": 0.07, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.25, 0.43, -0.4], [0.67, 0.53, -0.45], [0.86, 0.59, -0.46]], "radius": 0.07, "wallThickness": 0.011200000000000002, "lumen": true}}, "parent": "la", "attachment": {"parentSocket": "pulmonary-vein-left-upper-root", "localStart": [0.25, 0.43, -0.4], "localEnd": [0.86, 0.59, -0.46], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-left-upper", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_vein_left_upper_13.add(mesh_pulmonary_vein_left_upper_13);
  meshes["pulmonary-vein-left-upper"] = mesh_pulmonary_vein_left_upper_13;
  colliders["pulmonary-vein-left-upper"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pulmonary-vein-left-upper"] ??= [];
  destructionGroups["pulmonary-vein-left-upper"].push(node_pulmonary_vein_left_upper_13);

  const attachment_pulmonary_vein_left_lower_14 = {"parentSocket": "pulmonary-vein-left-lower-root", "localStart": [0.25, 0.26, -0.43], "localEnd": [0.84, 0.32, -0.48], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_pulmonary_vein_left_lower_14 = makeAttachmentEndpoint(attachment_pulmonary_vein_left_lower_14);
  const node_pulmonary_vein_left_lower_14 = new THREE.Group();
  node_pulmonary_vein_left_lower_14.name = "\u5de6\u4e0b\u80ba\u9759\u8109__pivot";
  node_pulmonary_vein_left_lower_14.scale.set(1, 1, 1);
  if (endpoint_pulmonary_vein_left_lower_14) {
    node_pulmonary_vein_left_lower_14.position.copy(endpoint_pulmonary_vein_left_lower_14.start);
    node_pulmonary_vein_left_lower_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pulmonary_vein_left_lower_14.position.set(0.0, 0.0, 0.0);
    node_pulmonary_vein_left_lower_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_pulmonary_vein_left_lower_14.userData.sculptComponent = {"id": "pulmonary-vein-left-lower", "name": "左下肺静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.25, 0.26, -0.43], [0.68, 0.3, -0.48], [0.84, 0.32, -0.48]], "radius": 0.07, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.25, 0.26, -0.43], [0.68, 0.3, -0.48], [0.84, 0.32, -0.48]], "radius": 0.07, "wallThickness": 0.011200000000000002, "lumen": true}}, "parent": "la", "attachment": {"parentSocket": "pulmonary-vein-left-lower-root", "localStart": [0.25, 0.26, -0.43], "localEnd": [0.84, 0.32, -0.48], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-left-lower", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_vein_left_lower_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-left-lower", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["la"] ?? root).add(node_pulmonary_vein_left_lower_14);
  nodes["pulmonary-vein-left-lower"] = node_pulmonary_vein_left_lower_14;
  const mesh_pulmonary_vein_left_lower_14Geometry = endpoint_pulmonary_vein_left_lower_14
    ? new THREE.CylinderGeometry(endpoint_pulmonary_vein_left_lower_14.endRadius, endpoint_pulmonary_vein_left_lower_14.baseRadius, endpoint_pulmonary_vein_left_lower_14.length, 32, 12)
    : buildTubeGeometry({"points": [[0.25, 0.26, -0.43], [0.68, 0.3, -0.48], [0.84, 0.32, -0.48]], "radius": 0.07, "radialSegments": 16, "closed": false});
  if (!endpoint_pulmonary_vein_left_lower_14) {
    mesh_pulmonary_vein_left_lower_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pulmonary_vein_left_lower_14 = new THREE.Mesh(
    mesh_pulmonary_vein_left_lower_14Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pulmonary_vein_left_lower_14.name = "\u5de6\u4e0b\u80ba\u9759\u8109";
  if (endpoint_pulmonary_vein_left_lower_14) {
    mesh_pulmonary_vein_left_lower_14.position.copy(endpoint_pulmonary_vein_left_lower_14.midpoint);
    mesh_pulmonary_vein_left_lower_14.quaternion.copy(endpoint_pulmonary_vein_left_lower_14.quaternion);
  }
  mesh_pulmonary_vein_left_lower_14.castShadow = options.castShadow ?? true;
  mesh_pulmonary_vein_left_lower_14.receiveShadow = options.receiveShadow ?? true;
  mesh_pulmonary_vein_left_lower_14.userData.sculptComponent = {"id": "pulmonary-vein-left-lower", "name": "左下肺静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.25, 0.26, -0.43], [0.68, 0.3, -0.48], [0.84, 0.32, -0.48]], "radius": 0.07, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.25, 0.26, -0.43], [0.68, 0.3, -0.48], [0.84, 0.32, -0.48]], "radius": 0.07, "wallThickness": 0.011200000000000002, "lumen": true}}, "parent": "la", "attachment": {"parentSocket": "pulmonary-vein-left-lower-root", "localStart": [0.25, 0.26, -0.43], "localEnd": [0.84, 0.32, -0.48], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-left-lower", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_vein_left_lower_14.add(mesh_pulmonary_vein_left_lower_14);
  meshes["pulmonary-vein-left-lower"] = mesh_pulmonary_vein_left_lower_14;
  colliders["pulmonary-vein-left-lower"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pulmonary-vein-left-lower"] ??= [];
  destructionGroups["pulmonary-vein-left-lower"].push(node_pulmonary_vein_left_lower_14);

  const attachment_pulmonary_vein_right_upper_15 = {"parentSocket": "pulmonary-vein-right-upper-root", "localStart": [0.0, 0.43, -0.45], "localEnd": [-0.78, 0.56, -0.48], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_pulmonary_vein_right_upper_15 = makeAttachmentEndpoint(attachment_pulmonary_vein_right_upper_15);
  const node_pulmonary_vein_right_upper_15 = new THREE.Group();
  node_pulmonary_vein_right_upper_15.name = "\u53f3\u4e0a\u80ba\u9759\u8109__pivot";
  node_pulmonary_vein_right_upper_15.scale.set(1, 1, 1);
  if (endpoint_pulmonary_vein_right_upper_15) {
    node_pulmonary_vein_right_upper_15.position.copy(endpoint_pulmonary_vein_right_upper_15.start);
    node_pulmonary_vein_right_upper_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pulmonary_vein_right_upper_15.position.set(0.0, 0.0, 0.0);
    node_pulmonary_vein_right_upper_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_pulmonary_vein_right_upper_15.userData.sculptComponent = {"id": "pulmonary-vein-right-upper", "name": "右上肺静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.0, 0.43, -0.45], [-0.46, 0.54, -0.48], [-0.78, 0.56, -0.48]], "radius": 0.07, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.0, 0.43, -0.45], [-0.46, 0.54, -0.48], [-0.78, 0.56, -0.48]], "radius": 0.07, "wallThickness": 0.011200000000000002, "lumen": true}}, "parent": "la", "attachment": {"parentSocket": "pulmonary-vein-right-upper-root", "localStart": [0.0, 0.43, -0.45], "localEnd": [-0.78, 0.56, -0.48], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-right-upper", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_vein_right_upper_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-right-upper", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["la"] ?? root).add(node_pulmonary_vein_right_upper_15);
  nodes["pulmonary-vein-right-upper"] = node_pulmonary_vein_right_upper_15;
  const mesh_pulmonary_vein_right_upper_15Geometry = endpoint_pulmonary_vein_right_upper_15
    ? new THREE.CylinderGeometry(endpoint_pulmonary_vein_right_upper_15.endRadius, endpoint_pulmonary_vein_right_upper_15.baseRadius, endpoint_pulmonary_vein_right_upper_15.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, 0.43, -0.45], [-0.46, 0.54, -0.48], [-0.78, 0.56, -0.48]], "radius": 0.07, "radialSegments": 16, "closed": false});
  if (!endpoint_pulmonary_vein_right_upper_15) {
    mesh_pulmonary_vein_right_upper_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pulmonary_vein_right_upper_15 = new THREE.Mesh(
    mesh_pulmonary_vein_right_upper_15Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pulmonary_vein_right_upper_15.name = "\u53f3\u4e0a\u80ba\u9759\u8109";
  if (endpoint_pulmonary_vein_right_upper_15) {
    mesh_pulmonary_vein_right_upper_15.position.copy(endpoint_pulmonary_vein_right_upper_15.midpoint);
    mesh_pulmonary_vein_right_upper_15.quaternion.copy(endpoint_pulmonary_vein_right_upper_15.quaternion);
  }
  mesh_pulmonary_vein_right_upper_15.castShadow = options.castShadow ?? true;
  mesh_pulmonary_vein_right_upper_15.receiveShadow = options.receiveShadow ?? true;
  mesh_pulmonary_vein_right_upper_15.userData.sculptComponent = {"id": "pulmonary-vein-right-upper", "name": "右上肺静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.0, 0.43, -0.45], [-0.46, 0.54, -0.48], [-0.78, 0.56, -0.48]], "radius": 0.07, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.0, 0.43, -0.45], [-0.46, 0.54, -0.48], [-0.78, 0.56, -0.48]], "radius": 0.07, "wallThickness": 0.011200000000000002, "lumen": true}}, "parent": "la", "attachment": {"parentSocket": "pulmonary-vein-right-upper-root", "localStart": [0.0, 0.43, -0.45], "localEnd": [-0.78, 0.56, -0.48], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-right-upper", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_vein_right_upper_15.add(mesh_pulmonary_vein_right_upper_15);
  meshes["pulmonary-vein-right-upper"] = mesh_pulmonary_vein_right_upper_15;
  colliders["pulmonary-vein-right-upper"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pulmonary-vein-right-upper"] ??= [];
  destructionGroups["pulmonary-vein-right-upper"].push(node_pulmonary_vein_right_upper_15);

  const attachment_pulmonary_vein_right_lower_16 = {"parentSocket": "pulmonary-vein-right-lower-root", "localStart": [0.0, 0.24, -0.45], "localEnd": [-0.77, 0.32, -0.49], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]};
  const endpoint_pulmonary_vein_right_lower_16 = makeAttachmentEndpoint(attachment_pulmonary_vein_right_lower_16);
  const node_pulmonary_vein_right_lower_16 = new THREE.Group();
  node_pulmonary_vein_right_lower_16.name = "\u53f3\u4e0b\u80ba\u9759\u8109__pivot";
  node_pulmonary_vein_right_lower_16.scale.set(1, 1, 1);
  if (endpoint_pulmonary_vein_right_lower_16) {
    node_pulmonary_vein_right_lower_16.position.copy(endpoint_pulmonary_vein_right_lower_16.start);
    node_pulmonary_vein_right_lower_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pulmonary_vein_right_lower_16.position.set(0.0, 0.0, 0.0);
    node_pulmonary_vein_right_lower_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_pulmonary_vein_right_lower_16.userData.sculptComponent = {"id": "pulmonary-vein-right-lower", "name": "右下肺静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.0, 0.24, -0.45], [-0.45, 0.28, -0.49], [-0.77, 0.32, -0.49]], "radius": 0.07, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.0, 0.24, -0.45], [-0.45, 0.28, -0.49], [-0.77, 0.32, -0.49]], "radius": 0.07, "wallThickness": 0.011200000000000002, "lumen": true}}, "parent": "la", "attachment": {"parentSocket": "pulmonary-vein-right-lower-root", "localStart": [0.0, 0.24, -0.45], "localEnd": [-0.77, 0.32, -0.49], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-right-lower", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_vein_right_lower_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-right-lower", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["la"] ?? root).add(node_pulmonary_vein_right_lower_16);
  nodes["pulmonary-vein-right-lower"] = node_pulmonary_vein_right_lower_16;
  const mesh_pulmonary_vein_right_lower_16Geometry = endpoint_pulmonary_vein_right_lower_16
    ? new THREE.CylinderGeometry(endpoint_pulmonary_vein_right_lower_16.endRadius, endpoint_pulmonary_vein_right_lower_16.baseRadius, endpoint_pulmonary_vein_right_lower_16.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, 0.24, -0.45], [-0.45, 0.28, -0.49], [-0.77, 0.32, -0.49]], "radius": 0.07, "radialSegments": 16, "closed": false});
  if (!endpoint_pulmonary_vein_right_lower_16) {
    mesh_pulmonary_vein_right_lower_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pulmonary_vein_right_lower_16 = new THREE.Mesh(
    mesh_pulmonary_vein_right_lower_16Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pulmonary_vein_right_lower_16.name = "\u53f3\u4e0b\u80ba\u9759\u8109";
  if (endpoint_pulmonary_vein_right_lower_16) {
    mesh_pulmonary_vein_right_lower_16.position.copy(endpoint_pulmonary_vein_right_lower_16.midpoint);
    mesh_pulmonary_vein_right_lower_16.quaternion.copy(endpoint_pulmonary_vein_right_lower_16.quaternion);
  }
  mesh_pulmonary_vein_right_lower_16.castShadow = options.castShadow ?? true;
  mesh_pulmonary_vein_right_lower_16.receiveShadow = options.receiveShadow ?? true;
  mesh_pulmonary_vein_right_lower_16.userData.sculptComponent = {"id": "pulmonary-vein-right-lower", "name": "右下肺静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.0, 0.24, -0.45], [-0.45, 0.28, -0.49], [-0.77, 0.32, -0.49]], "radius": 0.07, "radialSegments": 16, "closed": false}, "medicalPath": {"coordinates": "root-local", "points": [[0.0, 0.24, -0.45], [-0.45, 0.28, -0.49], [-0.77, 0.32, -0.49]], "radius": 0.07, "wallThickness": 0.011200000000000002, "lumen": true}}, "parent": "la", "attachment": {"parentSocket": "pulmonary-vein-right-lower-root", "localStart": [0.0, 0.24, -0.45], "localEnd": [-0.77, 0.32, -0.49], "contactType": "embedded", "embedDepth": 0.04, "gapTolerance": 0.01, "baseRadius": 0.07, "endRadius": 0.05600000000000001, "evidenceRefs": ["anterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-vein-right-lower", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_pulmonary_vein_right_lower_16.add(mesh_pulmonary_vein_right_lower_16);
  meshes["pulmonary-vein-right-lower"] = mesh_pulmonary_vein_right_lower_16;
  colliders["pulmonary-vein-right-lower"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pulmonary-vein-right-lower"] ??= [];
  destructionGroups["pulmonary-vein-right-lower"].push(node_pulmonary_vein_right_lower_16);

  const endpoint_auricle_right_17 = makeAttachmentEndpoint(null);
  const node_auricle_right_17 = new THREE.Group();
  node_auricle_right_17.name = "\u53f3\u5fc3\u8033__pivot";
  node_auricle_right_17.scale.set(1, 1, 1);
  if (endpoint_auricle_right_17) {
    node_auricle_right_17.position.copy(endpoint_auricle_right_17.start);
    node_auricle_right_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_auricle_right_17.position.set(-0.5, 0.44, 0.3);
    node_auricle_right_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_auricle_right_17.userData.sculptComponent = {"id": "auricle-right", "name": "右心耳", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "ra", "attachment": null, "dimensions": {"width": 0.66, "height": 0.34, "depth": 0.27, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.5, 0.44, 0.3], "rotation": [0, 0, 0], "scale": [0.66, 0.34, 0.27]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "auricle-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}}, "material": "atrium", "materialLayers": ["atrium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "auricle-folds", "description": "Lobulated atrial appendage border", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 78, 83, 1)", "secondaryAlbedo": "rgba(169, 78, 83, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_auricle_right_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "auricle-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}};
  (nodes["ra"] ?? root).add(node_auricle_right_17);
  nodes["auricle-right"] = node_auricle_right_17;
  const mesh_auricle_right_17Geometry = endpoint_auricle_right_17
    ? new THREE.CylinderGeometry(endpoint_auricle_right_17.endRadius, endpoint_auricle_right_17.baseRadius, endpoint_auricle_right_17.length, 32, 12)
    : buildLatheGeometry({"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48});
  if (!endpoint_auricle_right_17) {
    mesh_auricle_right_17Geometry.scale(0.66, 0.34, 0.27);
  }
  const mesh_auricle_right_17 = new THREE.Mesh(
    mesh_auricle_right_17Geometry,
    materialMap["atrium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_auricle_right_17.name = "\u53f3\u5fc3\u8033";
  if (endpoint_auricle_right_17) {
    mesh_auricle_right_17.position.copy(endpoint_auricle_right_17.midpoint);
    mesh_auricle_right_17.quaternion.copy(endpoint_auricle_right_17.quaternion);
  }
  mesh_auricle_right_17.castShadow = options.castShadow ?? true;
  mesh_auricle_right_17.receiveShadow = options.receiveShadow ?? true;
  mesh_auricle_right_17.userData.sculptComponent = {"id": "auricle-right", "name": "右心耳", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "ra", "attachment": null, "dimensions": {"width": 0.66, "height": 0.34, "depth": 0.27, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.5, 0.44, 0.3], "rotation": [0, 0, 0], "scale": [0.66, 0.34, 0.27]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "auricle-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}}, "material": "atrium", "materialLayers": ["atrium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "auricle-folds", "description": "Lobulated atrial appendage border", "type": "contour"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 78, 83, 1)", "secondaryAlbedo": "rgba(169, 78, 83, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_auricle_right_17.add(mesh_auricle_right_17);
  meshes["auricle-right"] = mesh_auricle_right_17;
  colliders["auricle-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["auricle-right"] ??= [];
  destructionGroups["auricle-right"].push(node_auricle_right_17);

  const endpoint_auricle_left_18 = makeAttachmentEndpoint(null);
  const node_auricle_left_18 = new THREE.Group();
  node_auricle_left_18.name = "\u5de6\u5fc3\u8033__pivot";
  node_auricle_left_18.scale.set(1, 1, 1);
  if (endpoint_auricle_left_18) {
    node_auricle_left_18.position.copy(endpoint_auricle_left_18.start);
    node_auricle_left_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_auricle_left_18.position.set(0.42, 0.47, 0.25);
    node_auricle_left_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_auricle_left_18.userData.sculptComponent = {"id": "auricle-left", "name": "左心耳", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "la", "attachment": null, "dimensions": {"width": 0.4, "height": 0.31, "depth": 0.24, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.42, 0.47, 0.25], "rotation": [0, 0, 0], "scale": [0.4, 0.31, 0.24]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "auricle-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}}, "material": "atrium", "materialLayers": ["atrium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 78, 83, 1)", "secondaryAlbedo": "rgba(169, 78, 83, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_auricle_left_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "auricle-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}};
  (nodes["la"] ?? root).add(node_auricle_left_18);
  nodes["auricle-left"] = node_auricle_left_18;
  const mesh_auricle_left_18Geometry = endpoint_auricle_left_18
    ? new THREE.CylinderGeometry(endpoint_auricle_left_18.endRadius, endpoint_auricle_left_18.baseRadius, endpoint_auricle_left_18.length, 32, 12)
    : buildLatheGeometry({"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48});
  if (!endpoint_auricle_left_18) {
    mesh_auricle_left_18Geometry.scale(0.4, 0.31, 0.24);
  }
  const mesh_auricle_left_18 = new THREE.Mesh(
    mesh_auricle_left_18Geometry,
    materialMap["atrium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_auricle_left_18.name = "\u5de6\u5fc3\u8033";
  if (endpoint_auricle_left_18) {
    mesh_auricle_left_18.position.copy(endpoint_auricle_left_18.midpoint);
    mesh_auricle_left_18.quaternion.copy(endpoint_auricle_left_18.quaternion);
  }
  mesh_auricle_left_18.castShadow = options.castShadow ?? true;
  mesh_auricle_left_18.receiveShadow = options.receiveShadow ?? true;
  mesh_auricle_left_18.userData.sculptComponent = {"id": "auricle-left", "name": "左心耳", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}}, "parent": "la", "attachment": null, "dimensions": {"width": 0.4, "height": 0.31, "depth": 0.24, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.42, 0.47, 0.25], "rotation": [0, 0, 0], "scale": [0.4, 0.31, 0.24]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "auricle-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "atrium"}}, "material": "atrium", "materialLayers": ["atrium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 78, 83, 1)", "secondaryAlbedo": "rgba(169, 78, 83, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_auricle_left_18.add(mesh_auricle_left_18);
  meshes["auricle-left"] = mesh_auricle_left_18;
  colliders["auricle-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["auricle-left"] ??= [];
  destructionGroups["auricle-left"].push(node_auricle_left_18);

  const attachment_lad_19 = {"parentSocket": "lad-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]};
  const endpoint_lad_19 = makeAttachmentEndpoint(attachment_lad_19);
  const node_lad_19 = new THREE.Group();
  node_lad_19.name = "\u5de6\u524d\u964d\u652f__pivot";
  node_lad_19.scale.set(1, 1, 1);
  if (endpoint_lad_19) {
    node_lad_19.position.copy(endpoint_lad_19.start);
    node_lad_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lad_19.position.set(0.0, 0.0, 0.0);
    node_lad_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_lad_19.userData.sculptComponent = {"id": "lad", "name": "左前降支", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "lad", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "lv", "attachment": {"parentSocket": "lad-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lad", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "coronary-taper", "description": "LAD follows anterior interventricular groove", "type": "linework"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_lad_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lad", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["lv"] ?? root).add(node_lad_19);
  nodes["lad"] = node_lad_19;
  const mesh_lad_19Geometry = endpoint_lad_19
    ? new THREE.CylinderGeometry(endpoint_lad_19.endRadius, endpoint_lad_19.baseRadius, endpoint_lad_19.length, 32, 12)
    : buildTubeGeometry({"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10});
  if (!endpoint_lad_19) {
    mesh_lad_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lad_19 = new THREE.Mesh(
    mesh_lad_19Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lad_19.name = "\u5de6\u524d\u964d\u652f";
  if (endpoint_lad_19) {
    mesh_lad_19.position.copy(endpoint_lad_19.midpoint);
    mesh_lad_19.quaternion.copy(endpoint_lad_19.quaternion);
  }
  mesh_lad_19.castShadow = options.castShadow ?? true;
  mesh_lad_19.receiveShadow = options.receiveShadow ?? true;
  mesh_lad_19.userData.sculptComponent = {"id": "lad", "name": "左前降支", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "lad", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "lv", "attachment": {"parentSocket": "lad-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lad", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "coronary-taper", "description": "LAD follows anterior interventricular groove", "type": "linework"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_lad_19.add(mesh_lad_19);
  meshes["lad"] = mesh_lad_19;
  colliders["lad"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["lad"] ??= [];
  destructionGroups["lad"].push(node_lad_19);

  const attachment_rca_20 = {"parentSocket": "rca-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]};
  const endpoint_rca_20 = makeAttachmentEndpoint(attachment_rca_20);
  const node_rca_20 = new THREE.Group();
  node_rca_20.name = "\u53f3\u51a0\u72b6\u52a8\u8109__pivot";
  node_rca_20.scale.set(1, 1, 1);
  if (endpoint_rca_20) {
    node_rca_20.position.copy(endpoint_rca_20.start);
    node_rca_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rca_20.position.set(0.0, 0.0, 0.0);
    node_rca_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_rca_20.userData.sculptComponent = {"id": "rca", "name": "右冠状动脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "rca", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "rv", "attachment": {"parentSocket": "rca-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rca", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "av-groove", "description": "RCA traverses right atrioventricular groove", "type": "linework"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_rca_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rca", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["rv"] ?? root).add(node_rca_20);
  nodes["rca"] = node_rca_20;
  const mesh_rca_20Geometry = endpoint_rca_20
    ? new THREE.CylinderGeometry(endpoint_rca_20.endRadius, endpoint_rca_20.baseRadius, endpoint_rca_20.length, 32, 12)
    : buildTubeGeometry({"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10});
  if (!endpoint_rca_20) {
    mesh_rca_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rca_20 = new THREE.Mesh(
    mesh_rca_20Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rca_20.name = "\u53f3\u51a0\u72b6\u52a8\u8109";
  if (endpoint_rca_20) {
    mesh_rca_20.position.copy(endpoint_rca_20.midpoint);
    mesh_rca_20.quaternion.copy(endpoint_rca_20.quaternion);
  }
  mesh_rca_20.castShadow = options.castShadow ?? true;
  mesh_rca_20.receiveShadow = options.receiveShadow ?? true;
  mesh_rca_20.userData.sculptComponent = {"id": "rca", "name": "右冠状动脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "rca", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "rv", "attachment": {"parentSocket": "rca-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rca", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "av-groove", "description": "RCA traverses right atrioventricular groove", "type": "linework"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_rca_20.add(mesh_rca_20);
  meshes["rca"] = mesh_rca_20;
  colliders["rca"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["rca"] ??= [];
  destructionGroups["rca"].push(node_rca_20);

  const attachment_lcx_21 = {"parentSocket": "lcx-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]};
  const endpoint_lcx_21 = makeAttachmentEndpoint(attachment_lcx_21);
  const node_lcx_21 = new THREE.Group();
  node_lcx_21.name = "\u56de\u65cb\u652f__pivot";
  node_lcx_21.scale.set(1, 1, 1);
  if (endpoint_lcx_21) {
    node_lcx_21.position.copy(endpoint_lcx_21.start);
    node_lcx_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lcx_21.position.set(0.0, 0.0, 0.0);
    node_lcx_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_lcx_21.userData.sculptComponent = {"id": "lcx", "name": "回旋支", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "lcx", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "lv", "attachment": {"parentSocket": "lcx-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lcx", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "posterior-wrap", "description": "LCx wraps toward posterior left AV groove", "type": "linework"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_lcx_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lcx", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["lv"] ?? root).add(node_lcx_21);
  nodes["lcx"] = node_lcx_21;
  const mesh_lcx_21Geometry = endpoint_lcx_21
    ? new THREE.CylinderGeometry(endpoint_lcx_21.endRadius, endpoint_lcx_21.baseRadius, endpoint_lcx_21.length, 32, 12)
    : buildTubeGeometry({"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10});
  if (!endpoint_lcx_21) {
    mesh_lcx_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lcx_21 = new THREE.Mesh(
    mesh_lcx_21Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lcx_21.name = "\u56de\u65cb\u652f";
  if (endpoint_lcx_21) {
    mesh_lcx_21.position.copy(endpoint_lcx_21.midpoint);
    mesh_lcx_21.quaternion.copy(endpoint_lcx_21.quaternion);
  }
  mesh_lcx_21.castShadow = options.castShadow ?? true;
  mesh_lcx_21.receiveShadow = options.receiveShadow ?? true;
  mesh_lcx_21.userData.sculptComponent = {"id": "lcx", "name": "回旋支", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "lcx", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "lv", "attachment": {"parentSocket": "lcx-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lcx", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "posterior-wrap", "description": "LCx wraps toward posterior left AV groove", "type": "linework"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_lcx_21.add(mesh_lcx_21);
  meshes["lcx"] = mesh_lcx_21;
  colliders["lcx"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["lcx"] ??= [];
  destructionGroups["lcx"].push(node_lcx_21);

  const attachment_great_vein_22 = {"parentSocket": "great-vein-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]};
  const endpoint_great_vein_22 = makeAttachmentEndpoint(attachment_great_vein_22);
  const node_great_vein_22 = new THREE.Group();
  node_great_vein_22.name = "\u5fc3\u5927\u9759\u8109__pivot";
  node_great_vein_22.scale.set(1, 1, 1);
  if (endpoint_great_vein_22) {
    node_great_vein_22.position.copy(endpoint_great_vein_22.start);
    node_great_vein_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_great_vein_22.position.set(0.0, 0.0, 0.0);
    node_great_vein_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_great_vein_22.userData.sculptComponent = {"id": "great-vein", "name": "心大静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "great-vein", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "lv", "attachment": {"parentSocket": "great-vein-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "great-vein", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "parallel-vein", "description": "Great cardiac vein accompanies anterior groove", "type": "linework"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_great_vein_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "great-vein", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}};
  (nodes["lv"] ?? root).add(node_great_vein_22);
  nodes["great-vein"] = node_great_vein_22;
  const mesh_great_vein_22Geometry = endpoint_great_vein_22
    ? new THREE.CylinderGeometry(endpoint_great_vein_22.endRadius, endpoint_great_vein_22.baseRadius, endpoint_great_vein_22.length, 32, 12)
    : buildTubeGeometry({"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10});
  if (!endpoint_great_vein_22) {
    mesh_great_vein_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_great_vein_22 = new THREE.Mesh(
    mesh_great_vein_22Geometry,
    materialMap["vein"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_great_vein_22.name = "\u5fc3\u5927\u9759\u8109";
  if (endpoint_great_vein_22) {
    mesh_great_vein_22.position.copy(endpoint_great_vein_22.midpoint);
    mesh_great_vein_22.quaternion.copy(endpoint_great_vein_22.quaternion);
  }
  mesh_great_vein_22.castShadow = options.castShadow ?? true;
  mesh_great_vein_22.receiveShadow = options.receiveShadow ?? true;
  mesh_great_vein_22.userData.sculptComponent = {"id": "great-vein", "name": "心大静脉", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "great-vein", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "lv", "attachment": {"parentSocket": "great-vein-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "great-vein", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "parallel-vein", "description": "Great cardiac vein accompanies anterior groove", "type": "linework"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_great_vein_22.add(mesh_great_vein_22);
  meshes["great-vein"] = mesh_great_vein_22;
  colliders["great-vein"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["great-vein"] ??= [];
  destructionGroups["great-vein"].push(node_great_vein_22);

  const attachment_coronary_sinus_23 = {"parentSocket": "coronary-sinus-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]};
  const endpoint_coronary_sinus_23 = makeAttachmentEndpoint(attachment_coronary_sinus_23);
  const node_coronary_sinus_23 = new THREE.Group();
  node_coronary_sinus_23.name = "\u51a0\u72b6\u7aa6__pivot";
  node_coronary_sinus_23.scale.set(1, 1, 1);
  if (endpoint_coronary_sinus_23) {
    node_coronary_sinus_23.position.copy(endpoint_coronary_sinus_23.start);
    node_coronary_sinus_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coronary_sinus_23.position.set(0.0, 0.0, 0.0);
    node_coronary_sinus_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_coronary_sinus_23.userData.sculptComponent = {"id": "coronary-sinus", "name": "冠状窦", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "coronary-sinus", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "lv", "attachment": {"parentSocket": "coronary-sinus-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coronary-sinus", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_coronary_sinus_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coronary-sinus", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}};
  (nodes["lv"] ?? root).add(node_coronary_sinus_23);
  nodes["coronary-sinus"] = node_coronary_sinus_23;
  const mesh_coronary_sinus_23Geometry = endpoint_coronary_sinus_23
    ? new THREE.CylinderGeometry(endpoint_coronary_sinus_23.endRadius, endpoint_coronary_sinus_23.baseRadius, endpoint_coronary_sinus_23.length, 32, 12)
    : buildTubeGeometry({"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10});
  if (!endpoint_coronary_sinus_23) {
    mesh_coronary_sinus_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_coronary_sinus_23 = new THREE.Mesh(
    mesh_coronary_sinus_23Geometry,
    materialMap["vein"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coronary_sinus_23.name = "\u51a0\u72b6\u7aa6";
  if (endpoint_coronary_sinus_23) {
    mesh_coronary_sinus_23.position.copy(endpoint_coronary_sinus_23.midpoint);
    mesh_coronary_sinus_23.quaternion.copy(endpoint_coronary_sinus_23.quaternion);
  }
  mesh_coronary_sinus_23.castShadow = options.castShadow ?? true;
  mesh_coronary_sinus_23.receiveShadow = options.receiveShadow ?? true;
  mesh_coronary_sinus_23.userData.sculptComponent = {"id": "coronary-sinus", "name": "冠状窦", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "coronary-sinus", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "lv", "attachment": {"parentSocket": "coronary-sinus-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coronary-sinus", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "vein"}}, "material": "vein", "materialLayers": ["vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 109, 158, 1)", "secondaryAlbedo": "rgba(69, 109, 158, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_coronary_sinus_23.add(mesh_coronary_sinus_23);
  meshes["coronary-sinus"] = mesh_coronary_sinus_23;
  colliders["coronary-sinus"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["coronary-sinus"] ??= [];
  destructionGroups["coronary-sinus"].push(node_coronary_sinus_23);

  const attachment_posterior_artery_24 = {"parentSocket": "posterior-artery-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]};
  const endpoint_posterior_artery_24 = makeAttachmentEndpoint(attachment_posterior_artery_24);
  const node_posterior_artery_24 = new THREE.Group();
  node_posterior_artery_24.name = "\u540e\u5ba4\u95f4\u652f__pivot";
  node_posterior_artery_24.scale.set(1, 1, 1);
  if (endpoint_posterior_artery_24) {
    node_posterior_artery_24.position.copy(endpoint_posterior_artery_24.start);
    node_posterior_artery_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_posterior_artery_24.position.set(0.0, 0.0, 0.0);
    node_posterior_artery_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_posterior_artery_24.userData.sculptComponent = {"id": "posterior-artery", "name": "后室间支", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "posterior-artery", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "lv", "attachment": {"parentSocket": "posterior-artery-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "posterior-artery", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_posterior_artery_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "posterior-artery", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}};
  (nodes["lv"] ?? root).add(node_posterior_artery_24);
  nodes["posterior-artery"] = node_posterior_artery_24;
  const mesh_posterior_artery_24Geometry = endpoint_posterior_artery_24
    ? new THREE.CylinderGeometry(endpoint_posterior_artery_24.endRadius, endpoint_posterior_artery_24.baseRadius, endpoint_posterior_artery_24.length, 32, 12)
    : buildTubeGeometry({"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10});
  if (!endpoint_posterior_artery_24) {
    mesh_posterior_artery_24Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_posterior_artery_24 = new THREE.Mesh(
    mesh_posterior_artery_24Geometry,
    materialMap["artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_posterior_artery_24.name = "\u540e\u5ba4\u95f4\u652f";
  if (endpoint_posterior_artery_24) {
    mesh_posterior_artery_24.position.copy(endpoint_posterior_artery_24.midpoint);
    mesh_posterior_artery_24.quaternion.copy(endpoint_posterior_artery_24.quaternion);
  }
  mesh_posterior_artery_24.castShadow = options.castShadow ?? true;
  mesh_posterior_artery_24.receiveShadow = options.receiveShadow ?? true;
  mesh_posterior_artery_24.userData.sculptComponent = {"id": "posterior-artery", "name": "后室间支", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Organic profile varies continuously through a curved sweep, not an assembled block.", "geometryDescriptor": {"topologyIntent": "Atlas-derived asymmetric organ surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "object-space procedural tissue bands", "normalStrategy": "area-weighted smooth vertex normals", "latheProfile": {"points": [[0, -0.5], [0.13, -0.43], [0.38, -0.18], [0.48, 0.13], [0.4, 0.38], [0.18, 0.5], [0, 0.5]], "segments": 48}, "tubePath": {"points": [[0.2, 0.3, 0.4], [0.22, -0.2, 0.52], [0.26, -0.7, 0.3]], "radius": 0.025, "radialSegments": 10}, "medicalSurfacePath": {"kind": "posterior-artery", "surface": "ventricular-shared-loft", "taper": [1, 0.25]}}, "parent": "lv", "attachment": {"parentSocket": "posterior-artery-surface-root", "localStart": [0.2, 0.3, 0.4], "localEnd": [0.26, -0.7, 0.3], "contactType": "surface-contact", "overlap": 0.012, "gapTolerance": 0.01, "baseRadius": 0.025, "endRadius": 0.009, "evidenceRefs": ["anterior-atlas", "posterior-atlas"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "posterior-artery", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "artery"}}, "material": "artery", "materialLayers": ["artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["anterior-atlas", "posterior-atlas"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(197, 55, 54, 1)", "secondaryAlbedo": "rgba(197, 55, 54, 1)", "materialClass": "skin", "materialClassConfidence": 0.7, "evidenceRefs": ["anterior-atlas"], "notes": "Atlas palette, authored tissue response; not physical reflectance measurement."}};
  node_posterior_artery_24.add(mesh_posterior_artery_24);
  meshes["posterior-artery"] = mesh_posterior_artery_24;
  colliders["posterior-artery"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["posterior-artery"] ??= [];
  destructionGroups["posterior-artery"].push(node_posterior_artery_24);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createAtlasCardiacModelLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Atlas Cardiac Model look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = ["Authored neutral studio key area light: patient-right superior anterior, 4800 K, soft broad source; illustration itself is not photometric evidence.", "Neutral fill on opposite side at half key intensity; subtle posterior rim separates venous blue from myocardium.", "ACES filmic tone mapping, exposure 1.05; pale background; contact shadow only on presentation pedestal, no invented baked tissue AO."];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createAtlasCardiacModelEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameAtlasCardiacModelCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createAtlasCardiacModelPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureAtlasCardiacModelRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createAtlasCardiacModelInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
